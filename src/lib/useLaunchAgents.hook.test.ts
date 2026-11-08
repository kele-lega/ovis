import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { AgentKind } from "../../shared/protocol.ts";
import { launchCommandUnsupported } from "./agentLaunchMode.ts";
import { useLaunchAgents } from "./useLaunchAgents.ts";

describe("creation catalog capabilities", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  let renderer: ReactTestRenderer;
  let seen: ReturnType<typeof useLaunchAgents>;
  type Fetch = Parameters<typeof useLaunchAgents>[1];
  type ProbeProps = { active: boolean; fetch: Fetch; commands: Record<string, string> };
  function Probe({ active, fetch, commands }: ProbeProps) { seen = useLaunchAgents(active, fetch, commands); return null; }
  function pending() {
    let answer: (agents: AgentKind[]) => void = () => {};
    let refuse: (error: Error) => void = () => {};
    let capabilities: Parameters<Fetch>[0];
    let configured: readonly string[] | undefined;
    const fetch: Fetch = (callback, kinds) => {
      capabilities = callback;
      configured = kinds;
      return new Promise<AgentKind[]>((resolve, reject) => { answer = resolve; refuse = reject; });
    };
    return { fetch, answer: (agents: AgentKind[]) => answer(agents), refuse: () => refuse(new Error("offline")), capabilities: (value: { launch_command?: boolean }) => capabilities?.(value), configured: () => configured };
  }
  beforeEach(() => { Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true }); });
  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    if (descriptor) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", descriptor);
    else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });
  const command = { codex: "wrapper" };
  const blocked = () => launchCommandUnsupported({ command: "wrapper" }, seen.capable);

  it("starts blocked, requires explicit true on a successful catalog read, and adds missing configured kinds", async () => {
    const read = pending();
    await act(async () => { renderer = create(createElement(Probe, { active: true, fetch: read.fetch, commands: command })); });
    expect(blocked()).toBeTrue();
    expect(seen.loaded).toBeFalse();
    expect(seen.agents).toEqual([{ kind: "codex", label: "codex" }]);
    expect(read.configured()).toEqual(["codex"]);
    read.capabilities({ launch_command: true });
    expect(blocked()).toBeTrue();
    await act(async () => { read.answer([{ kind: "claude", label: "Claude Code" }]); });
    expect(blocked()).toBeFalse();
    expect(seen.agents.map((agent) => agent.kind)).toEqual(["claude", "codex"]);
  });

  it("never trusts capability from an old PC when switching or receiving responses out of order", async () => {
    const a = pending();
    const b = pending();
    await act(async () => { renderer = create(createElement(Probe, { active: true, fetch: a.fetch, commands: command })); });
    a.capabilities({ launch_command: true });
    await act(async () => { renderer.update(createElement(Probe, { active: true, fetch: b.fetch, commands: command })); });
    expect(blocked()).toBeTrue();
    await act(async () => { a.answer([{ kind: "claude", label: "Old PC" }]); });
    expect(blocked()).toBeTrue();
    expect(seen.loaded).toBeFalse();
    b.capabilities({});
    await act(async () => { b.answer([{ kind: "codex", label: "Current PC" }]); });
    expect(seen.loaded).toBeTrue();
    expect(blocked()).toBeTrue();
    expect(seen.agents[0]?.label).toBe("Current PC");
  });

  it("revokes known support immediately when the API changes and ignores a failed/closed read", async () => {
    const a = pending();
    const b = pending();
    await act(async () => { renderer = create(createElement(Probe, { active: true, fetch: a.fetch, commands: command })); });
    a.capabilities({ launch_command: true });
    await act(async () => { a.answer([]); });
    expect(blocked()).toBeFalse();
    await act(async () => { renderer.update(createElement(Probe, { active: true, fetch: b.fetch, commands: command })); });
    expect(blocked()).toBeTrue();
    b.capabilities({ launch_command: true });
    await act(async () => { b.refuse(); });
    expect(blocked()).toBeTrue();
    expect(seen.agents[0]?.kind).toBe("codex");
    const c = pending();
    await act(async () => { renderer.update(createElement(Probe, { active: true, fetch: c.fetch, commands: command })); });
    await act(async () => { renderer.update(createElement(Probe, { active: false, fetch: c.fetch, commands: command })); });
    c.capabilities({ launch_command: true });
    await act(async () => { c.answer([]); });
    expect(blocked()).toBeTrue();
    expect(seen.loaded).toBeFalse();
  });

  it("rechecks availability when configured kinds change without rereading for every command edit", async () => {
    let count = 0;
    const fetch: Fetch = async (callback) => { count++; callback?.({ launch_command: true }); return []; };
    await act(async () => { renderer = create(createElement(Probe, { active: true, fetch, commands: command })); });
    await act(async () => { renderer.update(createElement(Probe, { active: true, fetch, commands: { codex: "other" } })); });
    expect(count).toBe(1);
    await act(async () => { renderer.update(createElement(Probe, { active: true, fetch, commands: { claude: "run" } })); });
    expect(count).toBe(2);
    expect(seen.agents.map((agent) => agent.kind)).toEqual(["claude"]);
  });
});
