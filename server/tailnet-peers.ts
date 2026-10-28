import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Machine, SshTarget } from "../shared/machines.ts";
import type { TailnetPeer, TailnetPeers } from "../shared/tailnet.ts";
import { validateTarget } from "./machine-security.ts";
import { tailscaleBinary } from "./tailscale.ts";

const exec = promisify(execFile);
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string => typeof value === "string" ? value : "";
const host = (value: string): string => value.toLowerCase().replace(/\.$/, "").replace(/^\[(.*)\]$/, "$1");
const dnsName = (value: unknown): string => {
  const name = host(text(value));
  return name.length <= 253 && name.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? name : "";
};

function parseStatus(status: string): Record<string, unknown> | null {
  try { return object(JSON.parse(status.replace(/("UserID"\s*:\s*)(\d+)/g, '$1"$2"'))); }
  catch { return null; }
}

function peersFromStatus(parsed: Record<string, unknown> | null): TailnetPeers {
  if (!parsed) return { state: "unavailable", peers: [] };
  if (parsed.BackendState !== "Running") return { state: "stopped", peers: [] };
  const self = object(parsed.Self);
  const owner = self?.UserID;
  if (!self || typeof owner !== "string" || !/^\d+$/.test(owner) || owner === "0" || (Array.isArray(self.Tags) && self.Tags.length > 0)) return { state: "identity_unavailable", peers: [] };
  const peers: TailnetPeer[] = [];
  for (const value of Object.values(object(parsed.Peer) ?? {})) {
    const peer = object(value);
    if (!peer || peer.UserID !== owner || peer.ID === self.ID || peer.ShareeNode === true || (Array.isArray(peer.Tags) && peer.Tags.length > 0)) continue;
    const os = text(peer.OS).toLowerCase();
    if (!["linux", "darwin", "macos", "windows"].includes(os)) continue;
    const id = text(peer.ID);
    const addresses = Array.isArray(peer.TailscaleIPs) ? peer.TailscaleIPs.filter((ip): ip is string => typeof ip === "string" && isIP(ip) !== 0) : [];
    const dns = dnsName(peer.DNSName);
    // DNS is display/matching identity only, even when the tailnet has MagicDNS enabled.
    const destination = addresses.find((ip) => isIP(ip) === 4) ?? addresses[0];
    if (!id || !destination) continue;
    const hostname = text(peer.HostName);
    peers.push({ id, name: dns.split(".")[0] || hostname || destination, hostname, dns_name: dns || null, destination, addresses: [...addresses, ...(dns ? [dns] : [])], os, online: peer.Online === true, registrations: [] });
  }
  peers.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  return { state: "running", peers };
}

/** No probes: Online is what Tailscale last reported, not evidence that SSH works. */
export function parseTailnetPeers(status: string): TailnetPeers {
  return peersFromStatus(parseStatus(status));
}

export interface ResolvedSshTarget { hostname: string; user: string | null; port: number | null }

/** A deliberately small, static subset: never invoke ssh (Match exec can run even with -G).
 * Includes, Match, patterns and expansion are left unresolved, not emulated or executed. */
export function resolveSavedSshTarget(target: SshTarget, config: string): ResolvedSshTarget | null {
  try { validateTarget(target); } catch { return null; }
  const at = target.destination.lastIndexOf("@");
  const destination = at < 0 ? target.destination : target.destination.slice(at + 1);
  const fields = new Map<string, string>();
  let active = true;
  for (const line of config.split(/\r?\n/)) {
    const clean = line.replace(/\s*#.*$/, "").trim();
    if (!clean) continue;
    const match = /^([a-z]+)(?:\s*=\s*|\s+)(.+)$/i.exec(clean);
    if (!match) return null;
    const key = match[1]!.toLowerCase(), value = match[2]!.trim();
    if (["include", "match", "canonicalizehostname"].includes(key)) return null;
    if (key === "host") {
      const names = value.split(/\s+/);
      if (names.some((name) => name !== "*" && !/^[a-z0-9_.:-]+$/i.test(name))) return null;
      active = names.some((name) => name === "*" || host(name) === host(destination));
    } else if (active && ["hostname", "user", "port"].includes(key) && !fields.has(key)) fields.set(key, value);
  }
  const hostname = fields.get("hostname") ?? destination;
  const user = at < 0 ? fields.get("user") ?? null : target.destination.slice(0, at);
  const port = target.port ?? (fields.has("port") ? Number(fields.get("port")) : null);
  if ((!isIP(host(hostname)) && !dnsName(hostname)) || (user !== null && !/^[a-z0-9_.-]+$/i.test(user)) || (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535))) return null;
  return { hostname: host(hostname), user, port };
}

async function savedSshConfig(): Promise<string | null> {
  try {
    const file = await open(join(homedir(), ".ssh", "config"), "r");
    try {
      const buffer = new Uint8Array(256 * 1024 + 1);
      const { bytesRead } = await file.read(buffer);
      return bytesRead < buffer.length ? new TextDecoder().decode(buffer.subarray(0, bytesRead)) : null;
    } finally { await file.close(); }
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "" : null; }
}

/** Only the Tailscale status command and a bounded local configuration-file read. */
export async function readTailnetPeers(machines: readonly Machine[], options: {
  readStatus?: () => Promise<string | null | undefined>;
  readConfig?: () => Promise<string | null>;
} = {}): Promise<TailnetPeers> {
  let status: string | null | undefined;
  try {
    if (options.readStatus) status = await options.readStatus();
    else {
      const binary = tailscaleBinary();
      if (!binary) return { state: "missing", peers: [] };
      status = (await exec(binary, ["status", "--json"], { timeout: 2500, maxBuffer: 4 * 1024 * 1024, windowsHide: true })).stdout;
    }
  } catch { return { state: "unavailable", peers: [] }; }
  if (status === undefined) return { state: "missing", peers: [] };
  if (status === null) return { state: "unavailable", peers: [] };
  const parsed = parseStatus(status);
  const result = peersFromStatus(parsed);
  if (result.peers.length === 0) return result;
  const magicDns = object(parsed?.CurrentTailnet)?.MagicDNSEnabled === true;
  const config = await (options.readConfig ?? savedSshConfig)().catch(() => null);
  if (config === null) return result;
  for (const machine of machines) {
    if (machine.kind !== "ssh" || !machine.target) continue;
    const resolved = resolveSavedSshTarget(machine.target, config);
    if (!resolved) continue;
    for (const peer of result.peers) {
      const shortName = magicDns && peer.dns_name ? peer.dns_name.split(".")[0] : null;
      if (resolved.hostname !== shortName && !peer.addresses.some((address) => host(address) === resolved.hostname)) continue;
      peer.registrations.push({ machine_id: machine.id, name: machine.name, user: resolved.user, port: resolved.port, session: machine.target.session || "default" });
    }
  }
  for (const peer of result.peers) peer.registrations.sort((a, b) => (a.user ?? "").localeCompare(b.user ?? "") || (a.port ?? 0) - (b.port ?? 0) || a.session.localeCompare(b.session));
  return result;
}
