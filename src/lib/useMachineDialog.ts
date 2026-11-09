import { useCallback, useRef, useState } from "react";
import type { Machine } from "../../shared/machines.ts";
import type { AddPcPreset } from "./actions.ts";
import { focusWorkspaceListToggle } from "./focus.ts";
import { outsideSettings, settingsEntry } from "./settingsHistory.ts";

/** Setup replaces Add a connection, not a Back out of Settings that would close the new phone sheet. */
export function leaveSettingsForMachineSetup(): void {
  if (settingsEntry(window.history.state) !== null) window.history.pushState(outsideSettings(window.history.state), "");
}

export function useMachineDialog() {
  const [machineDialog, setMachineDialog] = useState<Machine | "new" | null>(null);
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
  }, []);
  return { resumeSetupId, setResumeSetupId, machineDialog, setMachineDialog, addPcPreset, setAddPcPreset, addPcFocusReturn, closeMachineDialog };
}
