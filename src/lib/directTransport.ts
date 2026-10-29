import { DIRECT_PROTOCOL, DIRECT_TICKET_PREFIX, directApiPath, normalizeDirectOrigin, type DirectCredentialResponse } from "../../shared/direct.ts";
import { LOCAL_MACHINE } from "../../shared/machines.ts";
import type { SocketEndpointResolver } from "./ws.ts";

const COOLDOWN_MS = 60_000;
/** Leave time for the relay handshake within HerdrSocket's initial 8s connect deadline. */
const AUTHORIZATION_TIMEOUT_MS = 5_000;
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type HttpCredential = Omit<DirectCredentialResponse, "ticket">;
interface PendingCredential {
  controller: AbortController;
  promise: Promise<HttpCredential | null>;
  users: number;
}
interface MachineTransport {
  http?: HttpCredential;
  pending?: PendingCredential;
  unavailableUntil: number;
  failedUntil: number;
}
interface DirectTransportOptions {
  fetch?: Fetch;
  now?: () => number;
  origin?: () => string;
}

function browserOrigin(): string {
  return typeof window !== "undefined" ? window.location.origin : typeof location !== "undefined" ? location.origin : "http://localhost";
}
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}
function checkAbort(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw abortReason(signal);
}
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
/** Also rejects when a fetch implementation ignores cancellation (including late sign-out responses). */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(abortReason(signal));
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    if (signal.aborted) aborted();
  });
}

/** Credentials are memory-only and scoped to one PC. HTTP shares tokens, never single-use WS tickets. */
export class DirectTransport {
  private readonly machines = new Map<string, MachineTransport>();
  private readonly controllers = new Set<AbortController>();
  private readonly fetcher: Fetch;
  private readonly now: () => number;
  private readonly origin: () => string;

  constructor(options: DirectTransportOptions = {}) {
    this.fetcher = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.now = options.now ?? Date.now;
    this.origin = options.origin ?? browserOrigin;
  }

  clear(): void {
    this.machines.clear();
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }

  private state(machineId: string): MachineTransport {
    let state = this.machines.get(machineId);
    if (!state) {
      state = { unavailableUntil: 0, failedUntil: 0 };
      this.machines.set(machineId, state);
    }
    return state;
  }

  private coolingDown(state: MachineTransport): boolean {
    return Math.max(state.unavailableUntil, state.failedUntil) > this.now();
  }

  private async issue(machineId: string, state: MachineTransport, signal: AbortSignal): Promise<DirectCredentialResponse | null> {
    try {
      checkAbort(signal);
      const response = await this.fetcher(`/api/machines/${encodeURIComponent(machineId)}/direct-access`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-herdr-machine": "1" },
        body: "{}",
        credentials: "same-origin",
        cache: "no-store",
        signal,
      });
      checkAbort(signal);
      if (!response.ok) {
        if ([404, 401, 403].includes(response.status)) state.unavailableUntil = this.now() + COOLDOWN_MS;
        return null;
      }
      const value: unknown = await response.json();
      checkAbort(signal);
      if (this.machines.get(machineId) !== state) throw new DOMException("Transport cleared", "AbortError");
      if (!value || typeof value !== "object") return null;
      const credential = value as DirectCredentialResponse;
      const validToken = (token: unknown): token is string => typeof token === "string" && token.length > 0 && token.length <= 8192 && !/\s/.test(token);
      if (!validToken(credential.ticket) || !validToken(credential.access_token)
        || !Number.isFinite(credential.expires_at) || credential.expires_at <= this.now() || credential.expires_at > this.now() + COOLDOWN_MS) return null;
      const origin = normalizeDirectOrigin(credential.origin);
      const http = { origin, access_token: credential.access_token, expires_at: credential.expires_at };
      state.http = http;
      return { ...http, ticket: credential.ticket };
    } catch (error) {
      checkAbort(signal);
      if (isAbort(error)) throw error;
      return null;
    }
  }

  private async httpCredential(machineId: string, state: MachineTransport, signal?: AbortSignal | null): Promise<HttpCredential | null> {
    checkAbort(signal);
    if (state.http && state.http.expires_at > this.now()) return state.http;
    let pending = state.pending;
    if (!pending || pending.controller.signal.aborted) {
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(new DOMException("Direct authorization timed out", "TimeoutError")), AUTHORIZATION_TIMEOUT_MS);
      this.controllers.add(controller);
      pending = {
        controller, users: 0,
        // Discard the ticket immediately. An HTTP reader cannot consume a later WS connect's ticket.
        promise: abortable(this.issue(machineId, state, controller.signal), controller.signal)
          .catch((error) => { if (error instanceof Error && error.name === "TimeoutError") return null; throw error; })
          .then((credential) => credential ? { origin: credential.origin, access_token: credential.access_token, expires_at: credential.expires_at } : null)
          .finally(() => clearTimeout(deadline)),
      };
      state.pending = pending;
    }
    const active = pending;
    active.users++;
    try {
      return await (signal ? abortable(active.promise, signal) : active.promise);
    } finally {
      active.users--;
      if (active.users === 0) {
        active.controller.abort();
        this.controllers.delete(active.controller);
        if (state.pending === active) state.pending = undefined;
      }
    }
  }

  resolveMachineSocket(machineId: string): SocketEndpointResolver {
    return async (signal) => {
      checkAbort(signal);
      const relay = new URL("/ws", this.origin());
      relay.protocol = relay.protocol === "https:" ? "wss:" : "ws:";
      relay.searchParams.set("machine_id", machineId);
      if (machineId === LOCAL_MACHINE) return { url: relay.href };
      const state = this.state(machineId);
      if (this.coolingDown(state)) return { url: relay.href };
      const controller = new AbortController();
      const cancel = () => controller.abort(abortReason(signal));
      signal.addEventListener("abort", cancel, { once: true });
      this.controllers.add(controller);
      const timeout = new DOMException("Direct authorization timed out", "TimeoutError");
      const deadline = setTimeout(() => controller.abort(timeout), AUTHORIZATION_TIMEOUT_MS);
      try {
        const credential = await abortable(this.issue(machineId, state, controller.signal), controller.signal);
        checkAbort(signal);
        checkAbort(controller.signal);
        if (!credential) return { url: relay.href };
        const direct = new URL("/ws", credential.origin);
        direct.protocol = direct.protocol === "https:" ? "wss:" : "ws:";
        return {
          url: direct.href,
          protocols: [DIRECT_PROTOCOL, `${DIRECT_TICKET_PREFIX}${credential.ticket}`],
          opened: () => {
            if (this.machines.get(machineId) === state) state.failedUntil = 0;
          },
          failed: () => {
            if (this.machines.get(machineId) !== state) return;
            state.failedUntil = this.now() + COOLDOWN_MS;
            state.http = undefined;
          },
        };
      } catch (error) {
        // Only our deadline falls back. Caller cancellation and sign-out must still reject.
        checkAbort(signal);
        if (error !== timeout || this.machines.get(machineId) !== state) throw error;
        state.failedUntil = this.now() + COOLDOWN_MS;
        state.http = undefined;
        return { url: relay.href };
      } finally {
        clearTimeout(deadline);
        signal.removeEventListener("abort", cancel);
        this.controllers.delete(controller);
      }
    };
  }

  async directFetch(url: string, init?: RequestInit): Promise<Response> {
    checkAbort(init?.signal);
    const target = new URL(url, this.origin());
    const match = /^\/api\/machines\/([^/]+)\/(.+)$/.exec(target.pathname);
    // Do not normalize a noncanonical path into a direct-capable one.
    const rawPath = /^(?:https?:\/\/[^/?#]+)?(\/[^?#]*)/.exec(url)?.[1];
    if (target.origin !== this.origin() || rawPath !== target.pathname || !match || !directApiPath(`/api/${match[2]}`)) return this.fetcher(url, init);
    let machineId: string;
    try { machineId = decodeURIComponent(match[1]!); } catch { return this.fetcher(url, init); }
    if (machineId === LOCAL_MACHINE || encodeURIComponent(machineId) !== match[1]) return this.fetcher(url, init);
    const state = this.state(machineId);
    if (this.coolingDown(state)) return this.fetcher(url, init);
    const credential = await this.httpCredential(machineId, state, init?.signal);
    checkAbort(init?.signal);
    if (this.machines.get(machineId) !== state) throw new DOMException("Transport cleared", "AbortError");
    if (!credential) return this.fetcher(url, init);
    const headers = new Headers(init?.headers);
    for (const name of ["cookie", "cookie2", "authorization", "proxy-authorization"]) headers.delete(name);
    headers.set("authorization", `Bearer ${credential.access_token}`);
    const direct = new URL(`/api/${match[2]}`, credential.origin);
    direct.search = target.search;
    const safe = ["GET", "HEAD"].includes((init?.method ?? "GET").toUpperCase());
    let response: Response;
    try {
      response = await this.fetcher(direct.href, { ...init, headers, credentials: "omit", redirect: "error", cache: "no-store" });
      checkAbort(init?.signal);
    } catch (error) {
      checkAbort(init?.signal);
      if (isAbort(error) || this.machines.get(machineId) !== state) throw error;
      state.failedUntil = this.now() + COOLDOWN_MS;
      state.http = undefined;
      if (!safe) throw error; // A write may already have reached B; never replay it through A.
      return this.fetcher(url, init);
    }
    if (response.status === 401) {
      if (state.http?.access_token === credential.access_token) state.http = undefined;
      if (safe && this.machines.get(machineId) === state) return this.fetcher(url, init);
    }
    return response;
  }
}

const transports = new DirectTransport();
export function resolveMachineSocket(machineId: string): SocketEndpointResolver { return transports.resolveMachineSocket(machineId); }
export function directFetch(url: string, init?: RequestInit): Promise<Response> { return transports.directFetch(url, init); }
export function clearDirectTransports(): void { transports.clear(); }
