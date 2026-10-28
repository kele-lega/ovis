import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleMachineRequest } from "./machine-api.ts";
import { MachineManager } from "./machines.ts";
import { CompletionTracker } from "./completion.ts";
import type { PushService } from "./push.ts";
import { createServer } from "./index.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ovis-bootstrap-contract-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  let reads = 0, generated = 0;
  const manager = new MachineManager(dir, {} as PushService, new CompletionTracker(null), async () => { throw new Error("fixture offline"); }, { bootstrap: {
    readStatus: async () => { reads++; return JSON.stringify({ BackendState: "Running", Self: { ID: "self", UserID: "42", TailscaleIPs: ["100.70.1.1"] }, Peer: { p: { ID: "peer", UserID: "42", Online: true, OS: "linux", TailscaleIPs: ["100.70.1.2"] } } }); },
    verifyAsset: async () => {}, keygen: async (path, id) => { generated++; writeFileSync(path, "CONTRACT_PRIVATE", { mode: 0o600 }); writeFileSync(path + ".pub", `ssh-ed25519 ${"A".repeat(68)} ovis:${id}`); },
  } });
  cleanups.push(() => manager.stop());
  const request = (suffix: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => new Request("http://localhost/api/machines/" + suffix, { method, headers: { "x-herdr-machine": "1", origin: "http://localhost", ...headers }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
  return { manager, dir, request, counts: () => ({ reads, generated }) };
}
const valid = { peer_id: "peer", username: "alice" };

describe("bootstrap HTTP contract", () => {
  it("gates all methods including reads before discovery/assets/key generation, without caching", async () => {
    const f = fixture();
    for (const path of ["bootstrap", "bootstrap/attempt", "bootstrap/attempt/connect", "machine/revoke-bootstrap"]) {
      for (const method of ["GET", "POST", "DELETE"]) {
        for (const variant of ["watch", "origin", "header"]) {
          const request = f.request(path, method, method === "POST" ? valid : undefined, variant === "origin" ? { origin: "https://other.example" } : variant === "header" ? { "x-herdr-machine": "" } : {});
          const response = await handleMachineRequest(request, f.manager, undefined, undefined, variant === "watch");
          expect(response.status).toBe(403); expect(response.headers.get("cache-control")).toBe("no-store");
        }
      }
    }
    expect(f.counts()).toEqual({ reads: 0, generated: 0 });
  });
  it("validates bodies and emits public-only snapshots; DELETE is idempotent", async () => {
    const f = fixture();
    for (const body of ["{", "null", [], { ...valid, port: 22 }, { ...valid, username: "a b" }, { ...valid, host: "127.0.0.1" }, "x".repeat(4097)]) {
      const response = await handleMachineRequest(f.request("bootstrap", "POST", body), f.manager); expect(response.status).toBe(400); expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(f.counts()).toEqual({ reads: 0, generated: 0 });
    const response = await handleMachineRequest(f.request("bootstrap", "POST", valid), f.manager); expect(response.status).toBe(201);
    const attempt = await response.json() as { id: string; target: unknown; command: string };
    expect(attempt.target).toEqual({ destination: "alice@100.70.1.2", port: 22 }); expect(JSON.stringify(attempt)).not.toContain("CONTRACT_PRIVATE");
    const snapshot = await handleMachineRequest(f.request("bootstrap/" + attempt.id), f.manager); expect(await snapshot.json()).toEqual(attempt);
    for (let i = 0; i < 2; i++) expect((await handleMachineRequest(f.request("bootstrap/" + attempt.id, "DELETE"), f.manager)).status).toBe(200);
    expect((await handleMachineRequest(f.request("bootstrap/" + attempt.id), f.manager)).status).toBe(410);
  });
  it("connect accepts only explicit optional update approval and revoke only firewall boolean", async () => {
    const f = fixture();
    const connect = spyOn(f.manager, "connectBootstrap").mockReturnValue({ id: "job" } as never); cleanups.push(() => connect.mockRestore());
    const revoke = spyOn(f.manager, "revokeBootstrap").mockResolvedValue(); cleanups.push(() => revoke.mockRestore());
    for (const value of [null, [], { update_remote: "true" }, { identity_file: "/key" }]) expect((await handleMachineRequest(f.request("bootstrap/id/connect", "POST", JSON.stringify(value)), f.manager)).status).toBe(400);
    const response = await handleMachineRequest(f.request("bootstrap/id/connect", "POST", { update_remote: true }), f.manager); expect(response.status).toBe(202); expect(connect).toHaveBeenCalledWith("id", true);
    for (const value of [null, [], { remove_firewall: "true" }, { public_key: "key" }]) expect((await handleMachineRequest(f.request("id/revoke-bootstrap", "POST", JSON.stringify(value)), f.manager)).status).toBe(400);
    expect((await handleMachineRequest(f.request("id/revoke-bootstrap", "POST", { remove_firewall: true }), f.manager)).status).toBe(200); expect(revoke).toHaveBeenCalledWith("id", true);
  });
  it("built-in unready release fails with fixed bootstrap_unavailable and no credentials", async () => {
    const f = fixture();
    const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 })); cleanups.push(() => fetcher.mockRestore());
    const internal = f.manager as unknown as { bootstrap: { deps: { verifyAsset?: unknown } } }; delete internal.bootstrap.deps.verifyAsset;
    const response = await handleMachineRequest(f.request("bootstrap", "POST", valid), f.manager); expect(response.status).toBe(503);
    const body = await response.json() as { error: { code: string; message: string } }; expect(body.error.code).toBe("bootstrap_unavailable"); expect(body.error.message).not.toContain("https://"); expect(f.counts().generated).toBe(0);
  });
  it("outer authenticated HTTP boundary refuses unauthenticated bootstrap reads/writes with no-store", async () => {
    const f = fixture();
    const server = createServer({ hostname: "127.0.0.1", port: 0, stateDir: join(f.dir, "http-state"), token: "fixture-bootstrap-auth-token", tailscaleOwner: null }); cleanups.push(() => server.stop());
    const create = spyOn(MachineManager.prototype, "createBootstrap").mockRejectedValue(new Error("must not reach")); cleanups.push(() => create.mockRestore());
    for (const method of ["GET", "POST", "DELETE"]) {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/machines/bootstrap/attempt`, { method, headers: { "x-herdr-machine": "1" } }); expect(response.status).toBe(401); expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(create).not.toHaveBeenCalled();
  });
});
