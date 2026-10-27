/**
 * A custom launch is shell input, not agent.start arguments. Only a new pane whose own shell
 * is in front may receive it, once. Detection and naming never send another command or prompt.
 */
import type { SessionSnapshot } from "../shared/protocol.ts";
import { launchCommandFault } from "../shared/launch-rules.ts";
import { freeAgentName } from "./agent-name.ts";
import { agentRename, HerdrError, paneProcessInfo, paneSendText, sessionSnapshot, type ProcessInfo } from "./herdr/client.ts";
import { omoProcessIdentity } from "./omo.ts";
import { isShellAgentKind, SHELL_AGENTS } from "./shell-agent.ts";

type LaunchSnapshot = Pick<SessionSnapshot, "panes" | "agents">;

/** Local dependencies, not global module mocks: every check and input can be held in a test. */
export interface CommandAgentDeps {
  platform?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  snapshot?: (timeoutMs: number) => Promise<LaunchSnapshot>;
  processInfo?: (paneId: string) => Promise<ProcessInfo | undefined>;
  sendText?: (paneId: string, text: string, allowed: () => boolean) => Promise<void>;
  rename?: (paneId: string, name: string) => Promise<unknown>;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash", "fish", "ksh", "ksh93", "mksh", "csh", "tcsh", "nu", "xonsh"]);
const positivePid = (pid: unknown): pid is number => typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
const shellName = (name: string): boolean => SHELLS.has(name.split(/[\\/]/).pop()!.replace(/^-/, ""));
function shellProcess(entry: NonNullable<ProcessInfo["foreground_processes"]>[number]): boolean {
  const names = [entry.argv0, entry.argv?.[0], entry.name].filter((name): name is string => typeof name === "string" && name.length > 0);
  // An exec can keep the shell's pid: a process group alone is not proof of a shell.
  return names.length > 0 && names.every(shellName);
}

function shellReady(paneId: string, info: ProcessInfo | undefined): boolean {
  const foreground = info?.foreground_processes;
  return info?.pane_id === paneId && positivePid(info.shell_pid)
    && info.foreground_process_group_id === info.shell_pid && foreground?.length === 1
    && foreground[0]!.pid === info.shell_pid && shellProcess(foreground[0]!);
}

const noAgent = (kind: string | null | undefined): boolean => !kind || kind === "shell";
const notDetected = (): HerdrError => new HerdrError("agent_not_detected", "the expected agent was not detected in the new pane within 60 seconds; the pane was kept and the command was not retried");
const shellBusy = (): HerdrError => new HerdrError("agent_pane_busy", "the new pane did not have an available foreground shell; no command was sent");

/**
 * Sends the original command plus LF, with no defaults, args, quoting or trimming. Native kinds
 * are proved by a same-pane snapshot; omo/gjc reuse the shell-agent process predicates because
 * herdr may call them pi/claude or not recognize them at all. Custom input is guarded here rather
 * than delegated to startShellAgent, whose standard/Resume path has no cancellation guard. The entire operation is
 * bounded to 60 s, including shell startup and optional process/name lookups. A failed send is
 * never retried: it may already have reached the shell. Failures never close the pane.
 */
export async function startCommandAgent(kind: string, paneId: string, command: string,
  options: { name?: string; timeoutMs?: number } = {}, deps: CommandAgentDeps = {}): Promise<number | null> {
  // Before any RPC, PATH lookup or input, even for a caller other than the create routes.
  if ((deps.platform ?? process.platform) === "win32") throw new HerdrError("platform_unsupported", "custom agent commands are not supported on Windows");
  const fault = launchCommandFault(command);
  if (fault !== null) throw new HerdrError("invalid_agent", fault);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? Bun.sleep;
  const snapshot = deps.snapshot ?? ((timeoutMs: number) => sessionSnapshot(undefined, timeoutMs));
  const processInfo = deps.processInfo ?? paneProcessInfo;
  const sendText = deps.sendText ?? ((id, text, allowed) => paneSendText(id, text, undefined, allowed));
  const rename = deps.rename ?? agentRename;
  const deadline = now() + Math.min(60_000, options.timeoutMs ?? 60_000);
  const shellDeadline = Math.min(deadline, now() + 10_000);
  let active = true;
  const allowed = (): boolean => active && now() < deadline;
  // A stalled RPC cannot extend the deadline. Read-only work may finish late; input is guarded
  // right before writing, so a timed-out operation cannot type after this function has answered.
  const bounded = async <T>(read: () => Promise<T>, until = deadline, timeout = notDetected): Promise<T> => {
    const remaining = until - now();
    if (!active || remaining <= 0) throw timeout();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timeout()), remaining); })]);
      if (!active || now() >= until) throw timeout();
      return result;
    } finally { clearTimeout(timer); }
  };
  try {
    for (;;) {
      const state = await bounded(() => snapshot(shellDeadline - now()), shellDeadline, shellBusy);
      const pane = state.panes.find((entry) => entry.pane_id === paneId);
      if (!pane) throw new HerdrError("pane_not_found", "the new pane is no longer available; no command was sent");
      const occupied = !noAgent(pane.agent) || state.agents.some((entry) => entry.pane_id === paneId && !noAgent(entry.agent));
      const info = occupied ? undefined : await bounded(() => processInfo(paneId), shellDeadline, shellBusy);
      if (!occupied && shellReady(paneId, info)) break;
      await bounded(() => sleep(Math.min(100, shellDeadline - now())), shellDeadline, shellBusy);
    }

    // One guarded submission for every custom kind. Even an unacknowledged send is never retried.
    await bounded(() => sendText(paneId, `${command}\n`, allowed));
    let pid: number | null = null;
    for (;;) {
      const state = await bounded(() => snapshot(deadline - now()));
      if (isShellAgentKind(kind)) {
        const info = await bounded(() => processInfo(paneId));
        const processes = info?.pane_id === paneId ? info.foreground_processes ?? [] : [];
        // As in startShellAgent: omo's launcher identity can be a native CLI or a script.
        const started = processes.find((entry) => positivePid(entry.pid) && (kind === "omo"
          ? omoProcessIdentity({ pid: entry.pid, argv: entry.argv ?? undefined, cwd: entry.cwd ?? undefined }, "", process.env["HOME"] ?? "") !== null
          : SHELL_AGENTS[kind]!(entry.argv ?? [])));
        if (started) { pid = started.pid; break; }
      } else if (state.panes.some((entry) => entry.pane_id === paneId && entry.agent === kind)) {
        // A wrapper can be detected as another kind temporarily. Only the expected kind in
        // this pane is success; another pane and a temporary mismatch are never a failure.
        try {
          const info = await bounded(() => processInfo(paneId));
          const processes = info?.pane_id === paneId ? info.foreground_processes?.filter((entry) => positivePid(entry.pid) && !shellProcess(entry)) ?? [] : [];
          if (processes.length === 1) pid = processes[0]!.pid;
        } catch { /* detected already: a missing process lookup is not a launch failure */ }
        break;
      }
      await bounded(() => sleep(Math.min(250, deadline - now())));
    }

    // Detection is success even if herdr cannot name this kind or a simultaneous rename wins.
    // Collisions only refresh the name; they must never send the command again.
    const given = options.name && options.name.length > 0 ? options.name : null;
    for (let attempt = 0; attempt < 3 && allowed(); attempt += 1) {
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
    // herdr or a shell helper may include input in an exception: never relay its message.
    if (error instanceof HerdrError) {
      if (error.code === "agent_not_detected") throw notDetected();
      if (error.code === "agent_pane_busy") throw shellBusy();
      if (error.code === "pane_not_found") throw new HerdrError("pane_not_found", "the new pane is no longer available; the command was not retried");
    }
    throw new HerdrError("agent_start_failed", "the custom agent could not be started; the pane was kept and the command was not retried");
  } finally { active = false; }
}
