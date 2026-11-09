import { afterAll, describe, expect, it } from "bun:test";
import { BRIDGE_PROTOCOL, type Machine } from "../shared/machines.ts";
import { remoteCommandLaunchSupported } from "./machine-command-launch.ts";

const supported = () => ({
  ok: true,
  bridge_protocol: BRIDGE_PROTOCOL,
  launch_command: true,
  herdr: { protocol: 22, runtime: "herdr", capabilities: { atomic_command_launch: true } },
});
const servers: ReturnType<typeof Bun.serve>[] = [];
afterAll(() => { for (const server of servers) server.stop(true); });
function remote(answer: (request: Request) => Response | Promise<Response>) {
  const requests: { path: string; authorization: string | null; cookie: string | null }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      requests.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization"), cookie: request.headers.get("cookie") });
      return answer(request);
    },
  });
  servers.push(server);
  return { endpoint: { url: `http://127.0.0.1:${server.port}`, token: "fixture-selected-pc-token" }, requests };
}
const signal = () => new AbortController().signal;

describe("fresh selected-PC atomic command proof", () => {
  it("uses SSH bridge identity, but relay's authenticated paired health channel, never a browser credential", async () => {
    const pc = remote(() => Response.json(supported()));
    expect(await remoteCommandLaunchSupported(pc.endpoint, "ssh", signal())).toBeTrue();
    expect(await remoteCommandLaunchSupported(pc.endpoint, "relay", signal())).toBeTrue();
    expect(pc.requests).toEqual([
      { path: "/api/bridge", authorization: "Bearer fixture-selected-pc-token", cookie: null },
      { path: "/api/health", authorization: "Bearer fixture-selected-pc-token", cookie: null },
    ]);
  });

  it("does not infer target kind or treat herdr-core's argv API as atomic support", async () => {
    const pc = remote(() => Response.json(supported()));
    for (const kind of [undefined, "hc", "local"] as const) {
      expect(await remoteCommandLaunchSupported(pc.endpoint, kind, signal())).toBeFalse();
    }
    expect(pc.requests).toEqual([]);
  });

  it("asks again for every command and refuses an old Ovis after a supported answer", async () => {
    let current = supported();
    const pc = remote(() => Response.json(current));
    expect(await remoteCommandLaunchSupported(pc.endpoint, "ssh", signal())).toBeTrue();
    current = { ...supported(), launch_command: false };
    expect(await remoteCommandLaunchSupported(pc.endpoint, "ssh", signal())).toBeFalse();
    expect(pc.requests).toHaveLength(2);
  });

  const invalid: [string, unknown][] = [
    ["old bridge protocol", { ...supported(), bridge_protocol: BRIDGE_PROTOCOL + 1 }],
    ["missing Ovis capability", { ...supported(), launch_command: undefined }],
    ["truthy Ovis capability", { ...supported(), launch_command: "true" }],
    ["missing daemon", { ...supported(), herdr: null }],
    ["old daemon protocol", { ...supported(), herdr: { ...supported().herdr, protocol: 21 } }],
    ["missing daemon capability", { ...supported(), herdr: { protocol: 22 } }],
    ["truthy daemon capability", { ...supported(), herdr: { protocol: 22, capabilities: { atomic_command_launch: 1 } } }],
    ["herdr-core daemon", { ...supported(), herdr: { ...supported().herdr, runtime: "herdr-core" } }],
    ["herdr-core health", { ...supported(), runtime: "herdr-core" }],
    ["primitive answer", true],
    ["array answer", []],
  ];
  for (const [name, answer] of invalid) it(`fails closed on ${name}`, async () => {
    const pc = remote(() => Response.json(answer));
    expect(await remoteCommandLaunchSupported(pc.endpoint, "ssh", signal())).toBeFalse();
    expect(pc.requests).toHaveLength(1);
  });

  it("does not require relay health to pretend to be an SSH bridge", async () => {
    const { bridge_protocol: _bridge, ...health } = supported();
    const pc = remote(() => Response.json(health));
    expect(await remoteCommandLaunchSupported(pc.endpoint, "relay", signal())).toBeTrue();
    expect(await remoteCommandLaunchSupported(pc.endpoint, "ssh", signal())).toBeFalse();
    const notLive = remote(() => Response.json({ ...health, ok: false }));
    expect(await remoteCommandLaunchSupported(notLive.endpoint, "relay", signal())).toBeFalse();
  });

  for (const kind of ["ssh", "relay"] as Machine["kind"][]) {
    it(`bounds and sanitizes ${kind} errors without retrying or following redirects`, async () => {
      const target = remote(() => Response.json(supported()));
      const answers = [
        () => new Response("fixture-private-remote-error", { status: 503 }),
        () => new Response("{fixture-private-invalid-json"),
        () => new Response("oversize", { headers: { "content-length": String(64 * 1024 + 1) } }),
        () => Response.redirect(target.endpoint.url + "/api/bridge", 302),
      ];
      for (const answer of answers) {
        const pc = remote(answer);
        expect(await remoteCommandLaunchSupported(pc.endpoint, kind, signal())).toBeFalse();
        expect(pc.requests).toHaveLength(1);
      }
      expect(target.requests).toEqual([]);
    });
  }

  it("does not send a proof request when its caller is already disconnected", async () => {
    const pc = remote(() => Response.json(supported()));
    expect(await remoteCommandLaunchSupported(pc.endpoint, "ssh", AbortSignal.abort())).toBeFalse();
    expect(pc.requests).toEqual([]);
  });
});
