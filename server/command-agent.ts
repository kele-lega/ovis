/** Observes a command Herdr already created atomically. Never starts or sends input. */
import type { SessionSnapshot } from "../shared/protocol.ts";
import { freeAgentName } from "./agent-name.ts";
import { agentRename, HerdrError, paneProcessInfo, sessionSnapshot, type ProcessInfo } from "./herdr/client.ts";
import { omoProcessIdentity } from "./omo.ts";
import { isShellAgentKind, SHELL_AGENTS } from "./shell-agent.ts";

type LaunchSnapshot = Pick<SessionSnapshot, "panes" | "agents">;
export interface CommandAgentDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  snapshot?: (timeoutMs: number) => Promise<LaunchSnapshot>;
  processInfo?: (paneId: string) => Promise<ProcessInfo | undefined>;
  rename?: (paneId: string, name: string) => Promise<unknown>;
}
const positivePid = (pid: unknown): pid is number => typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
const notDetected = (): HerdrError => new HerdrError("agent_not_detected", "the expected agent was not detected in the new pane within 60 seconds; the pane was kept and the command was not retried");

/** Detection, PID binding and best-effort naming share a maximum 60 second observation window. */
export async function observeCommandAgent(kind: string, paneId: string,
  options: { name?: string; timeoutMs?: number } = {}, deps: CommandAgentDeps = {}): Promise<number | null> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? Bun.sleep;
  const snapshot = deps.snapshot ?? ((timeoutMs: number) => sessionSnapshot(undefined, timeoutMs));
  const processInfo = deps.processInfo ?? paneProcessInfo;
  const rename = deps.rename ?? agentRename;
  const deadline = now() + Math.max(0, Math.min(60_000, options.timeoutMs ?? 60_000));
  let active = true;
  const bounded = async <T>(read: () => Promise<T>): Promise<T> => {
    const remaining = deadline - now();
    if (!active || remaining <= 0) throw notDetected();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(notDetected()), remaining); })]);
      if (!active || now() >= deadline) throw notDetected();
      return result;
    } finally { clearTimeout(timer); }
  };
  try {
    let pid: number | null = null;
    for (;;) {
      const state = await bounded(() => snapshot(deadline - now()));
      const pane = state.panes.find((entry) => entry.pane_id === paneId);
      if (!pane) throw new HerdrError("pane_not_found", "the new pane is no longer available; the command was not retried");
      if (isShellAgentKind(kind)) {
        const info = await bounded(() => processInfo(paneId));
        const processes = info?.pane_id === paneId ? info.foreground_processes ?? [] : [];
        const started = processes.find((entry) => positivePid(entry.pid) && (kind === "omo"
          ? omoProcessIdentity({ pid: entry.pid, argv: entry.argv ?? undefined, cwd: entry.cwd ?? undefined }, "", process.env["HOME"] ?? "") !== null
          : SHELL_AGENTS[kind]!(entry.argv ?? [])));
        if (started) { pid = started.pid; break; }
      } else if (pane.agent === kind) {
        try {
          const info = await bounded(() => processInfo(paneId));
          const processes = info?.pane_id === paneId ? info.foreground_processes?.filter((entry) => positivePid(entry.pid)) ?? [] : [];
          // A single foreground process is bound even when exec kept the initial PTY process PID.
          if (processes.length === 1) pid = processes[0]!.pid;
        } catch { /* detection already succeeded; PID lookup is best effort */ }
        break;
      }
      await bounded(() => sleep(Math.min(250, deadline - now())));
    }
    const given = options.name && options.name.length > 0 ? options.name : null;
    for (let attempt = 0; attempt < 3 && active && now() < deadline; attempt += 1) {
      try {
        const state = await bounded(() => snapshot(deadline - now()));
        const own = state.agents.find((entry) => entry.pane_id === paneId);
        const name = given ?? freeAgentName(kind, state.agents.filter((entry) => entry.pane_id !== paneId).map((entry) => entry.name));
        if (own?.name !== name) await bounded(() => rename(paneId, name));
        break;
      } catch (error) {
        if (given !== null || !(error instanceof HerdrError) || error.code !== "agent_name_taken") break;
      }
    }
    return pid;
  } catch (error) {
    if (error instanceof HerdrError && error.code === "agent_not_detected") throw notDetected();
    if (error instanceof HerdrError && error.code === "pane_not_found") throw new HerdrError("pane_not_found", "the new pane is no longer available; the command was not retried");
    throw new HerdrError("agent_start_failed", "the custom agent could not be observed; the pane was kept and the command was not retried");
  } finally { active = false; }
}
