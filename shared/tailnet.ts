import type { SetupRequest } from "./machines.ts";

export interface TailnetRegistration {
  machine_id: string;
  name: string;
  user: string | null;
  port: number | null;
  session: string;
}
export interface TailnetPeer {
  id: string;
  name: string;
  destination: string;
  addresses: string[];
  os: string;
  online: boolean;
  registrations: TailnetRegistration[];
}
/** Only this connection server's own Tailscale user's PCs, never other members or tagged nodes. */
export interface TailnetPeers {
  state: "missing" | "unavailable" | "stopped" | "running" | "identity_unavailable";
  peers: TailnetPeer[];
}
export type MachineSetupInitial = Pick<SetupRequest, "destination" | "name">;
