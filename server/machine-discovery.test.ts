import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { handleMachineRequest } from "./machine-api.ts";
import type { MachineManager } from "./machines.ts";
import * as discovery from "./tailnet-peers.ts";

const restore: (() => void)[] = [];
afterEach(() => { while (restore.length) restore.pop()!(); });

function fixture(fail: "ssh" | "ovis" | null = null) {
  const ssh = spyOn(discovery, "readTailnetPeers").mockImplementation(async () => {
    if (fail === "ssh") throw new Error("fixture-private-discovery-error");
    return { state: "running", peers: [] };
  });
  restore.push(() => ssh.mockRestore());
  let ovisReads = 0;
  const manager = {
    list: () => [],
    setupSummaries: () => [],
    listTailnet: async () => {
      ovisReads++;
      if (fail === "ovis") throw new Error("fixture-private-discovery-error");
      return [{ name: "Fixture PC", url: "https://fixture.tail.ts.net", relay: "online", outdated: false }];
    },
  } as unknown as MachineManager;
  const ask = (query = "", readOnly = false, headers: Record<string, string> = {}) => handleMachineRequest(new Request(`http://127.0.0.1/api/machines/tailnet${query}`, {
    headers: { origin: "http://127.0.0.1", "x-herdr-machine": "1", ...headers },
  }), manager, undefined, undefined, readOnly);
  return { ask, ssh, ovisReads: () => ovisReads };
}

describe("additive SSH and official Ovis discovery", () => {
  it("keeps both discovery contracts on the default endpoint", async () => {
    const f = fixture();
    const response = await f.ask();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ state: "running", peers: [], pcs: [{ name: "Fixture PC", url: "https://fixture.tail.ts.net", relay: "online", outdated: false }] });
    expect(f.ssh).toHaveBeenCalledTimes(1);
    expect(f.ovisReads()).toBe(1);
  });

  it("never probes an Ovis server for the lazy first-time SSH list", async () => {
    const f = fixture();
    const response = await f.ask("?ssh_bootstrap=1");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "running", peers: [] });
    expect(f.ssh).toHaveBeenCalledTimes(1);
    expect(f.ovisReads()).toBe(0);
  });

  it("retains the other provider's useful result if one discovery fails", async () => {
    for (const failure of ["ssh", "ovis"] as const) {
      const f = fixture(failure);
      const response = await f.ask();
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ state: failure === "ssh" ? "unavailable" : "running", peers: [] });
      expect(body.pcs).toHaveLength(failure === "ovis" ? 0 : 1);
      expect(JSON.stringify(body)).not.toContain("fixture-private");
    }
  });

  it("reads neither source for a watching or cross-origin caller", async () => {
    const f = fixture();
    for (const query of ["", "?ssh_bootstrap=1"]) {
      expect((await f.ask(query, true)).status).toBe(403);
      expect((await f.ask(query, false, { origin: "https://elsewhere.invalid" })).status).toBe(403);
    }
    expect(f.ssh).not.toHaveBeenCalled();
    expect(f.ovisReads()).toBe(0);
  });
});
