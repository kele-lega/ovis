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
  hostname: string;
  dns_name: string | null;
  /** Literal Tailscale IP: IPv4 preferred, IPv6 only when no IPv4 is available. */
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
/** Transient discovery context; never a saved setting or a new setup API parameter. */
export type MachineSetupInitial = Pick<TailnetPeer, "id" | "destination" | "name" | "hostname" | "dns_name" | "os">;
