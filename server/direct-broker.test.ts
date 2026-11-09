import { expect, it, spyOn } from "bun:test";
import { DirectAuthority } from "./direct-auth.ts";
import { DirectBroker, directConfig } from "./direct-broker.ts";
import type { MachineManager } from "./machines.ts";
import type { AgentRowTokens } from "../shared/pane-tokens.ts";
import type { SessionSnapshot } from "../shared/protocol.ts";

it("issues machine-scoped credentials over the authenticated control plane and revokes them on disconnect", async () => {
  const authority = new DirectAuthority();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (request.headers.get("authorization") !== "Bearer fictional-control-secret") return new Response(null, { status: 401 });
    const body = await request.json() as Record<string, string>;
    if (request.method === "POST") authority.register(body);
    else if (request.method === "PATCH") authority.revoke(body.issuer!, body.subject!);
    else if (request.method === "DELETE") authority.remove(body.issuer!);
    return new Response(null, { status: 204 });
  } });
  const endpoint = { url: `http://127.0.0.1:${server.port}`, token: "fictional-control-secret" };
  let disconnect = () => {};
  const manager = { list: () => [{ id: "machine-b", kind: "ssh", target: { destination: "fictional" } }], endpoint: () => endpoint, trackTerminal: (_id: string, close: () => void) => { disconnect = close; return () => {}; } } as unknown as MachineManager;
  const page = "https://ovis.example.test";
  const broker = new DirectBroker(manager, directConfig('{"machine-b":"https://192.168.1.20:7443"}', page));
  try {
    // Arbitrary logout identities must not consume the bounded grant identity table.
    for (let id = 0; id < 5000; id++) broker.revoke(`never-granted-${id}`);
    expect(await broker.issue("unknown", page, "device", false)).toBeNull();
    expect(await broker.issue("machine-b", "https://untrusted.example.test", "device", false)).toBeNull();
    const credential = (await broker.issue("machine-b", page, "device", true))!;
    expect(credential.origin).toBe("https://192.168.1.20:7443");
    const claims = authority.verify(credential.ticket, "ws", page)!;
    expect(claims).toMatchObject({ aud: "machine-b", sub: "device:0", role: "observe" });
    expect(authority.verify(credential.ticket, "ws", page)).toBeNull();
    expect(authority.verify(credential.access_token, "http", page)).not.toBeNull();
    const ended = new Promise<void>((resolve) => authority.onRevoke(claims, resolve));
    disconnect();
    await ended;
    expect(authority.verify(credential.access_token, "http", page)).toBeNull();
  } finally { broker.stop(); authority.stop(); server.stop(true); }
});

it("backdates trust and both credentials across independent bridge clocks without extending TTLs", async () => {
  const page = "https://ovis.example.test";
  let signerNow = 1_800_000_000_000;
  let bridgeNow = signerNow;
  let advanceDuringControl = 0;
  let trustExpiry = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => signerNow);
  const authority = new DirectAuthority(() => bridgeNow);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (request.headers.get("authorization") !== "Bearer fictional-control-secret") return new Response(null, { status: 401 });
    const body = await request.json() as Record<string, unknown>;
    try {
      if (request.method === "POST") {
        authority.register(body);
        trustExpiry = body.expires_at as number;
        signerNow += advanceDuringControl;
        bridgeNow += advanceDuringControl;
        advanceDuringControl = 0;
      } else if (request.method === "DELETE") authority.remove(body.issuer as string);
      return new Response(null, { status: 204 });
    } catch { return new Response(null, { status: 400 }); }
  } });
  const endpoint = { url: `http://127.0.0.1:${server.port}`, token: "fictional-control-secret" };
  const manager = { list: () => [{ id: "machine-b", kind: "ssh", target: { destination: "fictional" } }], endpoint: () => endpoint, trackTerminal: () => () => {} } as unknown as MachineManager;
  const broker = new DirectBroker(manager, directConfig('{"machine-b":"https://bridge.example.test:7443"}', page));
  try {
    for (const offset of [-250, -8, 0, 250]) {
      bridgeNow = signerNow + offset;
      const credential = (await broker.issue("machine-b", page, "device", false))!;
      expect(trustExpiry).toBe(signerNow + 85_000);
      expect(credential.expires_at).toBe(signerNow + 55_000);
      const ws = authority.verify(credential.ticket, "ws", page)!;
      const http = authority.verify(credential.access_token, "http", page)!;
      expect(ws).toMatchObject({ iat: signerNow - 5000, exp: signerNow + 25_000, role: "interact" });
      expect(http).toMatchObject({ iat: signerNow - 5000, exp: signerNow + 55_000 });
      expect(ws.exp - ws.iat).toBe(30_000);
      expect(http.exp - http.iat).toBe(60_000);
      expect(authority.verify(credential.ticket, "ws", page)).toBeNull();
      expect(authority.verify(credential.access_token, "http", "https://wrong.example.test")).toBeNull();
      bridgeNow = http.exp;
      expect(authority.verify(credential.access_token, "http", page)).toBeNull();
      signerNow += 70_000;
    }
    bridgeNow = signerNow - 250;
    advanceDuringControl = 2000;
    const afterControl = (await broker.issue("machine-b", page, "device", false))!;
    expect(authority.verify(afterControl.access_token, "http", page)?.iat).toBe(signerNow - 5000);
    expect(afterControl.expires_at).toBe(signerNow + 55_000);
    bridgeNow = signerNow - 5001;
    await expect(broker.issue("machine-b", page, "device", false)).rejects.toThrow("Direct bridge control unavailable");
    bridgeNow = signerNow + 85_000;
    await expect(broker.issue("machine-b", page, "device", false)).rejects.toThrow("Direct bridge control unavailable");
  } finally { broker.stop(); authority.stop(); server.stop(true); clock.mockRestore(); }
});

it("refuses relay, hc, local and incomplete SSH targets before reading their endpoint tokens", async () => {
  let machine: unknown;
  let endpoints = 0;
  const manager = { list: () => [machine], endpoint: () => { endpoints++; throw new Error("must not use adapter credentials"); } } as unknown as MachineManager;
  const page = "https://ovis.example.test";
  const broker = new DirectBroker(manager, { endpoints: { "machine-b": "https://bridge.example.test" }, origins: [page] });
  try {
    for (const kind of ["relay", "hc", "local", "ssh"]) {
      machine = { id: "machine-b", kind, ...(kind === "ssh" ? {} : { target: { destination: "not-ssh" } }) };
      expect(await broker.issue("machine-b", page, "device", false)).toBeNull();
    }
    expect(endpoints).toBe(0);
  } finally { broker.stop(); }
});

it("drops changed policy leases, regrants under the new policy, and fails closed on policy overflow", async () => {
  const authority = new DirectAuthority();
  const page = "https://ovis.example.test";
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const body = await request.json() as Record<string, unknown>;
    if (request.method === "POST") authority.register(body);
    if (request.method === "DELETE") authority.remove(body.issuer as string);
    return new Response(null, { status: 204 });
  } });
  const endpoint = { url: `http://127.0.0.1:${server.port}`, token: "fictional-secret" };
  const manager = { list: () => [{ id: "machine-b", kind: "ssh", target: {} }], endpoint: () => endpoint, trackTerminal: () => () => {} } as unknown as MachineManager;
  let policy: AgentRowTokens | null = null;
  let changed = () => {};
  let changeOnRead = false;
  const source = { get() { if (changeOnRead) { changeOnRead = false; changed(); } return policy; }, subscribe(listener: () => void) { changed = listener; return () => { changed = () => {}; }; } };
  const broker = new DirectBroker(manager, { endpoints: { "machine-b": "https://bridge.example.test" }, origins: [page] }, source);
  const snapshot = { panes: [{ pane_id: "p", tokens: { private: "secret", shown: "safe" } }], agents: [] } as unknown as SessionSnapshot;
  try {
    const first = (await broker.issue("machine-b", page, "device", false))!;
    const claims = authority.verify(first.ticket, "ws", page)!;
    const closed = new Promise<void>((resolve) => authority.onRevoke(claims, resolve));
    policy = { rows: [{ name: "private", rules: [{ contains: "", hide: true }] }], by_agent: {} };
    changed();
    await closed;
    expect(authority.verify(first.access_token, "http", page)).toBeNull();
    const next = (await broker.issue("machine-b", page, "device", false))!;
    const nextClaims = authority.verify(next.ticket, "ws", page)!;
    expect(authority.snapshot(nextClaims, snapshot).panes[0]!.tokens).toEqual({ shown: "safe" });
    changeOnRead = true;
    await expect(broker.issue("machine-b", page, "device", false)).rejects.toThrow("policy changed");
    policy = { rows: Array.from({ length: 513 }, () => ({ name: "private" })), by_agent: {} };
    changed();
    await expect(broker.issue("machine-b", page, "device", false)).rejects.toThrow("snapshot policy");
  } finally { broker.stop(); authority.stop(); server.stop(true); }
});

it("does not turn an SSH alias or arbitrary HTTP LAN URL into a browser endpoint", () => {
  expect(() => directConfig('{"machine-b":"http://192.168.1.20:7443"}', "https://ovis.example.test")).toThrow();
  expect(() => directConfig('{"machine-b":"https://192.168.1.20:7443"}')).toThrow();
});
