import { expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TailnetPeers } from "../shared/tailnet.ts";
import { DeviceStore } from "./devices.ts";
import { createServer } from "./index.ts";
import * as tailscale from "./tailscale.ts";

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

it.skipIf(process.platform === "win32")("returns IP-only discovery destinations while preserving DNS/IP/short saved registrations", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-tailnet-contract-"));
  const statePath = join(stateDir, "machines.json");
  const registrations = ["alice@BOX.EXAMPLE.TS.NET.", "100.64.0.2", "fd7a:115c:a1e0::2", "box", "alias"].map((destination, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, name: destination, enabled: false, target: { destination },
  }));
  const saved = JSON.stringify(registrations);
  writeFileSync(statePath, saved);
  mkdirSync(join(stateDir, ".ssh"));
  writeFileSync(join(stateDir, ".ssh", "config"), "Host alias\n HostName 100.64.0.2\n User root\n Port 22\n");
  const statusPath = join(stateDir, "status.json"), commandsPath = join(stateDir, "commands.jsonl");
  const owner = "9007199254740993";
  const peer = { ID: "pc", UserID: owner, HostName: "Reported-Host", DNSName: "BOX.EXAMPLE.TS.NET.", TailscaleIPs: ["fd7a:115c:a1e0::2", "100.64.0.2"], OS: "linux", Online: true };
  const status = (enabled: boolean) => JSON.stringify({
    BackendState: "Running", Self: { ID: "self", UserID: owner }, CurrentTailnet: { MagicDNSEnabled: enabled },
    Peer: {
      pc: peer,
      ipv6: { ...peer, ID: "ipv6", DNSName: "v6.example.ts.net.", TailscaleIPs: ["bad", "fd7a:115c:a1e0::3"] },
      noip: { ...peer, ID: "noip", TailscaleIPs: ["bad"] },
      other: { ...peer, ID: "other", UserID: "9007199254740992" },
      tagged: { ...peer, ID: "tagged", Tags: ["tag:server"] },
      shared: { ...peer, ID: "shared", ShareeNode: true },
      self: { ...peer, ID: "self" },
    },
  });
  writeFileSync(statusPath, status(true));
  const binaryPath = join(stateDir, "tailscale");
  writeFileSync(binaryPath, `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(${JSON.stringify(commandsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write(readFileSync(${JSON.stringify(statusPath)}, "utf8"));
`, { mode: 0o755 });
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "tailnet-test-token", tailscaleOwner: null, herdrProfiles: async () => [], sidecar: false });
  const binary = spyOn(tailscale, "tailscaleBinary").mockReturnValue(binaryPath);
  const home = spyOn(os, "homedir").mockReturnValue(stateDir);
  const url = `http://127.0.0.1:${server.port}/api/machines/tailnet`;
  const headers = { "x-forwarded-for": "100.64.0.99", "x-herdr-machine": "1", authorization: "Bearer tailnet-test-token" };
  try {
    for (const enabled of [true, false]) {
      writeFileSync(statusPath, status(enabled));
      const response = await fetch(url, { headers });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const result = await response.json() as TailnetPeers;
      expect(result.state).toBe("running");
      expect(result.peers.map((entry) => entry.id)).toEqual(["pc", "ipv6"]);
      expect(result.peers[0]).toMatchObject({ name: "box", hostname: "Reported-Host", dns_name: "box.example.ts.net", destination: "100.64.0.2", addresses: ["fd7a:115c:a1e0::2", "100.64.0.2", "box.example.ts.net"] });
      expect(result.peers[1]).toMatchObject({ dns_name: "v6.example.ts.net", destination: "fd7a:115c:a1e0::3" });
      const matched = registrations.filter((entry) => enabled || entry.target.destination !== "box").map((entry) => entry.id).sort();
      expect(result.peers[0]!.registrations.map((entry) => entry.machine_id).sort()).toEqual(matched);
      expect(readFileSync(statePath, "utf8")).toBe(saved);
    }
    expect(readFileSync(commandsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))).toEqual([["status", "--json"], ["status", "--json"]]);
  } finally {
    home.mockRestore();
    binary.mockRestore();
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
