import { useCallback, useEffect, useRef, useState } from "react";
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
  const read = useRef(0);
  const withConfigured = useCallback((agents: AgentKind[]) => {
    const configured: string[] = JSON.parse(keys);
    return [...agents, ...configured.filter((kind) => !agents.some((agent) => agent.kind === kind)).map((kind) => ({ kind, label: kind }))];
  }, [keys]);
  useEffect(() => {
    const revision = ++read.current;
    setResult(null);
    if (!active) return;
    let cancelled = false;
    let capable = false;
    const configured: string[] = JSON.parse(keys);
    void fetchAgents((capabilities) => { if (!cancelled) capable = capabilities.launch_command === true; }, configured).then(
      (agents) => { if (!cancelled && revision === read.current) setResult({ source: fetchAgents, keys, agents: withConfigured(agents), capable, error: null }); },
      (error: unknown) => { if (!cancelled && revision === read.current) setResult({ source: fetchAgents, keys, agents: withConfigured([]), capable: false, error }); },
    );
    return () => { cancelled = true; read.current++; };
  }, [active, fetchAgents, keys, withConfigured]);
  // Add another agent rereads PATH after installation. Its newest read owns both catalog and capability,
  // and may finish before the opening read; the latter must never put old choices back over it.
  const refresh = useCallback(async (): Promise<AgentKind[]> => {
    const revision = ++read.current;
    let capable = false;
    const agents = withConfigured(await fetchAgents((capabilities) => { capable = capabilities.launch_command === true; }, JSON.parse(keys)));
    if (revision === read.current) setResult({ source: fetchAgents, keys, agents, capable, error: null });
    return agents;
  }, [fetchAgents, keys, withConfigured]);
  const current = active && result?.source === fetchAgents && result.keys === keys ? result : null;
  return { refresh, agents: current?.agents ?? Object.keys(commands).filter((kind) => SUPPORTED_AGENT_KINDS.has(kind)).map((kind) => ({ kind, label: kind })), capable: current?.capable ?? false, loaded: current !== null, error: current?.error ?? null };
}
