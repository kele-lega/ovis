import { afterEach, describe, expect, it } from "bun:test";
import { BRIDGE_PROTOCOL, type Machine } from "../shared/machines.ts";
import { handleMachineRequest, slowMachinePath } from "./machine-api.ts";
import type { MachineManager } from "./machines.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });
const paths = ["workspace/create", "tab/create", "worktree/create", "worktree/open"];
const proof = () => ({ ok: true, bridge_protocol: BRIDGE_PROTOCOL, launch_command: true,
  herdr: { protocol: 22, capabilities: { atomic_command_launch: true } } });
const commandBody = () => ({ workspace_id: "fixture-source", branch: "fixture", agent: { kind: "claude", command: "  ENV='世界 a b' wrapper --model 'my model' && printf 'done'  " } });
function fixture(options: { kind?: Machine["kind"] | null; identity?: () => Response; create?: (request: Request) => Promise<Response> } = {}) {
  const requests: { path: string; body: string; authorization: string | null; cookie: string | null }[] = [];
  let retries = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = await request.text();
      requests.push({ path, body, authorization: request.headers.get("authorization"), cookie: request.headers.get("cookie") });
      if (path === "/api/bridge" || path === "/api/health") return options.identity?.() ?? Response.json(proof());
      return options.create?.(request) ?? Response.json({ workspace_id: "fixture-created", pane_id: "fixture-created:p1", agent_started: true });
    },
  });
  servers.push(server);
  const manager = {
    endpoint: () => ({ url: `http://127.0.0.1:${server.port}`, token: "fixture-bridge-token" }),
    list: () => [{ id: "fixture-pc", kind: options.kind === null ? undefined : options.kind ?? "ssh", enabled: true, state: "connected" }],
    trackTerminal: () => () => {},
    retryNow: () => { retries++; },
  } as unknown as MachineManager;
  const ask = (path: string, body: unknown = commandBody(), readOnly = false, headers: Record<string, string> = {}) => handleMachineRequest(new Request(`http://127.0.0.1/api/machines/fixture-pc/${path}`, {
    method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", origin: "http://127.0.0.1", "x-herdr-machine": "1", cookie: "ovis_token=fixture-browser-secret", ...headers },
  }), manager, undefined, undefined, readOnly);
  return { requests, ask, retries: () => retries };
}

describe("custom commands crossing the selected-PC proxy", () => {
  it("proves both implementations afresh before each of the four creates and forwards exact request bytes", async () => {
    const f = fixture();
    const original = ` { "agent": ${JSON.stringify(commandBody().agent)}, "workspace_id": "fixture-source", "branch": "fixture" } `;
    for (const path of paths) {
      expect((await f.ask(path, original)).status).toBe(200);
    }
    expect(f.requests.map((request) => request.path)).toEqual(paths.flatMap((path) => ["/api/bridge", `/api/${path}`]));
    expect(f.requests.filter((request) => request.path !== "/api/bridge").map((request) => request.body)).toEqual(paths.map(() => original));
    expect(f.requests.every((request) => request.authorization === "Bearer fixture-bridge-token" && request.cookie === null)).toBeTrue();
    expect(f.retries()).toBe(0);
  });

  it("does not mistake a paired relay's local forward token for a remote bridge credential", async () => {
    const f = fixture({ kind: "relay" });
    expect((await f.ask("workspace/create")).status).toBe(200);
    expect(f.requests.map((request) => request.path)).toEqual(["/api/health", "/api/workspace/create"]);
  });

  it("refuses herdr-core and unknown target kinds without forwarding a command", async () => {
    for (const kind of ["hc", null] as const) {
      const f = fixture({ kind });
      for (const path of paths) {
        const response = await f.ask(path);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: "command_launch_unsupported" } });
      }
      expect(f.requests).toEqual([]);
    }
  });

  it("does not forward if live support disappears, even after a previous supported launch", async () => {
    let live = true;
    const f = fixture({ identity: () => Response.json({ ...proof(), launch_command: live }) });
    expect((await f.ask("workspace/create")).status).toBe(200);
    live = false;
    const response = await f.ask("workspace/create");
    expect(response.status).toBe(409);
    expect(f.requests.map((request) => request.path)).toEqual(["/api/bridge", "/api/workspace/create", "/api/bridge"]);
  });

  it("refuses old bridges and malformed proofs without leaking their diagnostics or trying creation", async () => {
    const identities = [
      () => Response.json({ ...proof(), launch_command: undefined }),
      () => Response.json({ ...proof(), bridge_protocol: BRIDGE_PROTOCOL + 1 }),
      () => Response.json({ ...proof(), herdr: { protocol: 22, runtime: "herdr-core", capabilities: { atomic_command_launch: true } } }),
      () => new Response("fixture-private-proof", { status: 503 }),
      () => new Response("fixture-private-unparseable-proof"),
    ];
    for (const identity of identities) {
      const f = fixture({ identity });
      for (const path of paths) {
        const response = await f.ask(path);
        expect(response.status).toBe(409);
        expect(await response.text()).not.toContain("fixture-private");
      }
      expect(f.requests.map((request) => request.path)).toEqual(paths.map(() => "/api/bridge"));
      expect(f.retries()).toBe(0);
    }
  });

  it("validates custom payload syntax before contacting any selected PC", async () => {
    const f = fixture();
    for (const path of paths) {
      for (const command of [null, "", " ", "a\nb", "a\tb", "a\u001bb", `a${String.fromCharCode(0x2028)}b`, "x".repeat(2001)]) {
        const response = await f.ask(path, { ...commandBody(), agent: { kind: "claude", command } });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: "invalid_agent" } });
      }
      expect((await f.ask(path, { ...commandBody(), agent: { kind: "claude", command: "fixture", args: [] } })).status).toBe(400);
      expect((await f.ask(path, "{fixture-private-invalid-json")).status).toBe(400);
      expect((await f.ask(path, commandBody(), false, { "content-length": String(64 * 1024 * 1024 + 1) })).status).toBe(413);
    }
    expect(f.requests).toEqual([]);
  });

  it("preserves watch/origin restrictions before requesting even a capability proof", async () => {
    const f = fixture();
    for (const path of paths) {
      expect((await f.ask(path, commandBody(), true)).status).toBe(403);
      expect((await f.ask(path, commandBody(), false, { origin: "https://another.invalid" })).status).toBe(403);
    }
    expect(f.requests).toEqual([]);
  });

  it("does not retry an uncertain creation through any other route", async () => {
    const f = fixture({ create: async () => Response.json({ error: { code: "timeout", message: "uncertain create" } }, { status: 504 }) });
    expect((await f.ask("workspace/create")).status).toBe(504);
    expect(f.requests.map((request) => request.path)).toEqual(["/api/bridge", "/api/workspace/create"]);
    expect(f.retries()).toBe(0);
  });

  it("leaves normal agent launches unchanged, without requiring the new capability", async () => {
    const f = fixture({ identity: () => { throw new Error("ordinary create must not probe atomic support"); } });
    for (const path of paths) expect((await f.ask(path, { agent: { kind: "claude" } })).status).toBe(200);
    expect(f.requests.map((request) => request.path)).toEqual(paths.map((path) => `/api/${path}`));
  });

  it("uses the slow proxy deadline for opening custom-command worktrees without losing upstream slow paths", () => {
    for (const path of ["worktree/create", "worktree/open", "sessions/resume", "runtime/move/install"]) expect(slowMachinePath(path)).toBeTrue();
    expect(slowMachinePath("workspace/create")).toBeFalse();
  });
});
