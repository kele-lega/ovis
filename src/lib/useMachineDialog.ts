import { useCallback, useRef, useState } from "react";
import type { MachineSetupInitial } from "../../shared/tailnet.ts";
import type { Machine } from "../../shared/machines.ts";
import { focusWorkspaceListToggle } from "./focus.ts";

export function useMachineDialog() {
  const [machineDialog, setMachineDialog] = useState<Machine | "new" | null>(null);
  const [machineSetupInitial, setMachineSetupInitial] = useState<MachineSetupInitial | undefined>();
  // Add PC from Settings or the palette leaves no trigger to return focus to once its dialog
  // closes (Settings closed when it opened): the header's workspace-list toggle stands in
  const addPcFocusReturn = useRef(false);
  const closeMachineDialog = useCallback(() => {
    setMachineDialog(null);
    if (!addPcFocusReturn.current) return;
    addPcFocusReturn.current = false;
    focusWorkspaceListToggle();
  }, []);
  return { machineSetupInitial, setMachineSetupInitial, machineDialog, setMachineDialog, addPcFocusReturn, closeMachineDialog };
}
