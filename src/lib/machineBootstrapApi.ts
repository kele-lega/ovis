import type { BootstrapAttempt, BootstrapRequest } from "../../shared/bootstrap.ts";
import type { MachineSetupSummary, SetupJob } from "../../shared/machines.ts";
import { machineRequest } from "./api.ts";

/** Public bootstrap material only; private keys stay in the server's pending state. */
export const createMachineBootstrap = (request: BootstrapRequest) => machineRequest<BootstrapAttempt>("/bootstrap", "POST", request);
export const fetchMachineBootstrap = (id: string) => machineRequest<BootstrapAttempt>(`/bootstrap/${encodeURIComponent(id)}`);
export const cancelMachineBootstrap = (id: string) => machineRequest<{ ok: true }>(`/bootstrap/${encodeURIComponent(id)}`, "DELETE");
export const connectMachineBootstrap = (id: string, updateRemote = false) => machineRequest<SetupJob>(`/bootstrap/${encodeURIComponent(id)}/connect`, "POST", { update_remote: updateRemote });
export const revokeMachineBootstrap = (id: string, removeFirewall = false) => machineRequest<{ ok: true }>(`/${encodeURIComponent(id)}/revoke-bootstrap`, "POST", { remove_firewall: removeFirewall });
export const fetchMachineSetups = () => machineRequest<{ setups: MachineSetupSummary[] }>("/setups");
