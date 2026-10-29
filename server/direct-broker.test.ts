import { expect, it, spyOn } from "bun:test";
import { DirectAuthority } from "./direct-auth.ts";
import { DirectBroker, directConfig } from "./direct-broker.ts";
import type { MachineManager } from "./machines.ts";

it("issues machine-scoped credentials over the authenticated control plane and revokes them on disconnect", async () => {
  const authority = new DirectAuthority();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (request.headers.get("authorization") !== "Bearer fictional-control-secret") return new Response(null, { status: 401 });
    const body = await request.json() as Record<string, string>;
    if (request.method === "POST") authority.register(body);
    else if (request.method === "PATCH") authority.revoke(body.issuer!, body.subject!);
    else if (request.method === "DELETE") authority.remove(body.issuer!);
    return new Response(null, { status: 204 });
  } });
  const endpoint = { url: `http://127.0.0.1:${server.port}`, token: "fictional-control-secret" };
  let disconnect = () => {};
  const manager = { endpoint: () => endpoint, trackTerminal: (_id: string, close: () => void) => { disconnect = close; return () => {}; } } as unknown as MachineManager;
  const page = "https://ovis.example.test";
  const broker = new DirectBroker(manager, directConfig('{"machine-b":"https://192.168.1.20:7443"}', page));
  try {
    expect(await broker.issue("unknown", page, "device", false)).toBeNull();
    expect(await broker.issue("machine-b", "https://untrusted.example.test", "device", false)).toBeNull();
    const credential = (await broker.issue("machine-b", page, "device", true))!;
    expect(credential.origin).toBe("https://192.168.1.20:7443");
    const claims = authority.verify(credential.ticket, "ws", page)!;
    expect(claims).toMatchObject({ aud: "machine-b", sub: "device:0", role: "observe" });
    expect(authority.verify(credential.ticket, "ws", page)).toBeNull();
    expect(authority.verify(credential.access_token, "http", page)).not.toBeNull();
    const ended = new Promise<void>((resolve) => authority.onRevoke(claims, resolve));
    disconnect();
    await ended;
    expect(authority.verify(credential.access_token, "http", page)).toBeNull();
  } finally { broker.stop(); authority.stop(); server.stop(true); }
});

it("backdates trust and both credentials across independent bridge clocks without extending TTLs", async () => {
  const page = "https://ovis.example.test";
  let signerNow = 1_800_000_000_000;
  let bridgeNow = signerNow;
  let advanceDuringControl = 0;
  let trustExpiry = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => signerNow);
  const authority = new DirectAuthority(() => bridgeNow);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (request.headers.get("authorization") !== "Bearer fictional-control-secret") return new Response(null, { status: 401 });
    const body = await request.json() as Record<string, unknown>;
    try {
      if (request.method === "POST") {
        authority.register(body);
        trustExpiry = body.expires_at as number;
        signerNow += advanceDuringControl;
        bridgeNow += advanceDuringControl;
        advanceDuringControl = 0;
      } else if (request.method === "DELETE") authority.remove(body.issuer as string);
      return new Response(null, { status: 204 });
    } catch { return new Response(null, { status: 400 }); }
  } });
  const endpoint = { url: `http://127.0.0.1:${server.port}`, token: "fictional-control-secret" };
  const manager = { endpoint: () => endpoint, trackTerminal: () => () => {} } as unknown as MachineManager;
  const broker = new DirectBroker(manager, directConfig('{"machine-b":"https://bridge.example.test:7443"}', page));
  try {
    for (const offset of [-250, -8, 0, 250]) {
      bridgeNow = signerNow + offset;
      const credential = (await broker.issue("machine-b", page, "device", false))!;
      expect(trustExpiry).toBe(signerNow + 85_000);
      expect(credential.expires_at).toBe(signerNow + 55_000);
      const ws = authority.verify(credential.ticket, "ws", page)!;
      const http = authority.verify(credential.access_token, "http", page)!;
      expect(ws).toMatchObject({ iat: signerNow - 5000, exp: signerNow + 25_000, role: "interact" });
      expect(http).toMatchObject({ iat: signerNow - 5000, exp: signerNow + 55_000 });
      expect(ws.exp - ws.iat).toBe(30_000);
      expect(http.exp - http.iat).toBe(60_000);
      expect(authority.verify(credential.ticket, "ws", page)).toBeNull();
      expect(authority.verify(credential.access_token, "http", "https://wrong.example.test")).toBeNull();
      bridgeNow = http.exp;
      expect(authority.verify(credential.access_token, "http", page)).toBeNull();
      signerNow += 70_000;
    }
    bridgeNow = signerNow - 250;
    advanceDuringControl = 2000;
    const afterControl = (await broker.issue("machine-b", page, "device", false))!;
    expect(authority.verify(afterControl.access_token, "http", page)?.iat).toBe(signerNow - 5000);
    expect(afterControl.expires_at).toBe(signerNow + 55_000);
    bridgeNow = signerNow - 5001;
    await expect(broker.issue("machine-b", page, "device", false)).rejects.toThrow("Direct bridge control unavailable");
    bridgeNow = signerNow + 85_000;
    await expect(broker.issue("machine-b", page, "device", false)).rejects.toThrow("Direct bridge control unavailable");
  } finally { broker.stop(); authority.stop(); server.stop(true); clock.mockRestore(); }
});

it("does not turn an SSH alias or arbitrary HTTP LAN URL into a browser endpoint", () => {
  expect(() => directConfig('{"machine-b":"http://192.168.1.20:7443"}', "https://ovis.example.test")).toThrow();
  expect(() => directConfig('{"machine-b":"https://192.168.1.20:7443"}')).toThrow();
});
