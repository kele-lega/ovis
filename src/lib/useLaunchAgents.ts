import { useEffect, useState } from "react";
import type { AgentKind } from "../../shared/protocol.ts";
import { SUPPORTED_AGENT_KINDS } from "../../shared/supported-agents.ts";

type FetchAgents = (onCapabilities?: (capabilities: { launch_command?: boolean }) => void, configuredKinds?: readonly string[]) => Promise<AgentKind[]>;
interface Result {
  source: FetchAgents;
  keys: string;
  agents: AgentKind[];
  capable: boolean;
  error: unknown;
}

/** Creation-only catalog. Capabilities belong to the exact PC/read, never the last PC selected. */
export function useLaunchAgents(active: boolean, fetchAgents: FetchAgents, commands: Record<string, string>) {
  const keys = JSON.stringify(Object.keys(commands).filter((kind) => SUPPORTED_AGENT_KINDS.has(kind)).sort());
  const [result, setResult] = useState<Result | null>(null);
  useEffect(() => {
    setResult(null);
    if (!active) return;
    let cancelled = false;
    let capable = false;
    const configured: string[] = JSON.parse(keys);
    const withConfigured = (agents: AgentKind[]) => [
      ...agents,
      ...configured.filter((kind) => !agents.some((agent) => agent.kind === kind)).map((kind) => ({ kind, label: kind })),
    ];
    void fetchAgents((capabilities) => { if (!cancelled) capable = capabilities.launch_command === true; }, configured).then(
      (agents) => { if (!cancelled) setResult({ source: fetchAgents, keys, agents: withConfigured(agents), capable, error: null }); },
      (error: unknown) => { if (!cancelled) setResult({ source: fetchAgents, keys, agents: withConfigured([]), capable: false, error }); },
    );
    return () => { cancelled = true; };
  }, [active, fetchAgents, keys]);
  const current = active && result?.source === fetchAgents && result.keys === keys ? result : null;
  return { agents: current?.agents ?? Object.keys(commands).filter((kind) => SUPPORTED_AGENT_KINDS.has(kind)).map((kind) => ({ kind, label: kind })), capable: current?.capable ?? false, loaded: current !== null, error: current?.error ?? null };
}
