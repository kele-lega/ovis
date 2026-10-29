import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PendingMessage, WorkspaceCreated } from "../shared/protocol.ts";
import { agentLaunch } from "./agent-launch.ts";
import { startCommandAgent } from "./command-agent.ts";
import { HerdrError, paneProcessInfo, paneSendText, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { handleWorkspaceRequest } from "./workspace-routes.ts";

const quote = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;
const timeout = { timeout: () => {} };
type Queue = Parameters<typeof handleWorkspaceRequest>[5];
const queueUnexpected: Queue = async (): Promise<PendingMessage> => { throw new Error("a failed launch must not queue a first message"); };
const moved = () => ({ order_epoch: "custom-launch-contract", moved_seq: 1 });
async function post(pathname: string, body: unknown, queue: Queue = queueUnexpected): Promise<Response> {
  const url = new URL(`http://127.0.0.1${pathname}`);
  return (await handleWorkspaceRequest(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), url, pathname, timeout, () => {}, queue, moved))!;
}

/** Owned fake agent: writes one start and argv, holds stdin, never loads an AI CLI or calls a model. */
function fakeAgent(root: string): { script: string; starts: string; argv: string; command: string } {
  const script = join(root, "gjc"), starts = join(root, "starts"), argv = join(root, "argv.json");
  writeFileSync(script, `import { appendFileSync, writeFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(starts)}, 'started\\n');\nwriteFileSync(${JSON.stringify(argv)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdin.resume();\n`, { mode: 0o600 });
  return { script, starts, argv, command: `  ${quote(process.execPath)} ${quote(script)} 'literal a b' '世界'  ` };
}

/** Process detection can precede Bun evaluating the fixture and writing its startup evidence. */
async function materialized(fixture: ReturnType<typeof fakeAgent>): Promise<{ starts: string; argv: unknown }> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const starts = readFileSync(fixture.starts, "utf8");
      const argv: unknown = JSON.parse(readFileSync(fixture.argv, "utf8"));
      if (starts.length > 0) return { starts, argv };
    } catch (error) {
      // writeFileSync can be observed between creation and its final bytes, not only before creation.
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("fixture startup evidence was not materialized");
    await Bun.sleep(Math.min(25, remaining));
  }
}

async function detected(paneId: string, kind: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await sessionSnapshot()).panes.some((pane) => pane.pane_id === paneId && pane.agent === kind)) {
    if (Date.now() >= deadline) throw new Error("fixture kind was not detected");
    await Bun.sleep(50);
  }
}

describe.skipIf(process.platform === "win32")("custom command launch contract", () => {
  it("rejects command+args and invalid single lines on every create route before a pane is made", async () => {
    const before = await sessionSnapshot();
    for (const path of ["/api/workspace/create", "/api/tab/create", "/api/worktree/create"]) {
      for (const command of [null, "", " ", "a\nb", "a\rb", "a\tb", "a\u001bb", "x".repeat(2001), `a${String.fromCodePoint(0x2028)}b`, `a${String.fromCodePoint(0x2029)}b`]) {
        const response = await post(path, { workspace_id: "not-created", branch: "not-created", agent: { kind: "claude", command } });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: "invalid_agent" } });
      }
      const response = await post(path, { workspace_id: "not-created", branch: "not-created", agent: { kind: "claude", command: "wrapper", args: [] } });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_agent", message: "agent.command and agent.args are mutually exclusive" } });
    }
    const after = await sessionSnapshot();
    expect(after.panes.map((pane) => pane.pane_id)).toEqual(before.panes.map((pane) => pane.pane_id));
    expect(after.workspaces.map((workspace) => workspace.workspace_id)).toEqual(before.workspaces.map((workspace) => workspace.workspace_id));
  });

  it("sends exact text once through the guarded pane path, returns its process PID and appends no defaults", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-command-exact-"));
    const owned = await workspaceCreate({ cwd: root, label: "ovis-test-command-exact" });
    const fixture = fakeAgent(root);
    const texts: { paneId: string; text: string }[] = [];
    try {
      const pid = await startCommandAgent("gjc", owned.root_pane.pane_id, fixture.command, {}, {
        sendText: async (paneId, text, allowed) => { texts.push({ paneId, text }); await paneSendText(paneId, text, undefined, allowed); },
      });
      expect(pid).toBeGreaterThan(0);
      expect(texts).toEqual([{ paneId: owned.root_pane.pane_id, text: `${fixture.command}\n` }]);
      const evidence = await materialized(fixture);
      expect(evidence.starts).toBe("started\n");
      expect(evidence.argv).toEqual(["literal a b", "世界"]);
      expect((await paneProcessInfo(owned.root_pane.pane_id))?.foreground_processes).toContainEqual(expect.objectContaining({ pid }));
    } finally { await workspaceClose(owned.workspace.workspace_id); rmSync(root, { recursive: true, force: true }); }
  }, 15_000);

  it("binds a create request's first message to the process the custom command brought up", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-command-create-"));
    const fixture = fakeAgent(root);
    let workspace: string | undefined;
    const queued: { paneId: string; text: string; kind: string; requester: string | null; pid: number | null }[] = [];
    try {
      const response = await post("/api/workspace/create", { cwd: root, agent: { kind: "gjc", command: fixture.command }, first_message: "never sent to a model", first_message_connection: "fixture-page" }, async (paneId, text, kind, requester, pid) => {
        queued.push({ paneId, text, kind, requester, pid });
        return { id: "first-message", request_id: 1, text, state: "queued", created_at: new Date().toISOString() };
      });
      expect(response.status).toBe(200);
      const created = await response.json() as WorkspaceCreated;
      workspace = created.workspace_id;
      expect(created).toMatchObject({ agent_started: true, first_message: { id: "first-message" } });
      expect(queued).toHaveLength(1);
      const info = await paneProcessInfo(created.pane_id);
      expect(queued[0]).toEqual({ paneId: created.pane_id, text: "never sent to a model", kind: "gjc", requester: "fixture-page", pid: info?.foreground_processes?.find((entry) => entry.argv?.includes(fixture.script))?.pid ?? null });
      expect(queued[0]!.pid).toBeGreaterThan(0);
      expect((await materialized(fixture)).starts).toBe("started\n");
    } finally { if (workspace) await workspaceClose(workspace); rmSync(root, { recursive: true, force: true }); }
  }, 15_000);

  it("tolerates temporary kind detection until the expected native kind appears and gives it a free live name", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-command-native-"));
    const owned = await workspaceCreate({ cwd: root, label: "ovis-test-command-native" });
    const script = join(root, "native-fixture.sh");
    // The manual report is a deterministic fixture for Herdr's detector; no real CLI runs.
    const herdr = process.env["OVIS_HERDR_BIN"] ?? Bun.which("herdr")!;
    writeFileSync(script, `#!/bin/bash\nprintf '%s\\n' 'Welcome to Claude Code!' '❯'\n${quote(herdr)} pane report-agent --help >/dev/null\nexec -a claude cat\n`, { mode: 0o700 });
    let sent = false;
    let reported = false;
    try {
      const pid = await startCommandAgent("claude", owned.root_pane.pane_id, `${quote("/bin/bash")} ${quote(script)}`, {}, {
        sendText: async (paneId, text, allowed) => { await paneSendText(paneId, text, undefined, allowed); sent = true; },
        snapshot: async (ms) => {
          const state = await sessionSnapshot(undefined, ms);
          if (sent && !reported) {
            // A temporary detector miss must not abort the launch. Subsequent polls read real state.
            reported = true;
            return { ...state, panes: state.panes.map((pane) => pane.pane_id === owned.root_pane.pane_id ? { ...pane, agent: "codex" } : pane) };
          }
          return state;
        },
      });
      expect(pid).toBeGreaterThan(0);
      expect(reported).toBeTrue();
      await detected(owned.root_pane.pane_id, "claude");
      expect((await sessionSnapshot()).agents.find((agent) => agent.pane_id === owned.root_pane.pane_id)?.name).toMatch(/^claude(?:-\d+)?$/);
    } finally { await workspaceClose(owned.workspace.workspace_id); rmSync(root, { recursive: true, force: true }); }
  }, 15_000);

  it("leaves a timed-out command in its original pane and never inputs into the other agent's pane", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-command-timeout-"));
    const owned = await workspaceCreate({ cwd: root, label: "ovis-test-command-timeout" });
    const fixture = fakeAgent(root);
    const texts: string[] = [];
    try {
      let error: unknown;
      try {
        await startCommandAgent("codex", owned.root_pane.pane_id, fixture.command, { timeoutMs: 1200 }, {
          sendText: async (paneId, text, allowed) => { texts.push(paneId); await paneSendText(paneId, text, undefined, allowed); },
        });
      } catch (failure) { error = failure; }
      expect(error).toBeInstanceOf(HerdrError);
      expect((error as HerdrError).code).toBe("agent_not_detected");
      expect((error as HerdrError).message).not.toContain(fixture.command);
      expect(texts).toEqual([owned.root_pane.pane_id]);
      expect((await materialized(fixture)).starts).toBe("started\n");
      expect((await sessionSnapshot()).panes.some((pane) => pane.pane_id === owned.root_pane.pane_id)).toBeTrue();
      expect((await paneProcessInfo(owned.root_pane.pane_id))?.foreground_processes?.some((entry) => entry.argv?.includes(fixture.script))).toBeTrue();
    } finally { await workspaceClose(owned.workspace.workspace_id); rmSync(root, { recursive: true, force: true }); }
  }, 10_000);

  it("keeps an already-running non-shell safe when someone tries to launch another command into it", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-command-busy-"));
    const owned = await workspaceCreate({ cwd: root, label: "ovis-test-command-busy" });
    const fixture = fakeAgent(root);
    try {
      expect((await agentLaunch(owned.root_pane.pane_id, { kind: "gjc", command: fixture.command })).agent_started).toBeTrue();
      let sends = 0;
      const error = await startCommandAgent("claude", owned.root_pane.pane_id, "DO_NOT_TYPE", { timeoutMs: 300 }, {
        sendText: async () => { sends += 1; throw new Error("unsafe input"); },
      }).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(HerdrError);
      expect((error as HerdrError).code).toBe("agent_pane_busy");
      expect(sends).toBe(0);
      expect((await materialized(fixture)).starts).toBe("started\n");
    } finally { await workspaceClose(owned.workspace.workspace_id); rmSync(root, { recursive: true, force: true }); }
  }, 15_000);
});
