import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BootstrapAttempt, BootstrapOS, BootstrapRequest } from "../shared/bootstrap.ts";
import type { Machine, SshTarget } from "../shared/machines.ts";
import { BOOTSTRAP_ASSETS, type BootstrapAsset } from "./bootstrap-assets.ts";
import { shellQuote, validateTarget } from "./machine-security.ts";
import { psQuote } from "./powershell.ts";
import { parseTailnetPeers } from "./tailnet-peers.ts";
import { tailscaleBinary } from "./tailscale.ts";
import type { SshConnection } from "./ssh.ts";

const exec = promisify(execFile);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const BOOTSTRAP_TTL_MS = 15 * 60_000;
export const BOOTSTRAP_UNAVAILABLE = "The verified SSH bootstrap release is unavailable. Try again later or set up SSH manually.";
export class BootstrapError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
const invalid = (message: string): never => { throw new BootstrapError("invalid_bootstrap", message); };
const unavailable = (): never => { throw new BootstrapError("bootstrap_unavailable", BOOTSTRAP_UNAVAILABLE, 503); };
export function tailnetIP(ip: unknown): ip is string {
  if (typeof ip !== "string" || ip.includes("%")) return false;
  if (isIP(ip) === 4) { const octets = ip.split(".").map(Number); return octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127; }
  return isIP(ip) === 6 && /^fd7a:115c:a1e0:/i.test(ip);
}
export function bootstrapRequest(value: unknown): BootstrapRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("Expected bootstrap details");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((key) => !["peer_id", "username", "name", "session"].includes(key))) return invalid("Unsupported bootstrap details");
  if (typeof v.peer_id !== "string" || !v.peer_id || v.peer_id.length > 128 || /[\x00-\x20\x7f]/.test(v.peer_id)) return invalid("Choose a discovered PC");
  if (typeof v.username !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/.test(v.username)) return invalid("Enter the PC's local SSH username");
  if (v.name !== undefined && (typeof v.name !== "string" || !v.name.trim() || v.name.length > 100 || /[\x00-\x1f\x7f]/.test(v.name))) return invalid("Enter a PC name (1–100 characters)");
  validateTarget({ destination: "bootstrap", ...(v.session === undefined ? {} : { session: v.session }) });
  return v as unknown as BootstrapRequest;
}
export function resolveBootstrapPeer(status: string, request: BootstrapRequest): { target: SshTarget; os: BootstrapOS; sourceIP: string } {
  const peers = parseTailnetPeers(status);
  const peer = peers.peers.find((p) => p.id === request.peer_id);
  if (peers.state !== "running" || !peer?.online || !tailnetIP(peer.destination)) return invalid("This discovered PC is no longer available. Refresh the PC list.");
  let self: unknown;
  try { self = (JSON.parse(status) as { Self?: { TailscaleIPs?: unknown } }).Self?.TailscaleIPs; } catch { return invalid("Tailscale identity is unavailable"); }
  const sourceIP = Array.isArray(self) ? self.find((ip): ip is string => tailnetIP(ip) && isIP(ip) === isIP(peer.destination)) : undefined;
  if (!sourceIP) return invalid("This server has no matching Tailscale IP address");
  const os: BootstrapOS = peer.os === "windows" ? "windows" : peer.os === "linux" ? "linux" : "darwin";
  return { target: validateTarget({ destination: `${request.username}@${peer.destination}`, port: 22, ...(request.session ? { session: request.session } : {}) }), os, sourceIP };
}

const RELEASE = /^https:\/\/github\.com\/kele-lega\/ovis\/releases\/download\/bootstrap-v1\/ovis-bootstrap\.(sh|ps1)$/;
const checked = new Set<string>();
/** No browser URL, no filesystem cache, and no unchecked redirect is ever fetched. */
export async function verifyBootstrapAsset(asset: BootstrapAsset, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<void> {
  if (!RELEASE.test(asset.url) || !/^[a-f0-9]{64}$/.test(asset.sha256)) return unavailable();
  const cacheKey = asset.url + ":" + asset.sha256;
  if (signal?.aborted) return unavailable();
  if (checked.has(cacheKey)) return;
  const abort = AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]);
  try {
    let url = asset.url;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetcher(url, { redirect: "manual", signal: abort });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location"); await response.body?.cancel();
        if (!location) return unavailable();
        const next = new URL(location, url);
        if (next.protocol !== "https:" || next.username || next.password || next.port || next.hash || !["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(next.hostname)) return unavailable();
        url = next.href; continue;
      }
      if (!response.ok || !response.body || Number(response.headers.get("content-length")) > 1024 * 1024) { await response.body?.cancel(); return unavailable(); }
      const reader = response.body.getReader(), hash = createHash("sha256");
      let total = 0;
      try {
        for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.length; if (total > 1024 * 1024) { await reader.cancel(); return unavailable(); } hash.update(value); }
      } finally { reader.releaseLock(); }
      if (abort.aborted || total === 0 || hash.digest("hex") !== asset.sha256) return unavailable();
      checked.add(cacheKey); return;
    }
  } catch { return unavailable(); }
  return unavailable();
}
export function bootstrapCommand(asset: BootstrapAsset, attempt: Omit<BootstrapAttempt, "command" | "cleanup_command">, username: string, remove = false): string {
  const target = attempt.target.destination.slice(attempt.target.destination.indexOf("@") + 1);
  const expires = String(Math.floor(attempt.expires_at / 1000));
  if (attempt.os === "windows") return `$p = Join-Path $env:TEMP ('ovis-bootstrap-' + [guid]::NewGuid() + '.ps1'); try { Invoke-WebRequest -UseBasicParsing -Uri ${psQuote(asset.url)} -OutFile $p; if ((Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLowerInvariant() -ne ${psQuote(asset.sha256)}) { throw 'Bootstrap checksum mismatch' }; powershell.exe -NoProfile -ExecutionPolicy Bypass -File $p -User ${psQuote(username)} -Key ${psQuote(attempt.public_key)} -From ${psQuote(attempt.source_ip)} -Target ${psQuote(target)} -Expires ${expires}${remove ? " -Remove" : ""}; if ($LASTEXITCODE -ne 0) { throw 'SSH bootstrap failed' } } finally { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }`;
  return `( umask 077; p=$(mktemp) || exit; trap 'rm -f "$p"' EXIT HUP INT TERM; curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fLsS --max-time 20 --max-filesize 1048576 ${shellQuote(asset.url)} -o "$p" && h=$(if command -v sha256sum >/dev/null 2>&1; then sha256sum "$p"; else shasum -a 256 "$p"; fi) && [ "\${h%% *}" = ${shellQuote(asset.sha256)} ] && sudo sh "$p" --user ${shellQuote(username)} --key ${shellQuote(attempt.public_key)} --from ${shellQuote(attempt.source_ip)} --target ${shellQuote(target)} --expires ${expires}${remove ? " --remove" : ""} )`;
}
export interface BootstrapMetadata { publicKey: string; sourceIP: string; os: BootstrapOS; username: string; target: SshTarget; revoked?: boolean }
interface Pending {
  id: string; machineId: string; directory?: string; keyPath?: string; request: BootstrapRequest; expires: number; abort: AbortController;
  attempt?: BootstrapAttempt; metadata?: BootstrapMetadata; timer: ReturnType<typeof setTimeout>; generating?: Promise<void>; active?: { cancel(): void; finished: Promise<void> }; cancelled?: boolean;
}
export interface BootstrapLease { id: string; machineId: string; keyPath: string; request: BootstrapRequest; metadata: BootstrapMetadata }
export interface BootstrapDependencies {
  readStatus?(): Promise<string>;
  verifyAsset?(asset: BootstrapAsset, signal: AbortSignal): Promise<void>;
  keygen?(path: string, machineId: string, signal: AbortSignal): Promise<void>;
  now?(): number;
}
function safeDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe SSH bootstrap directory");
  chmodSync(path, 0o700);
}
/** Pending credentials never become registrations until normal setup has succeeded. */
export class SshBootstrap {
  private pending = new Map<string, Pending>();
  private directory: string;
  private stopped = false;
  private now: () => number;
  private records: Record<string, BootstrapMetadata> = {};
  private metadataPath: string;
  private writable = true;
  constructor(readonly stateDir: string, private deps: BootstrapDependencies = {}) {
    this.now = deps.now ?? Date.now;
    this.directory = join(stateDir, "ssh-bootstrap-pending");
    safeDirectory(this.directory);
    // Only our dedicated pending root, never stateDir/ssh or any symlink target.
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) if (/^attempt-[a-zA-Z0-9]+$/.test(entry.name) && entry.isDirectory() && !entry.isSymbolicLink()) rmSync(join(this.directory, entry.name), { recursive: true, force: true });
    this.metadataPath = join(stateDir, "bootstrap-registrations.json");
    if (existsSync(this.metadataPath)) {
      try {
        if (lstatSync(this.metadataPath).isSymbolicLink()) throw new Error("symlink");
        const saved = JSON.parse(readFileSync(this.metadataPath, "utf8")) as { version: unknown; registrations: Record<string, unknown> };
        if (saved.version !== 1 || !saved.registrations || typeof saved.registrations !== "object" || Array.isArray(saved.registrations)) throw new Error("format");
        for (const [id, record] of Object.entries(saved.registrations)) { if (!validMetadata(id, record)) throw new Error("record"); this.records[id] = record; }
      } catch { this.records = {}; this.writable = false; throw new Error("Invalid bootstrap-registrations.json; registrations and credentials were preserved"); }
    }
  }
  metadata(id: string, target?: SshTarget): BootstrapMetadata | undefined {
    const value = this.records[id];
    if (value && target && JSON.stringify(value.target) !== JSON.stringify(target)) throw new Error("Bootstrap SSH connection details do not match the registration; credentials were preserved");
    return value;
  }
  private save(): void {
    if (!this.writable) throw new BootstrapError("bootstrap_unavailable", BOOTSTRAP_UNAVAILABLE, 503);
    const temp = this.metadataPath + ".tmp-" + randomUUID();
    try { writeFileSync(temp, JSON.stringify({ version: 1, registrations: this.records }), { mode: 0o600, flag: "wx" }); renameSync(temp, this.metadataPath); }
    finally { rmSync(temp, { force: true }); }
  }
  register(id: string, value: BootstrapMetadata): void { const previous = this.records[id]; this.records[id] = value; try { this.save(); } catch (error) { if (previous) this.records[id] = previous; else delete this.records[id]; throw error; } }
  forget(id: string): void { const previous = this.records[id]; if (!previous) return; delete this.records[id]; try { this.save(); } catch (error) { this.records[id] = previous; throw error; } }
  async create(value: unknown, machines: readonly Machine[], signal?: AbortSignal): Promise<BootstrapAttempt> {
    const request = bootstrapRequest(value);
    if (this.stopped || !this.writable) return unavailable();
    if (this.pending.size >= 4) throw new BootstrapError("bootstrap_limit", "Finish or cancel a pending SSH bootstrap first", 409);
    const id = randomUUID(), machineId = randomUUID();
    if (machines.some((machine) => machine.id === machineId) || [...this.pending.values()].some((pending) => pending.machineId === machineId)) return unavailable();
    const entry: Pending = { id, machineId, request, expires: this.now() + BOOTSTRAP_TTL_MS, abort: new AbortController(), timer: setTimeout(() => { void this.cancel(id); }, BOOTSTRAP_TTL_MS) };
    entry.timer.unref(); this.pending.set(id, entry);
    const abort = AbortSignal.any([entry.abort.signal, ...(signal ? [signal] : [])]);
    const current = () => { if (abort.aborted || entry.cancelled || this.stopped || this.now() >= entry.expires) throw new BootstrapError("bootstrap_expired", "This SSH bootstrap expired or was cancelled", 410); };
    try {
      const status = await (this.deps.readStatus ?? (async () => {
        const binary = tailscaleBinary(); if (!binary) return invalid("Tailscale is unavailable");
        return (await exec(binary, ["status", "--json"], { timeout: 2500, maxBuffer: 4 * 1024 * 1024, windowsHide: true, signal: abort, killSignal: "SIGKILL" })).stdout;
      }))();
      current();
      const { target, os, sourceIP } = resolveBootstrapPeer(status, request);
      const asset = BOOTSTRAP_ASSETS[os];
      await (this.deps.verifyAsset ?? verifyBootstrapAsset)(asset, abort); current();
      entry.directory = mkdtempSync(join(this.directory, "attempt-")); chmodSync(entry.directory, 0o700);
      const path = entry.keyPath = join(entry.directory, "key");
      entry.generating = (this.deps.keygen ?? (async (path: string, machineId: string, signal: AbortSignal) => {
        await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `ovis:${machineId}`, "-f", path], { timeout: 10_000, maxBuffer: 16 * 1024, windowsHide: true, signal, killSignal: "SIGKILL" });
      }))(path, machineId, abort);
      try { await entry.generating; } finally { entry.generating = undefined; }
      current(); chmodSync(path, 0o600);
      const publicKey = readFileSync(path + ".pub", "utf8").trim();
      if (!validKey(machineId, publicKey)) return unavailable();
      const publicPart = { id, machine_id: machineId, target, os, expires_at: entry.expires, public_key: publicKey, source_ip: sourceIP };
      entry.metadata = { publicKey, sourceIP, os, username: request.username, target };
      entry.attempt = { ...publicPart, command: bootstrapCommand(asset, publicPart, request.username), cleanup_command: bootstrapCommand(asset, publicPart, request.username, true) };
      return { ...entry.attempt };
    } catch (error) { await this.cancel(id); if (error instanceof BootstrapError) throw error; return unavailable(); }
  }
  snapshot(id: string): BootstrapAttempt {
    const entry = this.pending.get(id);
    if (!entry || entry.cancelled || (!entry.active && this.now() >= entry.expires)) throw new BootstrapError("bootstrap_expired", "This SSH bootstrap expired or was cancelled", 410);
    if (!entry.attempt) throw new BootstrapError("bootstrap_pending", "The SSH bootstrap is not ready", 409);
    return { ...entry.attempt };
  }
  begin(id: string): BootstrapLease {
    this.snapshot(id);
    const entry = this.pending.get(id)!;
    if (entry.active) throw new BootstrapError("bootstrap_busy", "A connection for this SSH bootstrap is already running", 409);
    clearTimeout(entry.timer);
    return { id, machineId: entry.machineId, keyPath: entry.keyPath!, request: entry.request, metadata: entry.metadata! };
  }
  running(id: string, active: Pending["active"]): void { this.pending.get(id)!.active = active; }
  finish(id: string, success: boolean): void {
    const entry = this.pending.get(id); if (!entry) return;
    entry.active = undefined;
    if (success || entry.cancelled || this.stopped || this.now() >= entry.expires) { this.pending.delete(id); if (entry.directory) rmSync(entry.directory, { recursive: true, force: true }); }
    else { entry.timer = setTimeout(() => { void this.cancel(id); }, Math.max(0, entry.expires - this.now())); entry.timer.unref(); }
  }
  async cancel(id: string): Promise<void> {
    const entry = this.pending.get(id); if (!entry) return;
    entry.cancelled = true; entry.abort.abort(); clearTimeout(entry.timer); entry.active?.cancel();
    if (entry.active) await entry.active.finished;
    if (entry.generating) await entry.generating.catch(() => {});
    if (entry.directory) rmSync(entry.directory, { recursive: true, force: true });
    this.pending.delete(id);
  }
  stop(): void { this.stopped = true; for (const id of this.pending.keys()) void this.cancel(id); }
}
function validKey(id: string, key: unknown): key is string { return typeof key === "string" && new RegExp(`^ssh-ed25519 [A-Za-z0-9+/]{68} ovis:${id}$`).test(key); }
function validMetadata(id: string, value: unknown): value is BootstrapMetadata {
  if (!UUID.test(id) || !value || typeof value !== "object") return false;
  const v = value as BootstrapMetadata;
  if (v.revoked !== undefined && typeof v.revoked !== "boolean") return false;
  if (!validKey(id, v.publicKey) || !tailnetIP(v.sourceIP) || !["linux", "darwin", "windows"].includes(v.os) || typeof v.username !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/.test(v.username)) return false;
  try { const target = validateTarget(v.target); const host = target.destination.slice(v.username.length + 1); return target.destination.startsWith(v.username + "@") && tailnetIP(host) && target.port === 22 && !target.identity_file && isIP(host) === isIP(v.sourceIP); } catch { return false; }
}

/** Fixed, post-authentication cleanup. Never downloads code or stops SSH, Ovis, or herdr. */
export async function revokeBootstrap(ssh: Pick<SshConnection, "run" | "runPowerShell">, id: string, metadata: BootstrapMetadata, removeFirewall: boolean): Promise<void> {
  if (!validMetadata(id, metadata)) throw new Error("Invalid bootstrap registration");
  const line = `from="${metadata.sourceIP}",no-agent-forwarding,no-X11-forwarding,no-pty ${metadata.publicKey}`;
  if (metadata.os === "windows") {
    await ssh.runPowerShell(`$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$expected = Get-LocalUser -Name ${psQuote(metadata.username)} -ErrorAction Stop
if ($identity.User.Value -ne $expected.SID.Value) { throw 'SSH account does not match bootstrap account' }
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$admin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$member = @(Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction Stop | Where-Object { $_.SID.Value -eq $identity.User.Value }).Count -gt 0
if ((${removeFirewall ? "$true" : "$false"} -or $member) -and -not $admin) { throw 'Elevated SSH is required; no key was removed' }
$profile = Get-ItemProperty -LiteralPath ('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\' + $identity.User.Value) -ErrorAction Stop
$path = if ($member) { Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys' } else { Join-Path $profile.ProfileImagePath '.ssh\\authorized_keys' }
$ruleName = ${psQuote(`Ovis-SSH-${id}`)}
$rule = if (${removeFirewall ? "$true" : "$false"}) { @(Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue) } else { @() }
if ($rule.Count -gt 1) { throw 'Ambiguous firewall rule; no key was removed' }
if ($rule.Count -eq 1) {
  $filter = @($rule | Get-NetFirewallPortFilter)
  $address = @($rule | Get-NetFirewallAddressFilter)
  if ($rule[0].DisplayName -cne ${psQuote(`Ovis SSH ${id}`)} -or $rule[0].Description -cne ${psQuote(`Ovis bootstrap-v1 ${id}`)} -or $rule[0].Direction -ne 'Inbound' -or $rule[0].Action -ne 'Allow' -or $filter.Count -ne 1 -or $filter[0].LocalPort -ne '22' -or $filter[0].Protocol -ne 'TCP' -or $address.Count -ne 1 -or @($address[0].RemoteAddress).Count -ne 1 -or $address[0].RemoteAddress -ne ${psQuote(metadata.sourceIP)} -or @($address[0].LocalAddress).Count -ne 1 -or $address[0].LocalAddress -ne ${psQuote(metadata.target.destination.slice(metadata.username.length + 1))}) { throw 'Firewall rule ownership cannot be proved; no key was removed' }
}
$stream = $null
if (Test-Path -LiteralPath $path) {
  $component = [IO.Path]::GetFullPath($path)
  while ($component) {
    $item = Get-Item -Force -LiteralPath $component -ErrorAction Stop
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe authorized keys path; no key was removed' }
    $parent = Split-Path -Parent $component
    if ($parent -eq $component) { break }; $component = $parent
  }
  $links = @(fsutil hardlink list $path)
  if ($LASTEXITCODE -ne 0 -or $links.Count -ne 1) { throw 'Unsafe authorized keys links; no key was removed' }
  $owner = (Get-Acl -LiteralPath $path).GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($owner -ne $identity.User.Value -and (-not $member -or $owner -notin @('S-1-5-18', 'S-1-5-32-544'))) { throw 'Unexpected authorized keys owner; no key was removed' }
  # Hold an exclusive account-file handle from fresh read through final write.
  # Concurrent Ovis updates fail closed instead of resurrecting revoked keys.
  $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
}
try {
  if ($null -ne $stream) {
    $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $true, 1024, $true)
    try { $contents = $reader.ReadToEnd() } finally { $reader.Dispose() }
    $lines = @($contents -split '\\r?\\n')
    if ($lines.Count -gt 0 -and $lines[-1] -ceq '') { $lines = @($lines | Select-Object -SkipLast 1) }
    $kept = @($lines | Where-Object { $_ -cne ${psQuote(line)} })
  }
  if ($rule.Count -eq 1) { $rule | Remove-NetFirewallRule -ErrorAction Stop }
  if ($null -ne $stream -and $kept.Count -ne $lines.Count) {
    $text = if ($kept.Count) { ($kept -join "\`n") + "\`n" } else { '' }
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($text)
    $stream.Position = 0; $stream.SetLength(0); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush()
  }
} finally { if ($null -ne $stream) { $stream.Dispose() } }
Write-Output 'ovis-bootstrap-revoked'`);
  } else {
    await ssh.run(`set -eu
[ "$(id -un)" = ${shellQuote(metadata.username)} ] || { printf '%s\\n' 'SSH account does not match bootstrap account' >&2; exit 1; }
if command -v getent >/dev/null 2>&1; then
  home=$(getent passwd ${shellQuote(metadata.username)} | cut -d: -f6)
else
  home=$(dscl . -read ${shellQuote(`/Users/${metadata.username}`)} NFSHomeDirectory | cut -d' ' -f2-)
fi
[ -n "$home" ] && [ "$home" = "$HOME" ] || exit 1
component="$HOME"
while [ "$component" != / ]; do [ ! -L "$component" ] || exit 1; component=\${component%/*}; [ -n "$component" ] || component=/; done
[ ! -L "$HOME/.ssh" ] && [ ! -L "$HOME/.ssh/authorized_keys" ] || exit 1
[ -O "$HOME" ] && [ -O "$HOME/.ssh" ] || exit 1
file="$HOME/.ssh/authorized_keys"
lock="$HOME/.ssh/.ovis-authorized-keys.lock"
umask 077
mkdir "$lock" || { printf '%s\\n' 'Another Ovis key update is running; retry after it finishes' >&2; exit 1; }
temp=
trap '[ -z "$temp" ] || rm -f "$temp"; rmdir "$lock"' EXIT HUP INT TERM
[ ! -L "$HOME/.ssh" ] && [ ! -L "$file" ] || exit 1
if [ -e "$file" ]; then
  [ -f "$file" ] && [ -O "$file" ] && [ -w "$file" ] || exit 1
  links=$(stat -c '%h' "$file" 2>/dev/null || stat -f '%l' "$file")
  [ "$links" = 1 ] || exit 1
  temp=$(mktemp "$HOME/.ssh/ovis-revoke.XXXXXXXX")
  line=${shellQuote(line)}
  while IFS= read -r row || [ -n "$row" ]; do [ "$row" = "$line" ] || printf '%s\\n' "$row"; done < "$file" > "$temp"
  chmod 600 "$temp"
  mv -f "$temp" "$file"
fi
printf '%s\\n' 'ovis-bootstrap-revoked'`);
  }
}
