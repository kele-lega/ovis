import { BootstrapError } from "./ssh-bootstrap.ts";
import type { MachineManager } from "./machines.ts";
import { sameOrigin } from "./machine-security.ts";
import { isJsonObject, jsonResponse, setRequestRoute } from "./http.ts";
import { updateRequestAllowed } from "./update-api.ts";
import { readTailnetPeers } from "./tailnet-peers.ts";

/** Called after authentication, before the generic machine routes. Never handles SSH credentials in the browser. */
export async function handleMachineBootstrapRequest(request: Request, manager: MachineManager, readOnly: boolean, owner: boolean): Promise<Response | null> {
  const url = new URL(request.url);
  const bootstrapRoute = url.pathname === "/api/machines/bootstrap" || url.pathname.startsWith("/api/machines/bootstrap/") || /^\/api\/machines\/[^/]+\/revoke-bootstrap$/.test(url.pathname);
  if (bootstrapRoute) {
    const respond = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });
    const refuse = (code: string, message: string, status: number) => respond({ error: { code, message } }, status);
    if (!sameOrigin(request)) return refuse("invalid_origin", "Use PC controls from this app", 403);
    if (readOnly) return refuse("read_only", "this device can only watch", 403);
    if (request.headers.get("x-herdr-machine") !== "1") return refuse("invalid_machine_request", "Use PC controls from this app", 403);
    if (url.pathname.includes("//") || url.pathname.endsWith("/") || /%2f|%5c/i.test(url.pathname)) return refuse("not_found", "not found", 404);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !(owner && updateRequestAllowed(request))) return refuse("forbidden", "Only the owner can change this PC's PCs, from this app's own page.", 403);
    const parts = url.pathname.slice("/api/machines/".length).split("/");
    try {
      const body = async (): Promise<unknown> => {
        // Bootstrap control bodies contain no uploads; bound them before JSON parsing.
        if (Number(request.headers.get("content-length")) > 4096) throw new BootstrapError("invalid_body", "Expected bootstrap details");
        if (!request.body) return {};
        const reader = request.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
        try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 4096) { await reader.cancel(); throw new BootstrapError("invalid_body", "Expected bootstrap details"); } chunks.push(value); } }
        finally { reader.releaseLock(); }
        if (!size) return {};
        try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new BootstrapError("invalid_body", "Expected bootstrap details"); }
      };
      if (parts[0] === "bootstrap") {
        if (parts.length === 1) {
          setRequestRoute("/api/machines/bootstrap");
          if (request.method !== "POST") return refuse("method_not_allowed", "Use POST", 405);
          return respond(await manager.createBootstrap(await body(), request.signal), 201);
        }
        if (parts.length === 2) {
          setRequestRoute("/api/machines/bootstrap/:attempt_id");
          if (request.method === "GET") return respond(manager.bootstrapAttempt(parts[1]!));
          if (request.method === "DELETE") { await manager.cancelBootstrap(parts[1]!); return respond({ ok: true }); }
          return refuse("method_not_allowed", "Use GET or DELETE", 405);
        }
        if (parts.length === 3 && parts[2] === "connect") {
          setRequestRoute("/api/machines/bootstrap/:attempt_id/connect");
          if (request.method !== "POST") return refuse("method_not_allowed", "Use POST", 405);
          const value = await body();
          if (!isJsonObject(value) || Object.keys(value).some((key) => key !== "update_remote") || value.update_remote !== undefined && typeof value.update_remote !== "boolean") return refuse("invalid_body", "Expected bootstrap connection details", 400);
          return respond(manager.connectBootstrap(parts[1]!, value.update_remote === true), 202);
        }
      } else if (parts.length === 2 && parts[1] === "revoke-bootstrap") {
        setRequestRoute("/api/machines/:machine_id/revoke-bootstrap");
        if (request.method !== "POST") return refuse("method_not_allowed", "Use POST", 405);
        const value = await body();
        if (!isJsonObject(value) || Object.keys(value).some((key) => key !== "remove_firewall") || value.remove_firewall !== undefined && typeof value.remove_firewall !== "boolean") return refuse("invalid_body", "Expected bootstrap revocation details", 400);
        await manager.revokeBootstrap(parts[0]!, value.remove_firewall === true); return respond({ ok: true });
      }
      return refuse("not_found", "Unknown PC endpoint", 404);
    } catch (error) {
      if (error instanceof BootstrapError) return refuse(error.code, error.message, error.status);
      return refuse("machine_request_failed", "The SSH bootstrap request could not be completed", 400);
    }
  }
  if (url.pathname === "/api/machines/setups" || url.pathname === "/api/machines/tailnet" && url.searchParams.get("ssh_bootstrap") === "1") {
    const respond = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });
    const refuse = (code: string, message: string, status: number) => respond({ error: { code, message } }, status);
    if (!sameOrigin(request)) return refuse("invalid_origin", "Use PC controls from this app", 403);
    if (request.headers.get("x-herdr-machine") !== "1") return refuse("invalid_machine_request", "Use PC controls from this app", 403);
    if (request.method !== "GET") return refuse("method_not_allowed", "Use GET", 405);
    if (url.pathname.endsWith("/setups")) { setRequestRoute("/api/machines/setups"); return respond({ setups: manager.setupSummaries() }); }
    if (readOnly) return refuse("read_only", "this device can only watch", 403);
    setRequestRoute("/api/machines/tailnet");
    return respond(await readTailnetPeers(manager.list()));
  }
  return null;
}
