import { useCallback, useEffect, useRef, useState } from "react";
import type { MachineSetupSummary } from "../../shared/machines.ts";
import { fetchMachineSetups } from "./machineBootstrapApi.ts";

/** Public progress is server-owned, not a browser draft. A new tab recovers it without re-submitting setup. */
export function useMachineSetups(locked: boolean | null) {
  const [machineSetups, setMachineSetups] = useState<MachineSetupSummary[]>([]);
  const received = useRef(0);
  const receiveMachineSetups = useCallback((next: MachineSetupSummary[]) => {
    received.current++;
    setMachineSetups((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
  }, []);
  useEffect(() => {
    if (locked !== false) { setMachineSetups([]); return; }
    let cancelled = false;
    let timer = 0;
    const read = async () => {
      const started = received.current;
      try {
        const next = await fetchMachineSetups();
        if (!cancelled && received.current === started) receiveMachineSetups(next.setups);
      } catch { /* Older servers have no setup-list route; live events still work. */ }
      if (!cancelled) timer = window.setTimeout(read, 5000);
    };
    void read();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [locked, receiveMachineSetups]);
  return { machineSetups, receiveMachineSetups };
}
