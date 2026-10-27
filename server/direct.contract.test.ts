import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ServerInstance } from "./index.ts";
import { DirectSigner } from "./direct-auth.ts";
import { DIRECT_PROTOCOL, DIRECT_TICKET_PREFIX } from "../shared/direct.ts";
import { contentSecurityPolicy } from "./static.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-direct-contract-"));
const page = "https://ovis.example.test";
const signer = new DirectSigner();
let app: ServerInstance;
const control = (method: string, body: unknown, authorized = true) => fetch(`http://127.0.0.1:${app.port}/api/direct/trust`, {
  method, headers: { "content-type": "application/json", ...(authorized ? { authorization: "Bearer fictional-bridge-secret" } : {}) }, body: JSON.stringify(body),
});
const credential = (kind: "ws" | "http", role: "interact" | "observe" = "interact") => signer.issue({ aud: "fictional-machine", sub: "fictional-device", origin: page, kind, role }).token;
const direct = (path: string, token: string, origin = page, init: RequestInit = {}) => fetch(`http://127.0.0.1:${app.directPort}${path}`, {
  ...init, headers: { origin, authorization: `Bearer ${token}`, ...Object.fromEntries(new Headers(init.headers)) },
});

beforeAll(async () => {
  app = createServer({ port: 0, hostname: "127.0.0.1", token: "fictional-bridge-secret", stateDir: root, machines: false,
    direct: { endpoints: {}, origins: [] }, directListener: { hostname: "127.0.0.1", port: 0 } });
  await app.statusReady;
  expect((await control("POST", signer.trust("fictional-machine", [page]))).status).toBe(204);
});
afterAll(() => { app?.stop(); rmSync(root, { recursive: true, force: true }); });

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
