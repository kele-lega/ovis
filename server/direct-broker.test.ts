import { expect, it } from "bun:test";
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

it("does not turn an SSH alias or arbitrary HTTP LAN URL into a browser endpoint", () => {
  expect(() => directConfig('{"machine-b":"http://192.168.1.20:7443"}', "https://ovis.example.test")).toThrow();
  expect(() => directConfig('{"machine-b":"https://192.168.1.20:7443"}')).toThrow();
});
