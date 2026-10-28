import { describe, expect, it } from "bun:test";
import type { Machine } from "../shared/machines.ts";
import { handleMachineRequest } from "./machine-api.ts";
import type { MachineManager } from "./machines.ts";
import { resolveSavedSshTarget, parseTailnetPeers, readTailnetPeers } from "./tailnet-peers.ts";

const node = (values = {}) => ({ ID: "n1", UserID: "9007199254740993", HostName: "box", DNSName: "box.example.ts.net.", TailscaleIPs: ["100.64.0.2", "fd7a:115c:a1e0::2"], OS: "linux", Online: true, ...values });
const status = (peers: unknown[] = [node()], values = {}) => JSON.stringify({ BackendState: "Running", Self: { ID: "self", UserID: "9007199254740993" }, CurrentTailnet: { MagicDNSEnabled: true }, Peer: Object.fromEntries(peers.map((peer, i) => [String(i), peer])), ...values });
const machine = (id: string, destination: string, extra = {}) => ({ id, name: id, kind: "ssh", target: { destination, ...extra } }) as Machine;

describe("tailnet PC discovery", () => {
  it("only lists the same user's computers, excluding self, tagged and shared nodes and phones", () => {
    const result = parseTailnetPeers(status([
      node(), node({ ID: "other", UserID: "9007199254740994" }), node({ ID: "tag", Tags: ["tag:server"] }),
      node({ ID: "phone", OS: "iOS" }), node({ ID: "android", OS: "android" }), node({ ID: "shared", ShareeNode: true }), node({ ID: "self" }),
      node({ ID: "offline", DNSName: "win.example.ts.net.", OS: "windows", Online: false }),
    ]));
    expect(result.state).toBe("running");
    expect(result.peers.map((peer) => peer.id)).toEqual(["n1", "offline"]);
    expect(result.peers[0]).toMatchObject({ name: "box", hostname: "box", dns_name: "box.example.ts.net", destination: "100.64.0.2", online: true });
  });
  it("never rounds numeric Tailscale user ids above the JS safe integer limit", () => {
    const raw = '{"BackendState":"Running","Self":{"ID":"self","UserID":9007199254740992},"Peer":{"a":{"ID":"a","UserID":9007199254740992,"OS":"linux","TailscaleIPs":["100.64.0.2"]},"b":{"ID":"b","UserID":9007199254740993,"OS":"linux","TailscaleIPs":["100.64.0.3"]}}}';
    expect(parseTailnetPeers(raw).peers.map((peer) => peer.id)).toEqual(["a"]);
  });
  it("matches numeric and string owners exactly without accepting unknown or malformed owners", () => {
    const raw = '{"BackendState":"Running","Self":{"ID":"self","UserID":42},"CurrentTailnet":{"MagicDNSEnabled":true},"Peer":{"a":{"ID":"a","UserID":"42","DNSName":"a.example.ts.net.","OS":"linux","TailscaleIPs":["100.64.0.2"]},"b":{"ID":"b","UserID":42,"OS":"linux","TailscaleIPs":["100.64.0.3"]}}}';
    expect(parseTailnetPeers(raw).peers.map((peer) => peer.id).sort()).toEqual(["a", "b"]);
    for (const UserID of [undefined, null, false, 0, -1, "9007199254740994", "9007199254740993x"]) {
      expect(parseTailnetPeers(status([node({ UserID })])).peers).toEqual([]);
    }
  });
  it("fails closed when the node has no personal owner", () => {
    for (const Self of [{ Tags: ["tag:server"], UserID: "1" }, {}, { UserID: 0 }, { UserID: null }, { UserID: -1 }, { UserID: false }, { UserID: "invalid" }, null]) {
      expect(parseTailnetPeers(status([node()], { Self }))).toEqual({ state: "identity_unavailable", peers: [] });
    }
  });
  it("distinguishes daemon, format and login failures", () => {
    for (const raw of ["broken", "null", "[]"]) expect(parseTailnetPeers(raw).state).toBe("unavailable");
    expect(parseTailnetPeers(status([], { BackendState: "NeedsLogin" }))).toEqual({ state: "stopped", peers: [] });
  });
  it("keeps the reported hostname and normalized DNS as identity, but always prefers IPv4 over DNS or IPv6", () => {
    for (const CurrentTailnet of [{ MagicDNSEnabled: true }, { MagicDNSEnabled: false }, {}, null]) {
      const peer = parseTailnetPeers(status([node({ HostName: "Reported-Host", DNSName: "BOX.Example.TS.NET.", TailscaleIPs: ["bad", "fd7a:115c:a1e0::2", "100.64.0.2"] })], { CurrentTailnet })).peers[0]!;
      expect(peer).toMatchObject({
        name: "box", hostname: "Reported-Host", dns_name: "box.example.ts.net", destination: "100.64.0.2",
        addresses: ["fd7a:115c:a1e0::2", "100.64.0.2", "box.example.ts.net"],
      });
    }
  });
  it("falls back to validated IPv6 even when MagicDNS is enabled", () => {
    const peer = parseTailnetPeers(status([node({ TailscaleIPs: ["bad", "100.64.0.999", "fd7a:115c:a1e0::2"] })])).peers[0]!;
    expect(peer).toMatchObject({ destination: "fd7a:115c:a1e0::2", dns_name: "box.example.ts.net", addresses: ["fd7a:115c:a1e0::2", "box.example.ts.net"] });
  });
  it("skips peers without a validated IP even when they have a valid MagicDNS name", () => {
    for (const TailscaleIPs of [undefined, null, "100.64.0.2", [], [null, 100, "bad", "100.64.0.999", "fd7a:::2", "box.example.ts.net", "-oProxyCommand=evil", "100.64.0.2;evil"]]) {
      expect(parseTailnetPeers(status([node({ TailscaleIPs })])).peers).toEqual([]);
    }
  });
  it("never promotes malformed DNS to a destination or registration identity", () => {
    for (const DNSName of [undefined, null, "", "-oProxyCommand=evil", "a;evil.ts.net", "a b.ts.net", "a..ts.net"]) {
      expect(parseTailnetPeers(status([node({ HostName: "Host-Only", DNSName })])).peers[0]).toMatchObject({
        name: "Host-Only", hostname: "Host-Only", dns_name: null, destination: "100.64.0.2", addresses: ["100.64.0.2", "fd7a:115c:a1e0::2"],
      });
    }
  });
  it("reads simple static aliases, explicit users and ports without invoking SSH", () => {
    const config = "Host alias\n HostName BOX.example.ts.net\n User root\n Port 22\n IdentityFile /private/key\nHost *\n User fallback\n";
    expect(resolveSavedSshTarget({ destination: "alias" }, config)).toEqual({ hostname: "box.example.ts.net", user: "root", port: 22 });
    expect(resolveSavedSshTarget({ destination: "alice@alias", port: 2222 }, config)).toEqual({ hostname: "box.example.ts.net", user: "alice", port: 2222 });
    expect(resolveSavedSshTarget({ destination: "box" }, "")).toEqual({ hostname: "box", user: null, port: null });
  });
  it("leaves includes, Match exec, patterns and expansions unresolved, never executing them", () => {
    for (const config of ["Match exec 'touch /tmp/must-not-run'", "Include ~/.ssh/other", "Host prod-*\n HostName box", "Host alias\n HostName %h.example.net", "CanonicalizeHostname yes"]) {
      expect(resolveSavedSshTarget({ destination: "alias" }, config)).toBeNull();
    }
    expect(resolveSavedSshTarget({ destination: "-oProxyCommand=evil" }, "")).toBeNull();
  });
  it("keeps accounts, ports and sessions separate, including static aliases and short MagicDNS names", async () => {
    const machines = [machine("root", "alias"), machine("alice", "alice@box", { port: 2222, session: "work" }), machine("other-session", "alias", { session: "other" }), machine("broken", "broken")];
    const result = await readTailnetPeers(machines, {
      readStatus: async () => status(),
      readConfig: async () => "Host alias\n HostName 100.64.0.2\n User root\n Port 22\n",
    });
    expect(result.peers[0]!.registrations).toEqual([
      { machine_id: "alice", name: "alice", user: "alice", port: 2222, session: "work" },
      { machine_id: "root", name: "root", user: "root", port: 22, session: "default" },
      { machine_id: "other-session", name: "other-session", user: "root", port: 22, session: "other" },
    ]);
  });
  it("matches existing full DNS, IPv4, IPv6 and enabled short DNS registrations without modifying them", async () => {
    const machines = [
      machine("dns", "alice@BOX.EXAMPLE.TS.NET."), machine("ipv4", "100.64.0.2"),
      machine("ipv6", "fd7a:115c:a1e0::2"), machine("short", "box"), machine("host-only", "reported-host"),
    ];
    const before = structuredClone(machines);
    const result = await readTailnetPeers(machines, { readStatus: async () => status([node({ HostName: "reported-host" })]), readConfig: async () => "" });
    expect(result.peers[0]!.destination).toBe("100.64.0.2");
    expect(result.peers[0]!.registrations.map((entry) => entry.machine_id).sort()).toEqual(["dns", "ipv4", "ipv6", "short"]);
    expect(machines).toEqual(before);
  });
  it("requires an explicitly enabled MagicDNS for short-name matching, independent of the IP destination", async () => {
    for (const CurrentTailnet of [{ MagicDNSEnabled: true }, { MagicDNSEnabled: false }, { MagicDNSEnabled: "true" }, {}, null, undefined]) {
      const result = await readTailnetPeers([machine("dns", "box.example.ts.net"), machine("ipv4", "100.64.0.2"), machine("short", "alice@box")], {
        readStatus: async () => status([node()], { CurrentTailnet }), readConfig: async () => "",
      });
      expect(result.peers[0]!.destination).toBe("100.64.0.2");
      const ids = CurrentTailnet?.MagicDNSEnabled === true ? ["dns", "ipv4", "short"] : ["dns", "ipv4"];
      expect(result.peers[0]!.registrations.map((entry) => entry.machine_id).sort()).toEqual(ids);
    }
  });
  it("keeps DNS and short-name matches when IPv6 is the only usable destination", async () => {
    const result = await readTailnetPeers([machine("dns", "box.example.ts.net"), machine("ipv6", "fd7a:115c:a1e0::2"), machine("short", "box")], {
      readStatus: async () => status([node({ TailscaleIPs: ["bad", "fd7a:115c:a1e0::2"] })]), readConfig: async () => "",
    });
    expect(result.peers[0]!.destination).toBe("fd7a:115c:a1e0::2");
    expect(result.peers[0]!.registrations.map((entry) => entry.machine_id).sort()).toEqual(["dns", "ipv6", "short"]);
  });
  it("never matches a display hostname or malformed DNS as a short-name registration", async () => {
    for (const DNSName of ["", "box..example.ts.net", "box;evil.ts.net"]) {
      const result = await readTailnetPeers([machine("display-only", "box"), machine("ip", "100.64.0.2")], {
        readStatus: async () => status([node({ DNSName })]), readConfig: async () => "",
      });
      expect(result.peers[0]!.registrations.map((entry) => entry.machine_id)).toEqual(["ip"]);
    }
  });
  it("keeps default account and port unknown rather than guessing the SSH configuration", async () => {
    const result = await readTailnetPeers([machine("default", "box.example.ts.net")], { readStatus: async () => status(), readConfig: async () => "" });
    expect(result.peers[0]!.registrations[0]).toMatchObject({ user: null, port: null });
  });
  it("does not read configuration for an empty network or stopped daemon", async () => {
    let calls = 0;
    for (const raw of [status([]), status([node({ TailscaleIPs: [] })]), status([], { BackendState: "Stopped" })]) {
      await readTailnetPeers([machine("x", "alias")], { readStatus: async () => raw, readConfig: async () => { calls++; return ""; } });
    }
    expect(calls).toBe(0);
  });
  it("keeps discovery available when the configuration file cannot be read", async () => {
    for (const readConfig of [async () => null, async () => { throw new Error("unreadable config"); }]) {
      const result = await readTailnetPeers([machine("x", "alias")], { readStatus: async () => status(), readConfig });
      expect(result.peers).toHaveLength(1);
      expect(result.peers[0]!.registrations).toEqual([]);
    }
  });
  it("distinguishes absent binary, failed read and thrown errors without leaking details", async () => {
    for (const [value, state] of [[undefined, "missing"], [null, "unavailable"]] as const) expect(await readTailnetPeers([], { readStatus: async () => value })).toEqual({ state, peers: [] });
    expect(await readTailnetPeers([], { readStatus: async () => { throw new Error("secret path"); } })).toEqual({ state: "unavailable", peers: [] });
  });
});

describe("tailnet route gate", () => {
  const manager = { list: () => { throw new Error("must not read the roster"); } } as unknown as MachineManager;
  const request = (headers = {}, method = "GET") => new Request("http://127.0.0.1/api/machines/tailnet", { method, headers });
  it("refuses watch devices before reading the network", async () => {
    const response = await handleMachineRequest(request({ "x-herdr-machine": "1" }), manager, undefined, undefined, true);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "read_only" } });
  });
  it("requires the explicit machine header, rejects cross-site reads and non-GET methods", async () => {
    expect((await handleMachineRequest(request(), manager)).status).toBe(403);
    expect((await handleMachineRequest(request({ "x-herdr-machine": "1", origin: "https://evil.test" }), manager)).status).toBe(403);
    expect((await handleMachineRequest(request({ "x-herdr-machine": "1", "sec-fetch-site": "cross-site" }), manager)).status).toBe(403);
    expect((await handleMachineRequest(request({ "x-herdr-machine": "1" }, "POST"), manager)).status).toBe(405);
  });
});
