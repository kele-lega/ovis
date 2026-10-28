import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore } from "./devices.ts";
import { createServer } from "./index.ts";

it("gates tailnet discovery behind authentication, drive access and same-origin machine controls", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-tailnet-access-"));
  const store = new DeviceStore(stateDir);
  const watch = store.pair(store.startPairing().code, "Watch", "watch")!;
  store.match(watch.token);
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "tailnet-test-token", tailscaleOwner: null, herdrProfiles: async () => [] });
  const url = `http://127.0.0.1:${server.port}/api/machines/tailnet`;
  const remote = { "x-forwarded-for": "100.64.0.99", "x-herdr-machine": "1" };
  try {
    expect((await fetch(url, { headers: remote })).status).toBe(401);
    const watched = await fetch(url, { headers: { ...remote, cookie: `ovis_device=${watch.token}` } });
    expect(watched.status).toBe(403);
    expect(await watched.json()).toMatchObject({ error: { code: "read_only" } });
    const authorization = "Bearer tailnet-test-token";
    expect((await fetch(url, { headers: { "x-forwarded-for": remote["x-forwarded-for"], authorization } })).status).toBe(403);
    expect((await fetch(url, { headers: { ...remote, authorization, origin: "https://elsewhere.test" } })).status).toBe(403);
    expect((await fetch(url, { method: "POST", headers: { ...remote, authorization } })).status).toBe(405);
  } finally {
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
