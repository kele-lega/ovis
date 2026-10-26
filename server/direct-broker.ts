import { createHash } from "node:crypto";
import { normalizeDirectOrigin, type DirectCredentialResponse } from "../shared/direct.ts";
import { DirectSigner } from "./direct-auth.ts";
import type { MachineManager } from "./machines.ts";

export interface DirectConfig { endpoints: Record<string, string>; origins: string[] }

/** Administrator-owned addresses, never a URL supplied by a browser or an SSH alias. */
export function directConfig(endpoints = process.env["OVIS_DIRECT_ENDPOINTS"], origins = process.env["OVIS_DIRECT_ORIGINS"]): DirectConfig {
  const value: unknown = endpoints ? JSON.parse(endpoints) : {};
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 128) throw new Error("Invalid OVIS_DIRECT_ENDPOINTS");
  const mapped: Record<string, string> = Object.create(null);
  for (const [id, origin] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || id === "local") throw new Error("Direct endpoints must name a remote machine ID");
    mapped[id] = normalizeDirectOrigin(origin);
  }
  const allowed = origins ? origins.split(",").map((origin) => normalizeDirectOrigin(origin.trim())) : [];
  if (Object.keys(mapped).length && !allowed.length) throw new Error("OVIS_DIRECT_ORIGINS is required for direct access");
  return { endpoints: mapped, origins: [...new Set(allowed)] };
}

interface Lease { signer: DirectSigner; endpoint: { url: string; token: string }; untrack: () => void; revocations: Map<string, () => void>; updating?: Promise<void> }

/** The SSH-authenticated control plane installs expiring trust; browser data never passes here. */
export class DirectBroker {
  private readonly leases = new Map<string, Lease>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly generations = new Map<string, number>();
  private stopped = false;

  constructor(private readonly manager: MachineManager, readonly config: DirectConfig) {
    this.timer = setInterval(() => {
      for (const [id, lease] of this.leases) void this.refresh(id, lease).catch(() => {});
    }, 25_000);
    this.timer.unref();
  }

  private async control(lease: Lease, body: unknown, method = "POST"): Promise<void> {
    const response = await fetch(`${lease.endpoint.url}/api/direct/trust`, {
      method, headers: { authorization: `Bearer ${lease.endpoint.token}`, "content-type": "application/json" },
      body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(5000),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error("Direct bridge control unavailable");
  }

  private refresh(id: string, lease: Lease): Promise<void> {
    if (lease.updating) return lease.updating;
    lease.updating = this.control(lease, lease.signer.trust(id, this.config.origins)).finally(() => { lease.updating = undefined; });
    return lease.updating;
  }

  async issue(id: string, origin: string, subject: string, readOnly: boolean, onRevoke?: (close: () => void) => () => void): Promise<DirectCredentialResponse | null> {
    const target = this.config.endpoints[id];
    if (!target || !this.config.origins.includes(origin) || this.stopped) return null;
    const endpoint = this.manager.endpoint(id);
    if (!endpoint) throw new Error("This PC is disconnected");
    const generation = this.generations.get(subject) ?? 0;
    const scopedSubject = `${subject}:${generation}`;
    let lease = this.leases.get(id);
    if (lease && (lease.endpoint.url !== endpoint.url || lease.endpoint.token !== endpoint.token)) { this.drop(id); lease = undefined; }
    if (!lease) {
      lease = { signer: new DirectSigner(), endpoint, untrack: () => {}, revocations: new Map() };
      this.leases.set(id, lease);
      lease.untrack = this.manager.trackTerminal(id, () => this.drop(id));
    }
    const captured = lease;
    let revoked = false;
    // Device revocation can happen while the SSH registration request is in flight.
    const unwatch = onRevoke?.(() => {
      revoked = true;
      void this.control(captured, { issuer: captured.signer.issuer, subject: scopedSubject }, "PATCH").catch(() => this.drop(id));
    });
    try {
      await this.refresh(id, captured);
      if (revoked || generation !== (this.generations.get(subject) ?? 0) || this.stopped || this.leases.get(id) !== captured || this.manager.endpoint(id) !== endpoint) throw new Error("Direct access changed while connecting");
      if (unwatch) {
        captured.revocations.get(subject)?.();
        captured.revocations.set(subject, unwatch);
      }
      const fields = { aud: id, sub: scopedSubject, origin, role: readOnly ? "observe" as const : "interact" as const };
      const ticket = captured.signer.issue({ ...fields, kind: "ws" });
      const http = captured.signer.issue({ ...fields, kind: "http" });
      return { origin: target, ticket: ticket.token, access_token: http.token, expires_at: http.expires_at };
    } catch (error) { unwatch?.(); if (revoked) this.drop(id); throw error; }
  }

  revoke(subject: string): void {
    const generation = this.generations.get(subject) ?? 0;
    this.generations.set(subject, generation + 1);
    for (const [id, lease] of this.leases) void this.control(lease, { issuer: lease.signer.issuer, subject: `${subject}:${generation}` }, "PATCH").catch(() => this.drop(id));
  }

  private drop(id: string): void {
    const lease = this.leases.get(id);
    if (!lease) return;
    this.leases.delete(id);
    lease.untrack();
    for (const unwatch of lease.revocations.values()) unwatch();
    // Failure is fail-closed after the 90-second trust lease expires on the bridge.
    void Promise.resolve(lease.updating).catch(() => {}).then(() => this.control(lease, { issuer: lease.signer.issuer }, "DELETE")).catch(() => {});
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    for (const id of this.leases.keys()) this.drop(id);
  }
}

/** No master credential is sent to the bridge or written to diagnostics. */
export function directSubject(deviceId: string | undefined, credential: string): string {
  return deviceId ? `device:${deviceId}` : `browser:${createHash("sha256").update(credential).digest("hex")}`;
}
