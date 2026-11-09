import { useCallback, useEffect, useRef, useState } from "react";
import type { Machine } from "../../shared/machines.ts";
import type { AddPcPreset } from "./actions.ts";
import { focusWorkspaceListToggle } from "./focus.ts";
import { afterSettingsExit } from "./settingsHistory.ts";

export function useMachineDialog() {
  const [machineDialog, setMachineDialogState] = useState<Machine | "new" | null>(null);
  const pendingSetup = useRef<(() => void) | null>(null);
  const cancelSetup = useCallback(() => { pendingSetup.current?.(); pendingSetup.current = null; }, []);
  const setMachineDialog = useCallback((machine: Machine | "new" | null) => { cancelSetup(); setMachineDialogState(machine); }, [cancelSetup]);
  const openAfterSettings = useCallback((run: () => void) => {
    cancelSetup();
    pendingSetup.current = afterSettingsExit(() => { pendingSetup.current = null; run(); });
  }, [cancelSetup]);
  useEffect(() => cancelSetup, [cancelSetup]);
  const [resumeSetupId, setResumeSetupId] = useState<string | undefined>();
  // a new PC's address, when Add a connection → SSH picked one
  const [addPcPreset, setAddPcPreset] = useState<AddPcPreset | null>(null);
  // Add PC from Settings or the palette leaves no trigger to return focus to once its dialog
  // closes (Settings closed when it opened): the header's workspace-list toggle stands in
  const addPcFocusReturn = useRef(false);
  const closeMachineDialog = useCallback(() => {
    setMachineDialog(null);
    setAddPcPreset(null);
    setResumeSetupId(undefined);
    if (!addPcFocusReturn.current) return;
    addPcFocusReturn.current = false;
    focusWorkspaceListToggle();
  }, [setMachineDialog]);
  return { resumeSetupId, setResumeSetupId, machineDialog, setMachineDialog, addPcPreset, setAddPcPreset, addPcFocusReturn, closeMachineDialog, openAfterSettings };
}
