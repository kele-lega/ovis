import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PendingMessage, WorkspaceCreated } from "../shared/protocol.ts";
import { firstMessageOutcome } from "../src/lib/newSession.ts";
import { atomicCommandLaunchSupported, ping, tabCreateWithCommand, workspaceCreateWithCommand, worktreeCreateWithCommand, worktreeOpenWithCommand } from "./herdr/client.ts";
import { bridgeIdentity } from "./bridge.ts";
import { handleWorkspaceRequest } from "./workspace-routes.ts";

/** Compile-time wrapper contracts: command cannot be optional or replaced by args. */
async function typeOnly(): Promise<void> {
  // @ts-expect-error atomic workspace creation requires a command
  await workspaceCreateWithCommand({});
  // @ts-expect-error atomic tab creation requires the selected workspace
  await tabCreateWithCommand({ command: "fixture" });
  // @ts-expect-error atomic worktree creation requires a branch
  await worktreeCreateWithCommand({ workspaceId: "source", command: "fixture" });
  // @ts-expect-error atomic worktree open requires a command
  await worktreeOpenWithCommand({ workspaceId: "source" });
  // @ts-expect-error custom creation has no agent args field
  await workspaceCreateWithCommand({ command: "fixture", args: [] });
}
void typeOnly;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const target = "new:p1";
const created = {
  workspace: { workspace_id: "new" }, tab: { tab_id: "new:t1", workspace_id: "new" },
  root_pane: { pane_id: target }, worktree: { path: "/fixture/checkout", branch: "fixture" }, already_open: false,
};
interface Rpc { id: string; method: string; params: Record<string, unknown> }
async function daemon(capability: unknown = true, processEvidence: "single" | "ambiguous" | "failed" = "single") {
  const dir = mkdtempSync(join(tmpdir(), "ovis-atomic-contract-")), path = join(dir, "herdr.sock");
  const calls: Rpc[] = [], open = new Set<Socket>();
  let failCreate: string | null = null, creates = 0;
  const server = createServer((socket) => {
    open.add(socket); socket.on("close", () => open.delete(socket)); socket.on("error", () => {});
    let data = "";
    socket.on("data", (bytes) => {
      data += bytes.toString(); if (!data.includes("\n")) return;
      const request = JSON.parse(data.slice(0, data.indexOf("\n"))) as Rpc; calls.push(request);
      const answer = (result: unknown) => socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
      switch (request.method) {
        case "ping": return answer({ version: "test", protocol: 1, capabilities: capability === undefined ? {} : { atomic_command_launch: capability } });
        case "session.snapshot": return answer({ snapshot: { panes: [{ pane_id: target, agent: "claude" }], agents: [] } });
        case "pane.process_info": {
          if (processEvidence === "failed") return socket.end(`${JSON.stringify({ id: request.id, error: { code: "process_info_failed", message: "private diagnostic" } })}\n`);
          const foreground = [{ pid: 42, name: "claude", argv: ["claude"] }, ...(processEvidence === "ambiguous" ? [{ pid: 41, name: "sh", argv: ["sh", "-c", "wrapper"] }] : [])];
          return answer({ process_info: { pane_id: target, shell_pid: 41, foreground_process_group_id: 41, foreground_processes: foreground } });
        }
        case "agent.rename": return answer({ agent: { pane_id: target, name: request.params["name"] } });
        case "worktree.list": return answer({ source: { source_workspace_id: "parent" }, worktrees: [] });
        default:
          if (request.method.includes("create") || request.method.includes("open")) {
            creates++;
            if (failCreate !== null) { const code = failCreate; failCreate = null; return socket.end(`${JSON.stringify({ id: request.id, error: { code, message: "secret-command remote diagnostic" } })}\n`); }
            return answer(created);
          }
          return socket.end(`${JSON.stringify({ id: request.id, error: { code: "unexpected_rpc", message: request.method } })}\n`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  const saved = process.env["HERDR_SOCKET"]; process.env["HERDR_SOCKET"] = path;
  cleanups.push(async () => { if (saved === undefined) delete process.env["HERDR_SOCKET"]; else process.env["HERDR_SOCKET"] = saved; for (const socket of open) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); });
  return { path, calls, creates: () => creates, fail: (code: string) => { failCreate = code; } };
}
type Queue = Parameters<typeof handleWorkspaceRequest>[5];
const unexpectedQueue: Queue = async () => { throw new Error("must not queue"); };
async function post(pathname: string, body: unknown, queue: Queue = unexpectedQueue) {
  const url = new URL(pathname, "http://127.0.0.1");
  return (await handleWorkspaceRequest(new Request(url, { method: "POST", body: JSON.stringify(body) }), url, pathname, { timeout() {} }, () => {}, queue, () => ({ order_epoch: "test", moved_seq: 1 })))!;
}
const paths = ["workspace/create", "tab/create", "worktree/create", "worktree/open"];
const payload = (command: unknown) => ({ workspace_id: "source", branch: "fixture", agent: { kind: "claude", command } });

describe.skipIf(process.platform === "win32")("atomic custom creation contract", () => {
  it("uses only the additive create RPC with exact whitespace, no send_text or agent.start", async () => {
    const f = await daemon(); const command = "  ENV='a b' wrapper --model 'custom model' && echo '世界'  ";
    for (const path of paths) {
      const before = f.calls.length;
      const response = await post(`/api/${path}`, payload(command));
      expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ workspace_id: "new", pane_id: target, agent_started: true });
      const calls = f.calls.slice(before), atomic = calls.filter((call) => call.method.endsWith("_with_command"));
      expect(atomic).toHaveLength(1); expect(atomic[0]!.method).toBe(`${path.replace("/", ".")}_with_command`);
      expect(atomic[0]!.params["command"]).toBe(command); expect(atomic[0]!.params["focus"]).toBeFalse(); expect(atomic[0]!.params).not.toHaveProperty("args");
      expect(calls[0]!.method).toBe("ping"); expect(calls.map((call) => call.method)).not.toContain("pane.send_text"); expect(calls.map((call) => call.method)).not.toContain("agent.start");
    }
    expect(f.creates()).toBe(4);
  });
  it("binds first-message queue to the observed command PID", async () => {
    await daemon(); const queued: unknown[][] = [];
    const response = await post("/api/workspace/create", { ...payload("fixture"), first_message: "user prompt", first_message_connection: "page" }, async (...args) => {
      queued.push(args); return { id: "queued", request_id: 1, text: "user prompt", state: "queued", created_at: new Date().toISOString() } satisfies PendingMessage;
    });
    expect(await response.json()).toMatchObject({ agent_started: true, first_message: { id: "queued" } });
    expect(queued).toEqual([[target, "user prompt", "claude", "page", 42]]);
  });
  it.each(["ambiguous", "failed"] as const)("retains a recoverable first-message draft instead of queueing with %s PID evidence", async (processEvidence) => {
    const f = await daemon(true, processEvidence);
    for (const path of ["workspace/create", "tab/create"]) {
      let queues = 0;
      const request = { ...payload("fixture"), first_message: "  user text to recover 世界  ", first_message_connection: "page" };
      const response = await post(`/api/${path}`, request, async () => { queues++; throw new Error("unsafe kind-only queue"); });
      expect(response.status).toBe(200);
      const result = await response.json() as WorkspaceCreated;
      expect(result).toMatchObject({ agent_started: true, first_message: { error: { code: "first_message_not_queued" } } });
      expect(queues).toBe(0);
      const outcome = firstMessageOutcome(request, result);
      expect(outcome).toMatchObject({ kind: "not_queued", error: { code: "first_message_not_queued" } });
      // This is the existing dialog draft branch: original request text remains available,
      // with no pending queue that could later deliver it to a same-kind replacement process.
      expect(outcome.kind === "not_queued" ? request.first_message : null).toBe("  user text to recover 世界  ");
    }
    expect(f.calls.some((call) => call.method === "pane.send_text" || call.method === "agent.start")).toBeFalse();
  });
  it("rejects absent, false and nonboolean capabilities before creating anything", async () => {
    for (const capability of [null, false, "true", 1]) {
      const f = await daemon(capability);
      for (const path of paths) {
        const response = await post(`/api/${path}`, payload("secret-command"));
        expect(response.ok).toBeFalse(); expect(await response.json()).toMatchObject({ error: { code: "command_launch_unsupported" } });
      }
      expect(f.creates()).toBe(0); expect(f.calls.every((call) => call.method === "ping")).toBeTrue();
    }
  });
  it("rejects invalid or conflicting commands before any RPC", async () => {
    const f = await daemon();
    for (const path of paths) {
      for (const command of [null, "", " ", "a\nb", "a\tb", "a\u001bb", "x".repeat(2001)]) expect((await post(`/api/${path}`, payload(command))).status).toBe(400);
      expect((await post(`/api/${path}`, { ...payload("wrapper"), agent: { kind: "claude", command: "wrapper", args: [] } })).status).toBe(400);
    }
    expect(f.calls).toEqual([]);
  });
  it("does not retry uncertain create failure or expose command diagnostics", async () => {
    const f = await daemon(); f.fail("timeout");
    const response = await post("/api/workspace/create", payload("secret-command"));
    expect(response.ok).toBeFalse(); expect(await response.text()).not.toContain("secret-command"); expect(f.creates()).toBe(1);
    expect(f.calls.map((call) => call.method)).toEqual(["ping", "workspace.create_with_command"]);
  });
  it("retries only explicit linked-worktree pre-create refusal against its source", async () => {
    const f = await daemon(); f.fail("linked_worktree_source");
    expect((await post("/api/worktree/create", payload("wrapper"))).ok).toBeTrue();
    expect(f.calls.filter((call) => call.method.endsWith("_with_command")).map((call) => call.params["workspace_id"])).toEqual(["source", "parent"]);
  });
  it("leaves ordinary no-agent create untouched and never requires the new daemon feature", async () => {
    const f = await daemon(false);
    expect((await post("/api/workspace/create", {})).ok).toBeTrue(); expect(f.calls.map((call) => call.method)).toEqual(["workspace.create"]);
  });
  it("preserves only boolean daemon support and advertises bridge support from live ping", async () => {
    const f = await daemon();
    expect((await ping(f.path)).capabilities).toEqual({ atomic_command_launch: true });
    expect((await bridgeIdentity(false)).launch_command).toBeTrue();
    expect(atomicCommandLaunchSupported({ capabilities: { atomic_command_launch: true } }, "win32")).toBeFalse();
    expect(atomicCommandLaunchSupported({}, "linux")).toBeFalse();
    const old = await daemon(false); expect((await bridgeIdentity(false)).launch_command).toBeFalse();
    expect((await ping(old.path)).capabilities).toEqual({ atomic_command_launch: false });
    const invalid = await daemon("true"); expect((await ping(invalid.path)).capabilities).toBeUndefined();
  });
  it("checks capability even for direct wrapper callers", async () => {
    const f = await daemon(false); await expect(workspaceCreateWithCommand({ command: "fixture" }, f.path)).rejects.toMatchObject({ code: "command_launch_unsupported" }); expect(f.creates()).toBe(0);
  });
});
