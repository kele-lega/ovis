export const DIRECT_PROTOCOL = "ovis.v1";
export const DIRECT_TICKET_PREFIX = "ovis.ticket.";
export const DIRECT_TRUST_TTL_MS = 90_000;
export const DIRECT_TICKET_TTL_MS = 30_000;
export const DIRECT_HTTP_TTL_MS = 60_000;

export type DirectKind = "ws" | "http";

export interface DirectClaims {
  v: 1;
  iss: string;
  aud: string;
  sub: string;
  origin: string;
  role: "interact" | "observe";
  kind: DirectKind;
  /** Unix milliseconds, not JWT's seconds. */
  iat: number;
  exp: number;
  jti: string;
}

export interface DirectTrust {
  issuer: string;
  audience: string;
  public_key: string;
  origins: string[];
  expires_at: number;
}

export interface DirectCredentialResponse {
  origin: string;
  ticket: string;
  access_token: string;
  expires_at: number;
}

/** Configuration accepts an origin, never a URL to a resource or a wildcard. */
export function normalizeDirectOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || !/^https?:\/\/[^/?#]+\/?$/.test(value)
    || /[\s\\@%*\u0000-\u001f\u007f]/.test(value)) throw new Error("Invalid direct origin");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid direct origin"); }
  if (!url.hostname || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid direct origin");
  if (url.protocol === "http:") {
    // Do not let WHATWG's shorthand/octal/numeric IPv4 parsing turn another spelling into loopback.
    const authority = value.slice("http://".length).replace(/\/$/, "");
    const host = authority.startsWith("[") ? authority.slice(0, authority.indexOf("]") + 1) : authority.split(":")[0]!;
    if (host.toLowerCase() !== url.hostname || !(url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname))) throw new Error("HTTP direct origins must be loopback");
  }
  return url.origin;
}

// Keep in step with server/machine-api.ts MACHINE_PROXY_PATH. Broker/admin controls are not direct APIs.
const DIRECT_API_PATH = /^\/api\/(?:session|sessions\/(?:history|resume)|agents|integrations|pane\/(?:read|scroll|find|selection|conversation(?:\/image|\/tool-output)?|commands|files|omo-tasks|background-agent|plan|prompt|prompt\/answer|input|keys|close|rename|image|split|zoom|swap|resize|clear|focus)|workspace\/(?:create|rename|move|close|directories|diff\/files|diff\/file|diff\/refs)|worktree\/(?:create|list|open|remove)|tab\/(?:create|rename|close|move|move-to-workspace)|layout\/ratio|agent\/(?:rename|commands)|plugins\/actions|plugin\/action|fs\/(?:stat|file|favicon))$/;

export function directApiPath(pathname: string): boolean {
  // Reject before any decoding/normalization: only literal endpoint spellings are routes.
  return !/[\s\\%?#]/.test(pathname) && !pathname.includes("//") && !pathname.endsWith("/")
    && !pathname.split("/").some((part) => part === "." || part === "..") && DIRECT_API_PATH.test(pathname);
}
