import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as herdr from "./herdr/client.ts";
import { createServer } from "./index.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-health-command-"));
  cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const ping = spyOn(herdr, "ping").mockResolvedValue({ version: "fixture", protocol: 22 });
  cleanup.push(() => ping.mockRestore());
  const server = createServer({ hostname: "127.0.0.1", port: 0, stateDir, token: "", machines: false, sidecar: false, tailscaleOwner: null });
  cleanup.push(() => server.stop());
  return { ping, read: (scope = "") => fetch(`http://127.0.0.1:${server.port}/api/health${scope}`) };
}

describe("health's live atomic launch advertisement", () => {
  it("keeps bridge liveness independent of the daemon and does not fabricate a capability", async () => {
    const f = fixture();
    f.ping.mockRejectedValue(new Error("fixture daemon offline"));
    const response = await f.read("?scope=bridge");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, bridge_protocol: 1 });
    expect(body).not.toHaveProperty("launch_command");
    expect(f.ping).not.toHaveBeenCalled();
  });

  it("requires strict live support and preserves upstream runtime/attach identity", async () => {
    const f = fixture();
    for (const identity of [
      { version: "fixture", protocol: 22, capabilities: { atomic_command_launch: true } },
      { version: "fixture", protocol: 22 },
      { version: "fixture", protocol: 22, capabilities: { atomic_command_launch: false } },
      { version: "fixture", protocol: 22, runtime: "herdr-core" as const, layout: { rename: true, split: true, move: true, arrange: true, worktrees: true }, capabilities: { atomic_command_launch: true } },
    ]) {
      f.ping.mockResolvedValueOnce(identity);
      const response = await f.read();
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.launch_command).toBe(process.platform !== "win32" && identity.runtime !== "herdr-core" && identity.capabilities?.atomic_command_launch === true);
      expect(body.herdr).toMatchObject({ version: identity.version, protocol: identity.protocol });
      if (identity.runtime === "herdr-core") expect(body.herdr).toMatchObject({ runtime: "herdr-core", layout: identity.layout });
    }
  });
});
