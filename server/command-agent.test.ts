import { describe, expect, it } from "bun:test";
import type { AgentInfo, HerdrPane } from "../shared/protocol.ts";
import { agentFault } from "./agent-launch.ts";
import { observeCommandAgent, type CommandAgentDeps } from "./command-agent.ts";
import { HerdrError, type ProcessInfo } from "./herdr/client.ts";

const target = "w1:p2", other = "w2:p1";
const pane = (paneId: string, kind?: string): HerdrPane => ({
  pane_id: paneId, workspace_id: "w1", tab_id: "w1:t1", terminal_id: paneId, revision: 1, focused: false,
  agent_status: "unknown", ...(kind ? { agent: kind } : {}),
});
const agent = (paneId: string, kind: string, name: string): AgentInfo => ({ ...pane(paneId, kind), name });
const running = (pid = 42): ProcessInfo => ({
  pane_id: target, shell_pid: 10, foreground_process_group_id: pid,
  foreground_processes: [{ pid, name: "claude", argv: ["/bin/claude"] }],
});
function fixture() {
  let clock = 0;
  const renamed: { paneId: string; name: string }[] = [], processReads: string[] = [], sleeps: number[] = [];
  const deps: CommandAgentDeps = {
    now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    snapshot: async () => ({ panes: [pane(target, "claude"), pane(other, "codex")], agents: [] }),
    processInfo: async (paneId) => { processReads.push(paneId); return running(); },
    rename: async (paneId, name) => { renamed.push({ paneId, name }); },
  };
  return { deps, renamed, processReads, sleeps, clock: () => clock };
}
async function failure(work: Promise<unknown>): Promise<HerdrError> {
  try { await work; } catch (error) { expect(error).toBeInstanceOf(HerdrError); return error as HerdrError; }
  throw new Error("observation unexpectedly succeeded");
}

describe("custom command payload validation", () => {
  it("keeps standard validation and requires a supported kind and one valid exact command", () => {
    expect(agentFault(undefined)).toBeNull();
    expect(agentFault({ kind: "claude", args: ["--model", "opus"] })).toBeNull();
    expect(agentFault({ kind: "claude", args: ["--model", "two words"] })).toContain("--model");
    expect(agentFault({ kind: "muse", command: "wrapper" }, "linux")).toContain("supported agent kind");
    expect(agentFault({ kind: "muse", args: [] })).toBeNull();
    expect(agentFault({ kind: "claude", command: "  wrapper --model 'two words'  " }, "linux")).toBeNull();
    for (const args of [[], ["--model", "opus"], null, "--help"]) expect(agentFault({ kind: "claude", command: "wrapper", args })).toContain("mutually exclusive");
    for (const command of [undefined, null, false, [], "", " ", "a\nb", "a\rb", "a\tb", "a\u001bb", "x".repeat(2001), `a${String.fromCodePoint(0x2028)}b`, `a${String.fromCodePoint(0x2029)}b`]) expect(agentFault({ kind: "claude", command }, "linux")).not.toBeNull();
    expect(agentFault(null as unknown as Parameters<typeof agentFault>[0])).toBe("agent.kind is required");
    expect(agentFault({ kind: "claude", command: "wrapper" }, "win32")).toContain("not supported on Windows");
    expect(agentFault({ kind: "claude", args: [] }, "win32")).toBeNull();
  });
});

describe("atomic command observation", () => {
  it("only observes the created pane, returns its PID and names it", async () => {
    const f = fixture();
    expect(await observeCommandAgent("claude", target, {}, f.deps)).toBe(42);
    expect(f.processReads).toEqual([target]);
    expect(f.renamed).toEqual([{ paneId: target, name: "claude" }]);
  });
  it("waits through temporary mismatches and ignores detection in another pane", async () => {
    const f = fixture(); let reads = 0;
    f.deps.snapshot = async () => ({ panes: [pane(target, reads++ < 2 ? "codex" : "claude"), pane(other, "claude")], agents: [] });
    expect(await observeCommandAgent("claude", target, {}, f.deps)).toBe(42);
    expect(f.sleeps).toEqual([250, 250]);
  });
  it.each([undefined, "codex"])("bounds kind %s detection to 60 seconds without changing the pane", async (kind) => {
    const f = fixture(); f.deps.snapshot = async () => ({ panes: [pane(target, kind), pane(other, "claude")], agents: [] });
    const error = await failure(observeCommandAgent("claude", target, { timeoutMs: 90_000 }, f.deps));
    expect(error.code).toBe("agent_not_detected"); expect(f.clock()).toBe(60_000); expect(f.renamed).toEqual([]);
  });
  it("does not bind an unavailable, ambiguous or wrong-pane PID", async () => {
    for (const info of [undefined, { ...running(), pane_id: other }, { ...running(), foreground_processes: [...running().foreground_processes!, { pid: 43, name: "node" }] }]) {
      const f = fixture(); f.deps.processInfo = async () => info;
      expect(await observeCommandAgent("claude", target, {}, f.deps)).toBeNull();
    }
  });
  it("binds exec keeping the initial process PID", async () => {
    const f = fixture(); f.deps.processInfo = async () => running(10);
    expect(await observeCommandAgent("claude", target, {}, f.deps)).toBe(10);
  });
  it.each(["omo", "gjc"])("observes %s by its existing process predicate", async (kind) => {
    const f = fixture(); f.deps.processInfo = async () => ({ ...running(314), foreground_processes: [{ pid: 314, name: "node", argv: ["node", `/fixture/${kind}`] }] });
    expect(await observeCommandAgent(kind, target, {}, f.deps)).toBe(314);
  });
  it("ignores wrong-pane process evidence for shell kinds", async () => {
    const f = fixture(); f.deps.processInfo = async () => ({ ...running(), pane_id: other, foreground_processes: [{ pid: 314, name: "gjc", argv: ["gjc"] }] });
    expect((await failure(observeCommandAgent("gjc", target, { timeoutMs: 500 }, f.deps))).code).toBe("agent_not_detected");
  });
  it("returns a safe error if the created pane vanishes or a read echoes secrets", async () => {
    for (const missing of [true, false]) {
      const f = fixture(); f.deps.snapshot = async () => { if (missing) return { panes: [pane(other)], agents: [] }; throw new HerdrError("bad_input", "secret-command"); };
      const error = await failure(observeCommandAgent("claude", target, {}, f.deps));
      expect(error.code).toBe(missing ? "pane_not_found" : "agent_start_failed"); expect(error.message).not.toContain("secret-command");
    }
  });
  it("ends stalled read-only RPC observation at its deadline", async () => {
    const f = fixture(); f.deps.snapshot = () => new Promise(() => {});
    expect((await failure(observeCommandAgent("claude", target, { timeoutMs: 20 }, f.deps))).code).toBe("agent_not_detected"); expect(f.renamed).toEqual([]);
  });
});

describe("custom agent naming", () => {
  it("refreshes free names on collisions", async () => {
    const f = fixture(); let attempts = 0;
    f.deps.snapshot = async () => ({ panes: [pane(target, "claude")], agents: [agent(other, "claude", "claude"), ...(attempts > 0 ? [agent("w2:p2", "claude", "claude-2")] : [])] });
    f.deps.rename = async (paneId, name) => { f.renamed.push({ paneId, name }); if (++attempts === 1) throw new HerdrError("agent_name_taken", "collision"); };
    expect(await observeCommandAgent("claude", target, {}, f.deps)).toBe(42);
    expect(f.renamed.map(({ name }) => name)).toEqual(["claude-2", "claude-3"]);
  });
  it("does not rename an already suitable own name", async () => {
    const f = fixture(); f.deps.snapshot = async () => ({ panes: [pane(target, "claude")], agents: [agent(target, "claude", "claude")] });
    expect(await observeCommandAgent("claude", target, {}, f.deps)).toBe(42); expect(f.renamed).toEqual([]);
  });
  it("retains detection on name failure and keeps an explicit name best effort", async () => {
    for (const code of ["agent_name_taken", "agent_not_found", "invalid_agent_name"]) {
      const f = fixture(); let attempts = 0; f.deps.rename = async () => { attempts++; throw new HerdrError(code, "secret-command"); };
      expect(await observeCommandAgent("claude", target, {}, f.deps)).toBe(42); expect(attempts).toBe(code === "agent_name_taken" ? 3 : 1);
    }
    const f = fixture(); f.deps.rename = async (paneId, name) => { f.renamed.push({ paneId, name }); throw new HerdrError("agent_name_taken", "collision"); };
    expect(await observeCommandAgent("claude", target, { name: "my-agent" }, f.deps)).toBe(42); expect(f.renamed).toEqual([{ paneId: target, name: "my-agent" }]);
  });
});
