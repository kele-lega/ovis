import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIRECT_PROTOCOL, DIRECT_TICKET_PREFIX, type DirectCredentialResponse } from "../shared/direct.ts";
import type { Access } from "./access.ts";
import { forgetAuthAttempts } from "./auth.ts";
import * as bridgeRegistration from "./bridge.ts";
import { DirectSigner } from "./direct-auth.ts";
import { directSubject } from "./direct-broker.ts";
import { DeviceStore } from "./devices.ts";
import { createServer, type ServerInstance } from "./index.ts";
import { MachineManager } from "./machines.ts";

const TOKEN = "fictional-direct-security-secret";
const PAGE = "https://ovis.example.test";
const MACHINE = "fictional-machine";
const roots: string[] = [];
const apps: ServerInstance[] = [];
const cleanups: (() => void)[] = [];
const root = () => {
  const path = mkdtempSync(join(tmpdir(), "ovis-direct-security-"));
  roots.push(path);
  return path;
};
const app = (options: Parameters<typeof createServer>[0] = {}) => {
  const instance = createServer({ port: 0, hostname: "127.0.0.1", stateDir: root(), token: TOKEN,
    tailscaleOwner: null, machines: false, registerBridge: false, sidecar: false, terminalAttach: false,
    direct: { endpoints: {}, origins: [] }, ...options });
  apps.push(instance);
  return instance;
};
afterEach(() => {
  for (const instance of apps.splice(0).reverse()) instance.stop();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
  forgetAuthAttempts();
});

describe("direct trust shared-token guessing budget", () => {
  const fixture = () => {
    forgetAuthAttempts();
    const clock = spyOn(Date, "now").mockReturnValue(Date.now());
    cleanups.push(() => clock.mockRestore());
    let bridgeToken = "";
    // Capture this isolated server's bridge credential without writing a real bridge registry.
    const registration = spyOn(bridgeRegistration, "registerBridge").mockImplementation((_port, token) => {
      bridgeToken = token!;
      return { token: token!, registered: false, close() {} };
    });
    cleanups.push(() => registration.mockRestore());
    const instance = app({ registerBridge: true, directListener: { hostname: "127.0.0.1", port: 0 } });
    const signer = new DirectSigner();
    const trust = (authorization?: string, cookie?: string, address = "100.64.0.51") => fetch(`http://127.0.0.1:${instance.port}/api/direct/trust`, {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": address,
        ...(authorization ? { authorization } : {}), ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(signer.trust(MACHINE, [PAGE])),
    });
    return { instance, trust, bridgeToken };
  };

  it("counts concurrent guesses before parsing trust bodies and shares the normal presented budget", async () => {
    const f = fixture();
    const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => f.trust(`Bearer wrong-${i}`)));
    expect(responses.filter((response) => response.status === 401)).toHaveLength(5);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(7);
    const held = await f.trust(`Bearer ${TOKEN}`);
    expect(held.status).toBe(429);
    expect(Number(held.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await fetch(`http://127.0.0.1:${f.instance.port}/api/preferences`, { headers: {
      authorization: `Bearer ${TOKEN}`, "x-forwarded-for": "100.64.0.51",
    } })).status).toBe(429);
    expect((await f.trust(`Bearer ${TOKEN}`, undefined, "100.64.0.52")).status).toBe(204);
    // The independent SSH bridge credential neither spends nor obeys the shared-token hold.
    expect((await f.trust(`Bearer ${f.bridgeToken}`)).status).toBe(204);
    expect((await f.trust(`Bearer ${TOKEN}`)).status).toBe(429);
  });

  it("never uses a cookie to delegate or to excuse wrong bearer guesses", async () => {
    const f = fixture();
    expect((await f.trust(undefined, `ovis_token=${TOKEN}`)).status).toBe(401);
    expect((await f.trust(undefined, `ovis_token=${f.bridgeToken}`)).status).toBe(401);
    for (let i = 0; i < 5; i++) expect((await f.trust(`Bearer wrong-${i}`, `ovis_token=${TOKEN}`)).status).toBe(401);
    expect((await f.trust(`Bearer ${TOKEN}`, `ovis_token=${TOKEN}`)).status).toBe(429);
    expect((await f.trust(`Bearer ${f.bridgeToken}`, `ovis_token=wrong`)).status).toBe(204);
  });

  it("applies a hold earned on normal routes before trust delegation but never charges bridge requests", async () => {
    const f = fixture();
    for (let i = 0; i < 8; i++) expect((await f.trust(`Bearer ${f.bridgeToken}`)).status).toBe(204);
    for (let i = 0; i < 5; i++) expect((await fetch(`http://127.0.0.1:${f.instance.port}/api/preferences`, { headers: {
      authorization: `Bearer wrong-${i}`, "x-forwarded-for": "100.64.0.51",
    } })).status).toBe(401);
    expect((await f.trust(`Bearer ${TOKEN}`)).status).toBe(429);
    expect((await f.trust(`Bearer ${f.bridgeToken}`)).status).toBe(204);
  });
});

function revocationFixture(options: { token?: string; tailscaleOwner?: string | null } = {}) {
  forgetAuthAttempts();
  const bridge = app({ directListener: { hostname: "127.0.0.1", port: 0 } });
  const patches: { body: { issuer: string; subject: string }; done: ReturnType<typeof Promise.withResolvers<void>> }[] = [];
  let hold: { started: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> } | undefined;
  const control = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const body = await request.text();
    if (request.method === "POST" && hold) {
      const pending = hold; hold = undefined;
      pending.started.resolve();
      await pending.release.promise;
    }
    const patch = request.method === "PATCH" ? patches.find((entry) => entry.body.subject === JSON.parse(body).subject && entry.body.issuer === "") : undefined;
    const response = await fetch(`http://127.0.0.1:${bridge.port}/api/direct/trust`, {
      method: request.method, headers: { authorization: request.headers.get("authorization")!, "content-type": "application/json" }, body,
    });
    if (patch) { patch.body = JSON.parse(body); patch.done.resolve(); }
    return response;
  } });
  cleanups.push(() => control.stop(true));
  const endpoint = { url: `http://127.0.0.1:${control.port}`, token: TOKEN };
  const endpointSpy = spyOn(MachineManager.prototype, "endpoint").mockImplementation((id) => id === MACHINE ? endpoint : undefined);
  cleanups.push(() => endpointSpy.mockRestore());
  const stateDir = root();
  const store = new DeviceStore(stateDir);
  const pairing = store.pair(store.startPairing().code, "Fictional paired watcher", "watch")!;
  store.match(pairing.token);
  const connection = app({ machines: true, stateDir, ...options, direct: {
    endpoints: { [MACHINE]: `http://127.0.0.1:${bridge.directPort}` }, origins: [PAGE],
  } });
  const request = (path: string, headers: Record<string, string>, method = "POST") => fetch(`http://127.0.0.1:${connection.port}${path}`, { method, headers: {
    host: "ovis.example.test", origin: PAGE, "x-forwarded-proto": "https", "x-forwarded-for": "100.64.0.61",
    "x-herdr-machine": "1", ...headers,
  } });
  const issue = async (headers: Record<string, string>) => {
    const response = await request(`/api/machines/${MACHINE}/direct-access`, headers);
    expect(response.status).toBe(200);
    return await response.json() as DirectCredentialResponse;
  };
  const claims = (credential: DirectCredentialResponse) => JSON.parse(Buffer.from(credential.access_token.split(".")[0]!, "base64url").toString()) as { sub: string };
  const expectPatch = (subject: string) => {
    const done = Promise.withResolvers<void>();
    patches.push({ body: { issuer: "", subject }, done });
    return done.promise;
  };
  const file = join(root(), "fictional-file.txt");
  writeFileSync(file, "Fictional direct HTTP fixture");
  const direct = (credential: DirectCredentialResponse) => fetch(`http://127.0.0.1:${bridge.directPort}/api/fs/stat?path=${encodeURIComponent(file)}`, {
    headers: { origin: PAGE, authorization: `Bearer ${credential.access_token}` },
  });
  const socket = async (credential: DirectCredentialResponse) => {
    const RuntimeSocket = WebSocket as unknown as new (url: string, options: { protocols: string[]; headers: Record<string, string> }) => WebSocket;
    const ws = new RuntimeSocket(`ws://127.0.0.1:${bridge.directPort}/ws`, { protocols: [DIRECT_PROTOCOL, `${DIRECT_TICKET_PREFIX}${credential.ticket}`], headers: { origin: PAGE } });
    cleanups.push(() => ws.close());
    const closed = new Promise<number>((resolve) => ws.addEventListener("close", (event) => resolve(event.code)));
    const opened = new Promise<void>((resolve, reject) => {
      ws.addEventListener("error", () => reject(new Error("direct WebSocket failed")));
      ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "ping", id: 1 })));
      ws.addEventListener("message", (event) => { if (JSON.parse(String(event.data)).type === "pong") resolve(); });
    });
    await opened;
    return { ws, closed };
  };
  return { connection, pairing, request, issue, claims, expectPatch, direct, socket, holdTrust() {
    const pending = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    hold = pending;
    cleanups.push(() => pending.release.resolve());
    return pending;
  } };
}

describe("stable authenticated direct revocation identities", () => {
  it("names only validated identities and conservatively shares one identity for the shared token", () => {
    const tokenAccess: Access = { level: "full", via: "token", role: "drive" };
    expect(directSubject(tokenAccess, TOKEN)).toBe(directSubject(tokenAccess, TOKEN));
    expect(directSubject(tokenAccess, TOKEN)).not.toBe(directSubject(tokenAccess, "another-token"));
    expect(directSubject(tokenAccess, TOKEN)).not.toContain(TOKEN);
    expect(directSubject({ level: "none", reason: "token_required" }, TOKEN)).toBeNull();
    expect(directSubject(tokenAccess, "")).toBeNull();
    expect(directSubject({ level: "full", via: "device", role: "watch", device: { id: "paired-id", label: "Device", role: "watch" } }, TOKEN)).toBe("device:paired-id");
    expect(directSubject({ level: "full", via: "tailscale", role: "drive", login: "Owner@Example.test" }, TOKEN))
      .toBe(directSubject({ level: "full", via: "tailscale", role: "drive", login: "owner@example.test" }, TOKEN));
    expect(directSubject({ level: "full", via: "local", role: "drive" }, TOKEN)).toBe("access:local");
  });

  it("revokes cookie and Bearer grants despite unrelated cookie changes, order, and credential transport", async () => {
    const f = revocationFixture();
    const cookie = await f.issue({ cookie: `theme=old; ovis_token=${TOKEN}; unrelated=1` });
    const bearer = await f.issue({ authorization: `Bearer ${TOKEN}`, cookie: "unrelated=2; theme=new" });
    expect(f.claims(cookie).sub).toBe(f.claims(bearer).sub);
    expect((await f.direct(cookie)).status).toBe(200);
    expect((await f.direct(bearer)).status).toBe(200);
    const live = await f.socket(cookie);
    const revoked = f.expectPatch(f.claims(cookie).sub);
    expect((await f.request("/api/auth", { cookie: `unrelated=changed; ovis_token=${TOKEN}; theme=new` }, "DELETE")).status).toBe(204);
    await revoked;
    expect(await live.closed).toBe(1008);
    expect((await f.direct(cookie)).status).toBe(401);
    expect((await f.direct(bearer)).status).toBe(401);
    const fresh = await f.issue({ cookie: `ovis_token=${TOKEN}; another=value` });
    expect(f.claims(fresh).sub).not.toBe(f.claims(cookie).sub);
    const revokedAgain = f.expectPatch(f.claims(fresh).sub);
    expect((await f.request("/api/auth", { authorization: `Bearer ${TOKEN}`, cookie: "unrelated=only" }, "DELETE")).status).toBe(204);
    await revokedAgain;
    expect((await f.direct(fresh)).status).toBe(401);
  });

  it("invalidates issuance still awaiting trust when logout presents the same token differently", async () => {
    const f = revocationFixture();
    const held = f.holdTrust();
    const issuing = f.request(`/api/machines/${MACHINE}/direct-access`, { cookie: `ovis_token=${TOKEN}; theme=old` });
    await held.started.promise;
    expect((await f.request("/api/auth", { authorization: `Bearer ${TOKEN}`, cookie: "theme=new" }, "DELETE")).status).toBe(204);
    held.release.resolve();
    expect((await issuing).status).toBe(503);
    const fresh = await f.issue({ authorization: `Bearer ${TOKEN}` });
    expect(f.claims(fresh).sub.endsWith(":1")).toBe(true);
    expect((await f.direct(fresh)).status).toBe(200);
  });

  it("keeps paired-device grants scoped while token upgrades take precedence and logout revokes both", async () => {
    const f = revocationFixture();
    const deviceCookie = `ovis_device=${f.pairing.token}`;
    const watching = await f.issue({ cookie: `${deviceCookie}; theme=old`, authorization: "Bearer unauthenticated-noise" });
    expect(f.claims(watching).sub).toBe(`device:${f.pairing.device.id}:0`);
    expect((await f.direct(watching)).status).toBe(403);
    const upgraded = await f.issue({ cookie: `theme=new; ${deviceCookie}`, authorization: `Bearer ${TOKEN}` });
    const tokenOnly = await f.issue({ authorization: `Bearer ${TOKEN}` });
    expect(f.claims(upgraded).sub).toBe(f.claims(tokenOnly).sub);
    expect((await f.direct(upgraded)).status).toBe(200);
    const watcher = await f.socket(watching);
    const driver = await f.socket(upgraded);
    const deviceRevoked = f.expectPatch(f.claims(watching).sub);
    const tokenRevoked = f.expectPatch(f.claims(upgraded).sub);
    expect((await f.request("/api/auth", { cookie: `extra=changed; ${deviceCookie}; ovis_token=${TOKEN}` }, "DELETE")).status).toBe(204);
    await Promise.all([deviceRevoked, tokenRevoked]);
    expect(await watcher.closed).toBe(1008);
    expect(await driver.closed).toBe(1008);
    expect((await f.direct(watching)).status).toBe(401);
    expect((await f.direct(upgraded)).status).toBe(401);
    expect((await f.direct(tokenOnly)).status).toBe(401);
  });

  it("revokes paired-only grants despite changed cookie order and unrelated invalid Bearer headers", async () => {
    const f = revocationFixture();
    const granted = await f.issue({ cookie: `theme=old; ovis_device=${f.pairing.token}`, authorization: "Bearer wrong-before" });
    const live = await f.socket(granted);
    const revoked = f.expectPatch(f.claims(granted).sub);
    expect((await f.request("/api/auth", { cookie: `ovis_device=${f.pairing.token}; unrelated=changed; theme=new`, authorization: "Bearer wrong-after" }, "DELETE")).status).toBe(204);
    await revoked;
    expect(await live.closed).toBe(1008);
    expect((await f.direct(granted)).status).toBe(401);
  });

  it("rejects device issuance held in flight when the paired device is revoked", async () => {
    const f = revocationFixture();
    const held = f.holdTrust();
    const issuing = f.request(`/api/machines/${MACHINE}/direct-access`, { cookie: `ovis_device=${f.pairing.token}` });
    await held.started.promise;
    expect((await f.request(`/api/devices/${f.pairing.device.id}`, { authorization: `Bearer ${TOKEN}` }, "DELETE")).status).toBe(204);
    held.release.resolve();
    expect((await issuing).status).toBe(503);
    expect((await f.request(`/api/machines/${MACHINE}/direct-access`, { cookie: `ovis_device=${f.pairing.token}` })).status).toBe(401);
  });

  it("revokes Serve grants using the verified login despite arbitrary cookies and invalid Bearer headers", async () => {
    const f = revocationFixture({ token: "", tailscaleOwner: "owner@example.test" });
    const granted = await f.issue({ "tailscale-user-login": "Owner@Example.test", cookie: "theme=old", authorization: "Bearer irrelevant-guess" });
    const revoked = f.expectPatch(f.claims(granted).sub);
    const live = await f.socket(granted);
    expect((await f.request("/api/auth", { "tailscale-user-login": "owner@example.test", cookie: "unrelated=changed; theme=new", authorization: "Bearer different-guess" }, "DELETE")).status).toBe(204);
    await revoked;
    expect(await live.closed).toBe(1008);
    expect((await f.direct(granted)).status).toBe(401);
  });
});
