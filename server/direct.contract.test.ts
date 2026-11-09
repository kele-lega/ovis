import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as herdr from "./herdr/client.ts";
import * as collector from "./collector.ts";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { createServer, type ServerInstance } from "./index.ts";
import { snapshotWithoutHiddenTokens } from "./herdr-sidebar.ts";
import type { AgentRowTokens } from "../shared/pane-tokens.ts";
import { DirectSigner } from "./direct-auth.ts";
import { DIRECT_PROTOCOL, DIRECT_TICKET_PREFIX } from "../shared/direct.ts";
import { contentSecurityPolicy } from "./static.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-direct-contract-"));
const page = "https://ovis.example.test";
const hide = (name: string): AgentRowTokens => ({ rows: [{ name, rules: [{ contains: "", hide: true }] }], by_agent: {} });
const fixtureSnapshot = { protocol: 22, version: "fixture", workspaces: [], tabs: [], layouts: [], panes: [{ pane_id: "fictional", terminal_id: "fictional-term", workspace_id: "w", tab_id: "t", cwd: root, agent_status: "idle", focused: false, revision: 0, agent: null, tokens: { secretA: "from-A", secretB: "from-B", shown: "safe" } }], agents: [] } as unknown as SessionSnapshot;
const signer = new DirectSigner();
let snapshotSpy: ReturnType<typeof spyOn>;
let processSpy: ReturnType<typeof spyOn>;
let collectorSpy: ReturnType<typeof spyOn>;
let app: ServerInstance;
const control = (method: string, body: unknown, authorized = true) => fetch(`http://127.0.0.1:${app.port}/api/direct/trust`, {
  method, headers: { "content-type": "application/json", ...(authorized ? { authorization: "Bearer fictional-bridge-secret" } : {}) }, body: JSON.stringify(body),
});
const credential = (kind: "ws" | "http", role: "interact" | "observe" = "interact") => signer.issue({ aud: "fictional-machine", sub: "fictional-device", origin: page, kind, role }).token;
const direct = (path: string, token: string, origin = page, init: RequestInit = {}) => fetch(`http://127.0.0.1:${app.directPort}${path}`, {
  ...init, headers: { origin, authorization: `Bearer ${token}`, ...Object.fromEntries(new Headers(init.headers)) },
});

beforeAll(async () => {
  snapshotSpy = spyOn(herdr, "sessionSnapshot").mockImplementation(async () => structuredClone(fixtureSnapshot));
  processSpy = spyOn(herdr, "paneProcessInfo").mockResolvedValue(undefined);
  collectorSpy = spyOn(collector, "startStatusCollector").mockReturnValue({ ready: Promise.resolve(), structureReady: Promise.resolve(), focusReady: Promise.resolve(), trackPane() {}, stop() {} });
  const configPath = join(root, "herdr.toml");
  writeFileSync(configPath, '[ui.sidebar.agents]\nrows = [[{ token = "$secretB", rules = [{ contains = "", hide = true }] }]]\n');
  app = createServer({ herdrConfigPath: configPath, bridgeOnly: true, sidecar: false, terminalAttach: false, tailscaleOwner: null, port: 0, hostname: "127.0.0.1", token: "fictional-bridge-secret", stateDir: root, machines: false,
    direct: { endpoints: {}, origins: [] }, directListener: { hostname: "127.0.0.1", port: 0 } });
  // This ingress contract uses a stood-in snapshot, never the user's daemon or event stream.
  expect((await control("POST", signer.trust("fictional-machine", [page]))).status).toBe(204);
});
afterAll(() => { app?.stop(); snapshotSpy?.mockRestore(); processSpy?.mockRestore(); collectorSpy?.mockRestore(); rmSync(root, { recursive: true, force: true }); });

describe("ticket-only direct ingress", () => {
  it("requires bridge credentials for trust and never grants normal cookie/loopback access", async () => {
    expect((await control("POST", signer.trust("other", [page]), false)).status).toBe(401);
    expect((await direct("/api/session", "fictional-bridge-secret")).status).toBe(401);
    expect((await direct("/api/devices", credential("http"))).status).toBe(404);
    expect((await direct("/api/direct/trust", credential("http"))).status).toBe(404);
  });

  it("allows the trusted CORS preflight and authenticates the HTTP request independently", async () => {
    const preflight = await fetch(`http://127.0.0.1:${app.directPort}/api/session`, { method: "OPTIONS", headers: {
      origin: page, "access-control-request-method": "GET", "access-control-request-headers": "authorization,x-request-id",
    } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(page);
    expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();
    const token = credential("http");
    const response = await direct("/api/session", token);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(page);
    expect((await response.json()).snapshot).toBeDefined();
    expect((await direct("/api/session", token, "https://untrusted.example.test")).status).toBe(401);
    expect((await direct("/api/session", token)).status).toBe(200);
  });

  it("intersects A and B snapshot policies over HTTP and WS even on a bridge-only core", async () => {
    const redactor = new DirectSigner();
    const fields = { aud: "redacted-machine", sub: "redacted-device", origin: page, role: "interact" as const };
    expect((await control("POST", redactor.trust(fields.aud, [page], Date.now(), hide("secretA")))).status).toBe(204);
    const http = redactor.issue({ ...fields, kind: "http" }).token;
    const expected = snapshotWithoutHiddenTokens(hide("secretA"), snapshotWithoutHiddenTokens(hide("secretB"), fixtureSnapshot));
    const response = await direct("/api/session", http);
    expect(response.status).toBe(200);
    expect((await response.json()).snapshot).toMatchObject(expected);
    const raw = await fetch(`http://127.0.0.1:${app.port}/api/session`, { headers: { authorization: "Bearer fictional-bridge-secret" } });
    expect((await raw.json()).snapshot).toMatchObject(fixtureSnapshot);
    const RuntimeSocket = WebSocket as unknown as new (url: string, options: { protocols: string[]; headers: Record<string, string> }) => WebSocket;
    const ticket = redactor.issue({ ...fields, kind: "ws" }).token;
    const ws = new RuntimeSocket(`ws://127.0.0.1:${app.directPort}/ws`, { protocols: [DIRECT_PROTOCOL, `${DIRECT_TICKET_PREFIX}${ticket}`], headers: { origin: page } });
    const closed = new Promise<number>((resolve) => ws.addEventListener("close", (event) => resolve(event.code)));
    try {
      const snapshot = await new Promise<SessionSnapshot>((resolve, reject) => {
        ws.addEventListener("error", () => reject(new Error("direct WebSocket failed")));
        ws.addEventListener("message", (event) => { const frame = JSON.parse(String(event.data)); if (frame.type === "snapshot") resolve(frame.snapshot); });
      });
      expect(snapshot).toMatchObject(expected);
      expect(snapshot.panes[0]!.tokens).toEqual({ shown: "safe" });
      expect((await control("POST", redactor.trust(fields.aud, [page], Date.now(), hide("shown")))).status).toBe(204);
      expect(await closed).toBe(1008);
      const changed = await direct("/api/session", http);
      expect((await changed.json()).snapshot.panes[0].tokens).toEqual({ secretA: "from-A" });
      expect((await control("DELETE", { issuer: redactor.issuer })).status).toBe(204);
      expect((await direct("/api/session", http)).status).toBe(401);
    } finally { ws.close(); }
  });

  it("permits authenticated direct CORS file reads without weakening ordinary cross-site reads", async () => {
    const path = join(root, "cors-file.txt");
    writeFileSync(path, "fictional file");
    const headers = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" };
    const response = await direct(`/api/fs/stat?path=${encodeURIComponent(path)}`, credential("http"), page, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(page);
    const ordinary = await fetch(`http://127.0.0.1:${app.port}/api/fs/stat?path=${encodeURIComponent(path)}`, { headers: { ...headers, authorization: "Bearer fictional-bridge-secret" } });
    expect(ordinary.status).toBe(403);
  });

  it("permits signed cross-site diff reads without weakening bridge, cookie or watch restrictions", async () => {
    const repo = join(root, "cors-repo"); mkdirSync(repo);
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], {
        cwd: repo, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      });
      expect(result.exitCode).toBe(0);
    };
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "tracked.txt"), "before\n"); git("add", "tracked.txt"); git("commit", "-qm", "Fixture");
    writeFileSync(join(repo, "tracked.txt"), "after\n");
    const headers = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" };
    const token = credential("http");
    for (const route of ["files", "file", "refs"]) {
      const path = `/api/workspace/diff/${route}?directory=${encodeURIComponent(repo)}&path=tracked.txt`;
      const response = await direct(path, token, page, { headers });
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(page);
      expect((await direct(path, credential("http", "observe"), page, { headers })).status).toBe(403);
      expect((await direct(path, token, "https://untrusted.example.test", { headers })).status).toBe(401);
      for (const [name, value] of Object.entries({ authorization: "Bearer fictional-bridge-secret", cookie: "ovis_token=fictional-bridge-secret" })) {
        const ordinary = await fetch(`http://127.0.0.1:${app.port}${path}`, { headers: { ...headers, [name]: value } });
        expect(ordinary.status).toBe(403);
      }
    }
  });

  it("keeps observing credentials read-only on HTTP and WebSocket, and revokes live connections", async () => {
    expect((await direct("/api/pane/input", credential("http", "observe"), page, { method: "POST", body: "{}" })).status).toBe(403);
    expect((await direct("/api/fs/stat?path=/fictional", credential("http", "observe"))).status).toBe(403);
    const ticket = credential("ws", "observe");
    const RuntimeSocket = WebSocket as unknown as new (url: string, options: { protocols: string[]; headers: Record<string, string> }) => WebSocket;
    const socket = new RuntimeSocket(`ws://127.0.0.1:${app.directPort}/ws`, { protocols: [DIRECT_PROTOCOL, `${DIRECT_TICKET_PREFIX}${ticket}`], headers: { origin: page } });
    const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
    try {
      const role = new Promise<string>((resolve, reject) => {
        socket.addEventListener("error", () => reject(new Error("direct WebSocket failed")));
        socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "role", mode: "interact" })));
        socket.addEventListener("message", (event) => { const message = JSON.parse(String(event.data)); if (message.type === "role-ack") resolve(message.mode); });
      });
      expect(await role).toBe("observe");
      expect(socket.protocol).toBe(DIRECT_PROTOCOL);
      expect((await direct("/api/session", ticket)).status).toBe(401);
      expect((await control("PATCH", { issuer: signer.issuer, subject: "fictional-device" })).status).toBe(204);
      expect(await closed).toBe(1008);
      expect((await direct("/api/session", credential("http"))).status).toBe(401);
    } finally { socket.close(); }
  });

  it("limits CSP connection additions to configured origins", () => {
    const policy = contentSecurityPolicy(page, ["https://192.168.1.20:7443"]);
    expect(policy).toContain("connect-src 'self' https://192.168.1.20:7443 wss://192.168.1.20:7443");
    expect(policy).toContain("script-src 'self'");
    expect(() => contentSecurityPolicy(page, ["https://host.test/; script-src *"])).toThrow();
  });
});
