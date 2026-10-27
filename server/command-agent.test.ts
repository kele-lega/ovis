import { describe, expect, it } from "bun:test";
import type { AgentInfo, HerdrPane } from "../shared/protocol.ts";
import { agentFault } from "./agent-launch.ts";
import { startCommandAgent, type CommandAgentDeps } from "./command-agent.ts";
import { HerdrError, type ProcessInfo } from "./herdr/client.ts";

const target = "w1:p2";
const other = "w2:p1";
const pane = (paneId: string, kind?: string): HerdrPane => ({
  pane_id: paneId, workspace_id: "w1", tab_id: "w1:t1", terminal_id: paneId, revision: 1, focused: paneId === other,
  agent_status: "unknown", ...(kind ? { agent: kind } : {}),
});
const agent = (paneId: string, kind: string, name: string): AgentInfo => ({ ...pane(paneId, kind), name });
const shell = (): ProcessInfo => ({
  pane_id: target, shell_pid: 10, foreground_process_group_id: 10,
  foreground_processes: [{ pid: 10, name: "bash", argv0: "/bin/bash", argv: ["/bin/bash", "--noprofile", "--norc"] }],
});
const running = (pid = 42): ProcessInfo => ({
  pane_id: target, shell_pid: 10, foreground_process_group_id: pid,
  foreground_processes: [{ pid, name: "claude", argv: ["/bin/claude"] }],
});

function fixture() {
  let clock = 0;
  let sent = false;
  const texts: { paneId: string; text: string }[] = [];
  const renamed: { paneId: string; name: string }[] = [];
  const processReads: string[] = [];
  const sleeps: number[] = [];
  const deps: CommandAgentDeps = {
    platform: "linux", now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    snapshot: async () => ({ panes: [pane(target, sent ? "claude" : undefined), pane(other, "codex")], agents: [] }),
    processInfo: async (paneId) => { processReads.push(paneId); return sent ? running() : shell(); },
    sendText: async (paneId, text, allowed) => { expect(allowed()).toBeTrue(); texts.push({ paneId, text }); sent = true; },
    rename: async (paneId, name) => { renamed.push({ paneId, name }); },
  };
  return { deps, texts, renamed, processReads, sleeps, sent: () => sent, clock: () => clock, advance: (ms: number) => { clock += ms; } };
}

async function failure(work: Promise<unknown>): Promise<HerdrError> {
  try { await work; } catch (error) { expect(error).toBeInstanceOf(HerdrError); return error as HerdrError; }
  throw new Error("launch unexpectedly succeeded");
}

describe("custom command payload validation", () => {
  it("uses shared command rules, permits args OR command, and keeps standard launch validation", () => {
    expect(agentFault(undefined)).toBeNull();
    expect(agentFault({ kind: "claude", args: ["--model", "opus"] })).toBeNull();
    expect(agentFault({ kind: "claude", args: ["--model", "two words"] })).toContain("--model");
    expect(agentFault({ kind: "muse", command: "wrapper" }, "linux")).toContain("supported agent kind");
    expect(agentFault({ kind: "muse", args: [] })).toBeNull();
    expect(agentFault({ kind: "claude", command: "  wrapper --model 'two words'  " }, "linux")).toBeNull();
    for (const args of [[], ["--model", "opus"], null, "--help"]) {
      expect(agentFault({ kind: "claude", command: "wrapper", args })).toContain("mutually exclusive");
    }
    for (const command of [null, false, [], "", " ", "a\nb", "a\rb", "a\tb", "a\u001bb", "x".repeat(2001), `a${String.fromCodePoint(0x2028)}b`, `a${String.fromCodePoint(0x2029)}b`]) {
      expect(agentFault({ kind: "claude", command }, "linux")).not.toBeNull();
    }
    expect(agentFault(null as unknown as Parameters<typeof agentFault>[0])).toBe("agent.kind is required");
  });

  it("refuses Windows in validation before a create route makes anything, but leaves standard launches alone", async () => {
    expect(agentFault({ kind: "claude", command: "wrapper" }, "win32")).toContain("not supported on Windows");
    expect(agentFault({ kind: "claude", args: [] }, "win32")).toBeNull();
    const f = fixture();
    f.deps.platform = "win32";
    f.deps.snapshot = async () => { throw new Error("no RPC permitted"); };
    const error = await failure(startCommandAgent("claude", target, "secret-command", {}, f.deps));
    expect(error.code).toBe("platform_unsupported");
    expect(f.processReads).toEqual([]);
    expect(f.texts).toEqual([]);
  });
});

describe("a custom command launch", () => {
  it("sends exactly the original text plus one LF to the selected pane, with no args or defaults", async () => {
    const f = fixture();
    const command = "  ENV='a b' wrapper --model 'custom model' && echo '世界'  ";
    expect(await startCommandAgent("claude", target, command, {}, f.deps)).toBe(42);
    expect(f.texts).toEqual([{ paneId: target, text: `${command}\n` }]);
    expect(f.processReads).toEqual([target, target]);
    expect(f.renamed).toEqual([{ paneId: target, name: "claude" }]);
  });

  it("waits for the exact pane's foreground shell, not an empty process list or a different focused pane", async () => {
    const f = fixture();
    const pending: (ProcessInfo | undefined)[] = [undefined, { ...shell(), foreground_processes: [] }, { ...shell(), pane_id: other }, running(), shell()];
    f.deps.processInfo = async (paneId) => {
      expect(paneId).toBe(target);
      return f.sent() ? running() : pending.shift();
    };
    expect(await startCommandAgent("claude", target, "wrapper", {}, f.deps)).toBe(42);
    expect(pending).toEqual([]);
    expect(f.sleeps).toEqual([100, 100, 100, 100]);
    expect(f.texts).toEqual([{ paneId: target, text: "wrapper\n" }]);
  });

  it.each([
    ["foreground non-shell with its original shell PID", { ...shell(), foreground_processes: [{ pid: 10, name: "vim", argv: ["vim"] }] }],
    ["contradictory shell argv", { ...shell(), foreground_processes: [{ pid: 10, name: "bash", argv: ["vim"] }] }],
    ["no foreground group", { ...shell(), foreground_process_group_id: undefined }],
    ["other foreground group", { ...shell(), foreground_process_group_id: 42 }],
    ["a process beside the shell", { ...shell(), foreground_processes: [...shell().foreground_processes!, { pid: 11, name: "cat" }] }],
    ["no executable identity", { ...shell(), foreground_processes: [{ pid: 10, name: "" }] }],
    ["invalid shell PID", { ...shell(), shell_pid: 0 }],
  ] as const)("never types into %s", async (_name, info) => {
    const f = fixture();
    f.deps.processInfo = async () => info as ProcessInfo;
    const error = await failure(startCommandAgent("claude", target, "secret-command", { timeoutMs: 500 }, f.deps));
    expect(error.code).toBe("agent_pane_busy");
    expect(f.texts).toEqual([]);
    expect(f.renamed).toEqual([]);
    expect(f.clock()).toBe(500);
  });

  it("refuses an occupied or missing snapshot target even when process_info would look like a shell", async () => {
    for (const state of [
      { panes: [pane(target, "codex")], agents: [] },
      { panes: [pane(target)], agents: [agent(target, "codex", "occupied")] },
      { panes: [pane(other)], agents: [] },
    ]) {
      const f = fixture();
      f.deps.snapshot = async () => state;
      const error = await failure(startCommandAgent("claude", target, "wrapper", { timeoutMs: 500 }, f.deps));
      expect(["agent_pane_busy", "pane_not_found"]).toContain(error.code);
      expect(f.processReads).toEqual([]);
      expect(f.texts).toEqual([]);
    }
  });

  it("tolerates temporary wrong kinds and only accepts the expected kind in this pane", async () => {
    const f = fixture();
    const detected = ["codex", undefined, "claude"];
    f.deps.snapshot = async () => ({ panes: [pane(target, f.sent() ? detected.shift() ?? (detected.length === 0 ? "claude" : undefined) : undefined), pane(other, "claude")], agents: [] });
    expect(await startCommandAgent("claude", target, "wrapper", {}, f.deps)).toBe(42);
    expect(f.sleeps).toEqual([250, 250]);
    expect(f.texts).toHaveLength(1);
  });

  it.each([undefined, "codex"])("times out at 60 seconds for kind %s, preserving the pane without retry", async (kind) => {
    const f = fixture();
    f.deps.snapshot = async () => ({ panes: [pane(target, f.sent() ? kind : undefined), pane(other, "claude")], agents: [] });
    const error = await failure(startCommandAgent("claude", target, "secret-command", {}, f.deps));
    expect(error.code).toBe("agent_not_detected");
    expect(error.message).not.toContain("secret-command");
    expect(f.clock()).toBe(60_000);
    expect(f.texts).toEqual([{ paneId: target, text: "secret-command\n" }]);
    expect(f.renamed).toEqual([]);
  });

  it("counts shell startup against the same 60 second launch bound", async () => {
    const f = fixture();
    f.deps.processInfo = async () => f.clock() < 9000 ? undefined : shell();
    f.deps.snapshot = async () => ({ panes: [pane(target)], agents: [] });
    expect((await failure(startCommandAgent("claude", target, "wrapper", {}, f.deps))).code).toBe("agent_not_detected");
    expect(f.clock()).toBe(60_000);
    expect(f.texts).toHaveLength(1);
  });

  it("returns no PID for unavailable, ambiguous or wrong-pane process information after detection", async () => {
    for (const info of [undefined, { ...running(), pane_id: other }, { ...running(), foreground_processes: [...running().foreground_processes!, { pid: 43, name: "node" }] }]) {
      const f = fixture();
      f.deps.processInfo = async () => f.sent() ? info : shell();
      expect(await startCommandAgent("claude", target, "wrapper", {}, f.deps)).toBeNull();
      expect(f.texts).toHaveLength(1);
    }
  });

  it.each(["omo", "gjc"])("detects %s by its existing process identity after the one guarded exact-text send", async (kind) => {
    const f = fixture();
    const command = "  wrapper --native='a b'  ";
    f.deps.processInfo = async () => f.sent() ? {
      ...running(314), foreground_processes: [{ pid: 314, name: "node", argv: ["node", `/fixture/${kind}`] }],
    } : shell();
    // Raw herdr snapshots do not consistently know these kinds (OmO is often pi/claude).
    expect(await startCommandAgent(kind, target, command, {}, f.deps)).toBe(314);
    expect(f.texts).toEqual([{ paneId: target, text: `${command}\n` }]);
    expect(f.renamed).toEqual([{ paneId: target, name: kind }]);
  });

  it("does not send a shell agent command at all when the shell gate fails", async () => {
    const f = fixture();
    f.deps.processInfo = async () => running();
    const error = await failure(startCommandAgent("omo", target, "wrapper", { timeoutMs: 500 }, f.deps));
    expect(error.code).toBe("agent_pane_busy");
    expect(f.texts).toEqual([]);
  });

  it("ignores wrong-pane or nonmatching shell-agent process evidence until the deadline", async () => {
    for (const info of [running(), { ...running(314), pane_id: other, foreground_processes: [{ pid: 314, name: "gjc", argv: ["gjc"] }] }]) {
      const f = fixture();
      f.deps.processInfo = async () => f.sent() ? info : shell();
      const error = await failure(startCommandAgent("gjc", target, "secret-command", { timeoutMs: 500 }, f.deps));
      expect(error.code).toBe("agent_not_detected");
      expect(error.message).not.toContain("secret-command");
      expect(f.texts).toHaveLength(1);
    }
  });

  it("does not leak errors that echo input or retry an unacknowledged send", async () => {
    const f = fixture();
    let sends = 0;
    f.deps.sendText = async (_paneId, text) => { sends += 1; throw new HerdrError("bad_input", `refused ${text}`); };
    const error = await failure(startCommandAgent("claude", target, "secret-command", {}, f.deps));
    expect([error.code, error.message.includes("secret-command"), sends]).toEqual(["agent_start_failed", false, 1]);
    expect(f.renamed).toEqual([]);
  });

  it("ends a stalled read at the deadline, before any input", async () => {
    const f = fixture();
    f.deps.snapshot = () => new Promise(() => {});
    const error = await failure(startCommandAgent("claude", target, "secret-command", { timeoutMs: 20 }, f.deps));
    expect(error.code).toBe("agent_pane_busy");
    expect(f.texts).toEqual([]);
  });

  it("guards a send still connecting when its deadline expires", async () => {
    const f = fixture();
    let guard: (() => boolean) | undefined;
    let release: (() => void) | undefined;
    f.deps.sendText = async (_paneId, _text, allowed) => { guard = allowed; await new Promise<void>((resolve) => { release = resolve; }); if (allowed()) throw new Error("late input allowed"); };
    const error = await failure(startCommandAgent("claude", target, "secret-command", { timeoutMs: 20 }, f.deps));
    expect(error.code).toBe("agent_not_detected");
    expect(guard?.()).toBeFalse();
    release?.();
    expect(f.texts).toEqual([]);
  });
});

describe("custom agent naming", () => {
  it("picks freeAgentName and refreshes collisions without sending the command again", async () => {
    const f = fixture();
    let attempts = 0;
    f.deps.snapshot = async () => ({ panes: [pane(target, f.sent() ? "claude" : undefined)], agents: [
      agent(other, "claude", "claude"), ...(attempts > 0 ? [agent("w2:p2", "claude", "claude-2")] : []),
    ] });
    f.deps.rename = async (paneId, name) => {
      f.renamed.push({ paneId, name });
      attempts += 1;
      if (attempts === 1) throw new HerdrError("agent_name_taken", "collision");
    };
    expect(await startCommandAgent("claude", target, "wrapper", {}, f.deps)).toBe(42);
    expect(f.renamed).toEqual([{ paneId: target, name: "claude-2" }, { paneId: target, name: "claude-3" }]);
    expect(f.texts).toHaveLength(1);
  });

  it("does not count its own current name as taken or rename it unnecessarily", async () => {
    const f = fixture();
    f.deps.snapshot = async () => ({ panes: [pane(target, f.sent() ? "claude" : undefined)], agents: f.sent() ? [agent(target, "claude", "claude")] : [] });
    expect(await startCommandAgent("claude", target, "wrapper", {}, f.deps)).toBe(42);
    expect(f.renamed).toEqual([]);
  });

  it("keeps successful detection even if naming fails or every name collides", async () => {
    for (const code of ["agent_name_taken", "agent_not_found", "invalid_agent_name"]) {
      const f = fixture();
      let attempts = 0;
      f.deps.rename = async () => { attempts += 1; throw new HerdrError(code, "secret-command"); };
      expect(await startCommandAgent("claude", target, "secret-command", {}, f.deps)).toBe(42);
      expect(attempts).toBe(code === "agent_name_taken" ? 3 : 1);
      expect(f.texts).toHaveLength(1);
    }
  });

  it("uses an explicitly supplied name best-effort without picking a replacement on collision", async () => {
    const f = fixture();
    f.deps.rename = async (paneId, name) => { f.renamed.push({ paneId, name }); throw new HerdrError("agent_name_taken", "collision"); };
    expect(await startCommandAgent("claude", target, "wrapper", { name: "my-agent" }, f.deps)).toBe(42);
    expect(f.renamed).toEqual([{ paneId: target, name: "my-agent" }]);
    expect(f.texts).toHaveLength(1);
  });
});
