import { describe, expect, it } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { DIRECT_HTTP_TTL_MS, DIRECT_TICKET_TTL_MS, DIRECT_TRUST_TTL_MS, directApiPath, normalizeDirectOrigin, type DirectClaims } from "../shared/direct.ts";
import { DirectAuthority, DirectSigner } from "./direct-auth.ts";

const ORIGIN = "https://broker.example";
const fields = { aud: "pc-one", sub: "device-one", origin: ORIGIN, role: "interact", kind: "ws" } as const;

function fixture() {
  let now = 1_000_000;
  const signer = new DirectSigner();
  const authority = new DirectAuthority(() => now);
  authority.register(signer.trust(fields.aud, [ORIGIN], now));
  return { signer, authority, now: () => now, advance: (ms: number) => { now += ms; } };
}

// All signing keys, clocks and claims here are local; there is no server or herdr connection.
describe("direct credentials", () => {
  it("accepts only secure/loopback origins and literal non-admin API paths", () => {
    for (const [input, output] of [[`${ORIGIN}/`, ORIGIN], ["http://localhost:8080/", "http://localhost:8080"],
      ["http://127.12.0.3:8080", "http://127.12.0.3:8080"], ["http://[::1]:8080/", "http://[::1]:8080"]]) {
      expect(normalizeDirectOrigin(input)).toBe(output!);
    }
    for (const input of [null, "null", "*", "https://*.example", `${ORIGIN}/path`, `${ORIGIN}/..`, `${ORIGIN}/?`, `${ORIGIN}/#`,
      "https://user@broker.example", "http://192.168.1.1", "http://127.1", "http://2130706433", "http://0177.0.0.1", "https://broker.example\\evil", ` ${ORIGIN}`]) {
      expect(() => normalizeDirectOrigin(input)).toThrow();
    }
    for (const path of ["session", "pane/conversation/image", "pane/prompt/answer", "workspace/diff/refs", "fs/file", "plugin/action"]) expect(directApiPath(`/api/${path}`)).toBe(true);
    for (const path of ["/api/auth", "/api/machines", "/api/machines/setup", "/api/update", "/api/direct/trust", "/api//session", "/api/session/",
      "/api/../api/session", "/api/./session", "/api/pane%2fread", "/api/pane%5cread", "/api/%73ession", "/api/session?x=1"]) expect(directApiPath(path)).toBe(false);
  });

  it("binds tickets to audience, exact Origin and kind, and consumes only a valid WS ticket", () => {
    const f = fixture();
    try {
      const { token } = f.signer.issue(fields, f.now());
      expect(f.authority.verify(f.signer.issue({ ...fields, aud: "pc-two" }, f.now()).token, "ws", ORIGIN)).toBeNull();
      for (const origin of [null, "null", "https://other.example", `${ORIGIN}/`]) expect(f.authority.verify(token, "ws", origin)).toBeNull();
      expect(f.authority.verify(token, "http", ORIGIN)).toBeNull();
      const [payload, signature] = token.split(".") as [string, string];
      const changed = JSON.parse(Buffer.from(payload, "base64url").toString()) as DirectClaims;
      changed.sub = "another-device";
      expect(f.authority.verify(`${Buffer.from(JSON.stringify(changed)).toString("base64url")}.${signature}`, "ws", ORIGIN)).toBeNull();
      expect(f.authority.verify(`${payload}=.${signature}`, "ws", ORIGIN)).toBeNull();
      expect(f.authority.verify(`${token}.extra`, "ws", ORIGIN)).toBeNull();
      expect(f.authority.verify("a".repeat(8193), "ws", ORIGIN)).toBeNull();
      expect(f.authority.verify(token, "ws", ORIGIN)).toMatchObject(fields);
      expect(f.authority.verify(token, "ws", ORIGIN)).toBeNull();
    } finally { f.authority.stop(); }
  });

  it("reuses HTTP tokens only until expiry and answers explicit credential-free CORS", () => {
    const f = fixture();
    try {
      const token = f.signer.issue({ ...fields, kind: "http", role: "observe" }, f.now());
      expect(token.expires_at).toBe(f.now() + DIRECT_HTTP_TTL_MS);
      expect(f.authority.verify(token.token, "http", ORIGIN)?.role).toBe("observe");
      expect(f.authority.verify(token.token, "http", ORIGIN)?.role).toBe("observe");
      expect(f.authority.verify(token.token, "ws", ORIGIN)).toBeNull();
      const headers = f.authority.corsHeaders(ORIGIN)!;
      expect(headers.get("access-control-allow-origin")).toBe(ORIGIN);
      expect(headers.get("vary")).toBe("Origin");
      expect(headers.get("access-control-allow-methods")).toBe("GET, HEAD, POST, PATCH, DELETE, PUT, OPTIONS");
      expect(headers.get("access-control-allow-headers")).toContain("authorization");
      expect(headers.get("access-control-expose-headers")).toContain("content-range");
      expect(headers.has("access-control-allow-credentials")).toBe(false);
      expect(f.authority.corsHeaders(null)).toBeNull();
      expect(f.authority.corsHeaders("https://untrusted.example")).toBeNull();
      f.advance(DIRECT_HTTP_TTL_MS);
      expect(f.authority.verify(token.token, "http", ORIGIN)).toBeNull();
    } finally { f.authority.stop(); }
  });

  it("revokes a subject across audiences, including refresh and broker reconnection", () => {
    const f = fixture();
    let closed = 0;
    try {
      f.authority.register(f.signer.trust("pc-two", [ORIGIN], f.now()));
      const first = f.authority.verify(f.signer.issue(fields, f.now()).token, "ws", ORIGIN)!;
      const second = f.authority.verify(f.signer.issue({ ...fields, aud: "pc-two" }, f.now()).token, "ws", ORIGIN)!;
      f.authority.onRevoke(first, () => { closed++; });
      f.authority.onRevoke(second, () => { closed++; });
      f.authority.revoke(f.signer.issuer, fields.sub);
      expect(closed).toBe(2);
      f.advance(10_000);
      f.authority.register(f.signer.trust(fields.aud, [ORIGIN], f.now()));
      f.authority.remove(f.signer.issuer);
      f.authority.register(f.signer.trust("pc-two", [ORIGIN], f.now()));
      f.advance(DIRECT_TRUST_TTL_MS - 10_000);
      // Past the original lease, but not the refreshed one: the revocation still applies.
      f.authority.register(f.signer.trust(fields.aud, [ORIGIN], f.now()));
      for (const aud of [fields.aud, "pc-two"]) expect(f.authority.verify(f.signer.issue({ ...fields, aud }, f.now()).token, "ws", ORIGIN)).toBeNull();
      f.authority.onRevoke(first, () => { closed++; });
      expect(closed).toBe(3);
      expect(f.authority.verify(f.signer.issue({ ...fields, sub: "other-device" }, f.now()).token, "ws", ORIGIN)).not.toBeNull();
    } finally { f.authority.stop(); }
  });

  it("keeps live WS past ticket expiry but closes at trust expiry", () => {
    const f = fixture();
    let closed = 0;
    try {
      const issued = f.signer.issue(fields, f.now());
      expect(issued.expires_at).toBe(f.now() + DIRECT_TICKET_TTL_MS);
      const claims = f.authority.verify(issued.token, "ws", ORIGIN)!;
      f.authority.onRevoke(claims, () => { closed++; });
      f.advance(DIRECT_TICKET_TTL_MS);
      f.authority.prune();
      expect(closed).toBe(0);
      expect(f.authority.verify(issued.token, "ws", ORIGIN)).toBeNull();
      f.advance(DIRECT_TRUST_TTL_MS - DIRECT_TICKET_TTL_MS);
      f.authority.prune();
      expect(closed).toBe(1);
      expect(f.authority.allowedOrigin(ORIGIN)).toBe(false);
      f.authority.onRevoke(claims, () => { closed++; });
      expect(closed).toBe(2);
    } finally { f.authority.stop(); }
  });

  it("unsubscribes tracked connections and closes others on removal, policy change or stop", () => {
    const f = fixture();
    let closed = 0;
    try {
      const claims = f.authority.verify(f.signer.issue(fields, f.now()).token, "ws", ORIGIN)!;
      const unwatch = f.authority.onRevoke(claims, () => { closed += 100; });
      unwatch();
      f.authority.onRevoke(claims, () => { closed++; });
      f.authority.register(f.signer.trust(fields.aud, ["https://other.example"], f.now()));
      expect(closed).toBe(1);
      f.authority.register(f.signer.trust(fields.aud, [ORIGIN], f.now()));
      f.authority.onRevoke(claims, () => { closed++; });
      f.authority.remove(f.signer.issuer);
      expect(closed).toBe(2);
      f.authority.register(f.signer.trust(fields.aud, [ORIGIN], f.now()));
      f.authority.onRevoke(claims, () => { closed++; });
      f.authority.stop();
      expect(closed).toBe(3);
      expect(f.authority.verify(f.signer.issue(fields, f.now()).token, "ws", ORIGIN)).toBeNull();
    } finally { f.authority.stop(); }
  });

  it("rejects invalid trust keys, TTL types and policy overflow without replacing good trust", () => {
    const f = fixture();
    try {
      const trust = f.signer.trust(fields.aud, [ORIGIN], f.now());
      const otherKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "pem" }).toString();
      for (const patch of [{ public_key: otherKey }, { public_key: "invalid" }, { expires_at: String(trust.expires_at) },
        { expires_at: f.now() + DIRECT_TRUST_TTL_MS + 1 }, { expires_at: f.now() }, { expires_at: Infinity },
        { expires_at: trust.expires_at + 0.5 }, { origins: ["http://lan.example"] }, { origins: [] }, { issuer: "" }, { extra: true }]) {
        expect(() => f.authority.register({ ...trust, ...patch })).toThrow();
      }
      const replacement = new DirectSigner().trust(fields.aud, [ORIGIN], f.now());
      expect(() => f.authority.register({ ...replacement, issuer: f.signer.issuer })).toThrow();
      for (let i = 1; i < 128; i++) f.authority.register(f.signer.trust(`pc-${i}`, [ORIGIN], f.now()));
      expect(() => f.authority.register(f.signer.trust("overflow", [ORIGIN], f.now()))).toThrow();
      expect(f.authority.verify(f.signer.issue(fields, f.now()).token, "ws", ORIGIN)).not.toBeNull();
    } finally { f.authority.stop(); }
  });

  it("rejects correctly signed malformed claims and never evicts unexpired cache tombstones", () => {
    const f = fixture();
    try {
      const keys = generateKeyPairSync("ed25519");
      f.authority.register({ ...f.signer.trust("pc-malformed", [ORIGIN], f.now()), issuer: "local-test-issuer",
        public_key: keys.publicKey.export({ type: "spki", format: "pem" }).toString() });
      const claims = { ...fields, v: 1, aud: "pc-malformed", iss: "local-test-issuer", iat: f.now(), exp: f.now() + DIRECT_TICKET_TTL_MS, jti: "local-jti" };
      for (const patch of [{ v: 2 }, { iat: String(f.now()) }, { exp: String(claims.exp) }, { exp: claims.exp + 1 }, { exp: claims.exp + 0.5 },
        { iat: f.now() + 1 }, { iat: -1 }, { role: "admin" }, { kind: "other" }, { jti: "" }, { extra: true }]) {
        const payload = Buffer.from(JSON.stringify({ ...claims, ...patch })).toString("base64url");
        const token = `${payload}.${sign(null, Buffer.from(payload), keys.privateKey).toString("base64url")}`;
        expect(f.authority.verify(token, "ws", ORIGIN)).toBeNull();
      }
      // Revocations fill the shared bounded cache; no token may displace one to gain admission.
      for (let i = 0; i < 4096; i++) f.authority.revoke(f.signer.issuer, `revoked-${i}`);
      const denied = f.signer.issue(fields, f.now()).token;
      expect(f.authority.verify(denied, "ws", ORIGIN)).toBeNull();
      f.authority.revoke(f.signer.issuer, fields.sub); // overflow fails closed, including reusable HTTP
      f.authority.register(f.signer.trust(fields.aud, [ORIGIN], f.now()));
      expect(f.authority.verify(f.signer.issue({ ...fields, kind: "http" }, f.now()).token, "http", ORIGIN)).toBeNull();
    } finally { f.authority.stop(); }
  });
});
