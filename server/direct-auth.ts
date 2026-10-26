import { createPublicKey, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import { DIRECT_HTTP_TTL_MS, DIRECT_TICKET_TTL_MS, DIRECT_TRUST_TTL_MS, normalizeDirectOrigin, type DirectClaims, type DirectKind, type DirectTrust } from "../shared/direct.ts";

const MAX_POLICIES = 128;
const MAX_CACHE = 4096;
const MAX_TOKEN = 8192;
const TRUST_KEYS = ["issuer", "audience", "public_key", "origins", "expires_at"];
const CLAIM_KEYS = ["v", "iss", "aud", "sub", "origin", "role", "kind", "iat", "exp", "jti"];
const scope = (...parts: string[]): string => JSON.stringify(parts);
const text = (value: unknown, max = 256): value is string => typeof value === "string" && value.length > 0
  && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const ttl = (kind: DirectKind): number => kind === "ws" ? DIRECT_TICKET_TTL_MS : DIRECT_HTTP_TTL_MS;

function canonicalOrigin(value: unknown): value is string {
  try { return normalizeDirectOrigin(value) === value; } catch { return false; }
}

function validClaims(value: unknown, now: number): value is DirectClaims {
  if (!record(value) || !exactKeys(value, CLAIM_KEYS)) return false;
  return value.v === 1 && text(value.iss) && text(value.aud) && text(value.sub) && text(value.jti)
    && canonicalOrigin(value.origin) && (value.role === "interact" || value.role === "observe")
    && (value.kind === "ws" || value.kind === "http")
    && typeof value.iat === "number" && Number.isSafeInteger(value.iat) && value.iat >= 0 && value.iat <= now
    && typeof value.exp === "number" && Number.isSafeInteger(value.exp) && value.exp > now
    && value.exp > value.iat && value.exp - value.iat <= ttl(value.kind);
}

/** Ephemeral process identity: no persistent private key and no negotiable signing algorithm. */
export class DirectSigner {
  readonly issuer = randomUUID();
  readonly publicKey: string;
  private readonly privateKey: KeyObject;

  constructor() {
    const keys = generateKeyPairSync("ed25519");
    this.privateKey = keys.privateKey;
    this.publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  }

  trust(audience: string, origins: readonly string[], now = Date.now()): DirectTrust {
    if (!text(audience) || !Array.isArray(origins) || origins.length === 0 || origins.length > MAX_POLICIES
      || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + DIRECT_TRUST_TTL_MS)) throw new Error("Invalid direct trust");
    return { issuer: this.issuer, audience, public_key: this.publicKey, origins: [...new Set(Array.from(origins, normalizeDirectOrigin))], expires_at: now + DIRECT_TRUST_TTL_MS };
  }

  issue(fields: Pick<DirectClaims, "aud" | "sub" | "origin" | "role" | "kind">, now = Date.now()): { token: string; expires_at: number } {
    const claims: DirectClaims = { v: 1, iss: this.issuer, aud: fields.aud, sub: fields.sub, origin: normalizeDirectOrigin(fields.origin),
      role: fields.role, kind: fields.kind, iat: now, exp: now + ttl(fields.kind), jti: randomUUID() };
    if (!Number.isSafeInteger(now) || !validClaims(claims, now)) throw new Error("Invalid direct claims");
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = sign(null, Buffer.from(payload), this.privateKey).toString("base64url");
    return { token: `${payload}.${signature}`, expires_at: claims.exp };
  }
}

type Policy = { issuer: string; audience: string; publicKey: string; key: KeyObject; origins: Set<string>; expiresAt: number };
type Revocation = { issuer: string; expiresAt: number };
type Watcher = { claims: DirectClaims; publicKey: string; close: () => void };

export class DirectAuthority {
  private readonly policies = new Map<string, Policy>();
  private readonly used = new Map<string, number>();
  private readonly revoked = new Map<string, Revocation>();
  private readonly watchers = new Set<Watcher>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  // If a revocation cannot fit, deny everything rather than dropping a live tombstone.
  private saturatedUntil = 0;

  constructor(private readonly now: () => number = Date.now) {}

  register(value: unknown): void {
    this.prune();
    const now = this.now();
    if (this.stopped || !record(value) || !exactKeys(value, TRUST_KEYS) || !text(value.issuer) || !text(value.audience)
      || typeof value.public_key !== "string" || value.public_key.length === 0 || value.public_key.length > 1024
      || !Array.isArray(value.origins) || value.origins.length === 0 || value.origins.length > MAX_POLICIES
      || typeof value.expires_at !== "number" || !Number.isSafeInteger(value.expires_at)
      || value.expires_at <= now || value.expires_at > now + DIRECT_TRUST_TTL_MS) throw new Error("Invalid direct trust");
    const origins = new Set(Array.from(value.origins, normalizeDirectOrigin));
    let key: KeyObject;
    try {
      if (!value.public_key.startsWith("-----BEGIN PUBLIC KEY-----")) throw new Error("Expected SPKI");
      key = createPublicKey({ key: value.public_key, format: "pem", type: "spki" });
      if (key.asymmetricKeyType !== "ed25519" || key.export({ type: "spki", format: "pem" }).toString().trimEnd() !== value.public_key.replaceAll("\r\n", "\n").trimEnd()) throw new Error("Expected Ed25519 SPKI");
    } catch { throw new Error("Invalid direct public key"); }
    const id = scope(value.issuer, value.audience);
    if (!this.policies.has(id) && this.policies.size >= MAX_POLICIES) throw new Error("Too many direct trust policies");
    // One issuer is one process identity, even when it vouches for more than one audience.
    const publicKey = key.export({ type: "spki", format: "pem" }).toString();
    if ([...this.policies.values()].some((policy) => policy.issuer === value.issuer && policy.publicKey !== publicKey)) throw new Error("Direct issuer key changed");
    this.policies.set(id, { issuer: value.issuer, audience: value.audience, publicKey, key, origins, expiresAt: value.expires_at });
    // Refreshing any audience must not undo a device revocation for this issuer.
    for (const revoked of this.revoked.values()) if (revoked.issuer === value.issuer) revoked.expiresAt = Math.max(revoked.expiresAt, value.expires_at);
    if (this.saturatedUntil > now) this.saturatedUntil = Math.max(this.saturatedUntil, value.expires_at);
    this.prune();
  }

  revoke(issuer: string, subject: string): void {
    this.prune();
    const expiresAt = this.issuerExpiry(issuer);
    if (expiresAt > this.now()) {
      const id = scope(issuer, subject);
      if (this.revoked.has(id) || this.used.size + this.revoked.size < MAX_CACHE) this.revoked.set(id, { issuer, expiresAt });
      else this.saturatedUntil = Math.max(this.saturatedUntil, expiresAt, ...[...this.policies.values()].map((policy) => policy.expiresAt));
    }
    for (const watcher of [...this.watchers]) {
      if ((watcher.claims.iss === issuer && watcher.claims.sub === subject) || this.saturatedUntil > this.now()) this.close(watcher);
    }
  }

  /** The broker's connection disappearing removes every policy issued by it. */
  remove(issuer: string): void {
    for (const [id, policy] of this.policies) if (policy.issuer === issuer) this.policies.delete(id);
    for (const watcher of [...this.watchers]) if (watcher.claims.iss === issuer) this.close(watcher);
    // Replay/revocation tombstones survive removal, in case the same issuer reconnects.
    this.prune();
  }

  verify(token: string, kind: DirectKind, origin: string | null): DirectClaims | null {
    this.prune();
    const now = this.now();
    if (this.stopped || this.saturatedUntil > now || (kind !== "ws" && kind !== "http") || !canonicalOrigin(origin)
      || typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN) return null;
    try {
      const parts = token.split(".");
      if (parts.length !== 2) return null;
      const [payload, signature] = parts as [string, string];
      const decode = (part: string): Buffer | null => {
        if (!/^[A-Za-z0-9_-]+$/.test(part)) return null;
        const bytes = Buffer.from(part, "base64url");
        return bytes.toString("base64url") === part ? bytes : null;
      };
      const body = decode(payload);
      const sig = decode(signature);
      if (!body || !sig || sig.length !== 64) return null;
      const claims: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
      if (!validClaims(claims, now) || claims.kind !== kind || claims.origin !== origin) return null;
      const policy = this.policyFor(claims);
      if (!policy || !verify(null, Buffer.from(payload), policy.key, sig)) return null;
      if (kind === "ws") {
        const id = scope(claims.iss, claims.jti);
        if (this.used.has(id) || this.used.size + this.revoked.size >= MAX_CACHE) return null;
        // No await between testing and inserting: bad signatures/origins never consume a ticket.
        this.used.set(id, claims.exp);
      }
      return claims;
    } catch { return null; }
  }

  /** Ticket expiry gates the handshake only; the live connection follows its trust lease. */
  onRevoke(claims: DirectClaims, close: () => void): () => void {
    this.prune();
    const policy = this.policyFor(claims);
    if (!policy || this.watchers.size >= MAX_CACHE) { try { close(); } catch {} return () => {}; }
    const watcher: Watcher = { claims: { ...claims }, publicKey: policy.publicKey, close };
    this.watchers.add(watcher);
    return () => { this.watchers.delete(watcher); };
  }

  allowedOrigin(origin: string | null): boolean {
    this.prune();
    return !this.stopped && this.saturatedUntil <= this.now() && canonicalOrigin(origin)
      && [...this.policies.values()].some((policy) => policy.origins.has(origin));
  }

  corsHeaders(origin: string | null): Headers | null {
    if (!this.allowedOrigin(origin)) return null;
    return new Headers({
      "access-control-allow-origin": origin!,
      vary: "Origin",
      "access-control-allow-methods": "GET, HEAD, POST, PATCH, DELETE, PUT, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, x-herdr-machine, x-request-id, if-none-match, range",
      "access-control-expose-headers": "etag, content-range, accept-ranges, content-disposition, x-request-id, content-length, retry-after",
      "access-control-max-age": "600",
    });
  }

  prune(): void {
    const now = this.now();
    for (const [id, policy] of this.policies) if (policy.expiresAt <= now) this.policies.delete(id);
    for (const [id, expiry] of this.used) if (expiry <= now) this.used.delete(id);
    for (const [id, revoked] of this.revoked) if (revoked.expiresAt <= now) this.revoked.delete(id);
    if (this.saturatedUntil <= now) this.saturatedUntil = 0;
    for (const watcher of [...this.watchers]) {
      if (this.policyFor(watcher.claims)?.publicKey !== watcher.publicKey) this.close(watcher);
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.stopped && this.policies.size) {
      const next = Math.min(...[...this.policies.values()].map((policy) => policy.expiresAt));
      this.timer = setTimeout(() => this.prune(), Math.max(1, next - this.now()));
      this.timer.unref();
    }
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.policies.clear();
    for (const watcher of [...this.watchers]) this.close(watcher);
    this.used.clear();
    this.revoked.clear();
  }

  private issuerExpiry(issuer: string): number {
    let expiry = 0;
    for (const policy of this.policies.values()) if (policy.issuer === issuer) expiry = Math.max(expiry, policy.expiresAt);
    for (const revoked of this.revoked.values()) if (revoked.issuer === issuer) expiry = Math.max(expiry, revoked.expiresAt);
    return expiry;
  }

  private policyFor(claims: DirectClaims): Policy | undefined {
    if (this.stopped || this.saturatedUntil > this.now() || this.revoked.has(scope(claims.iss, claims.sub))) return undefined;
    const policy = this.policies.get(scope(claims.iss, claims.aud));
    return policy && policy.expiresAt > this.now() && policy.origins.has(claims.origin) ? policy : undefined;
  }

  private close(watcher: Watcher): void {
    if (!this.watchers.delete(watcher)) return;
    try { watcher.close(); } catch { /* One transport must not prevent the others from closing. */ }
  }
}
