import type { SshTarget } from "./machines.ts";

export type BootstrapOS = "windows" | "linux" | "darwin";
export interface BootstrapRequest { peer_id: string; username: string; name?: string; session?: string }
/** Public material only. Expiry stops local retries; it does NOT revoke the remote public key. */
export interface BootstrapAttempt {
  id: string;
  machine_id: string;
  target: SshTarget;
  os: BootstrapOS;
  expires_at: number;
  command: string;
  cleanup_command: string;
  public_key: string;
  source_ip: string;
}
export interface BootstrapConnectRequest { update_remote?: boolean }
export interface RevokeBootstrapRequest { remove_firewall?: boolean }
