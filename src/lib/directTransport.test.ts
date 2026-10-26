import { describe, expect, it } from "bun:test";
import { DirectTransport } from "./directTransport.ts";

const NOW = 1_800_000_000_000;
const ORIGIN = "https://manager.example";
interface Call { url: string; init?: RequestInit }
function credential(machine: string, ticket = "ticket") {
  return { origin: `https://${machine}.example`, ticket: `${machine}-${ticket}`, access_token: `${machine}-http`, expires_at: NOW + 60_000 };
}
function harness(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  let now = NOW;
  const transport = new DirectTransport({ origin: () => ORIGIN, now: () => now, fetch: async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  } });
  return { transport, calls, advance: (ms: number) => { now += ms; } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const signal = () => new AbortController().signal;

describe("memory-only per-PC direct transport", () => {
  it("isolates two PCs with the same pane and coalesces HTTP credentials without leaking headers", async () => {
    const a = deferred<Response>();
    const { transport, calls } = harness(({ url }) => {
      if (url === "/api/machines/a/direct-access") return a.promise;
      if (url === "/api/machines/b/direct-access") return Response.json(credential("b"));
      return Response.json({ ok: true });
    });
    const headers = { authorization: "old-manager-auth", cookie: "manager-cookie", "x-request-id": "request-1" };
    const options = { headers };
    const first = transport.directFetch("/api/machines/a/pane/read?pane_id=w1%3Ap1", options);
    const second = transport.directFetch("/api/machines/a/pane/read?pane_id=w1%3Ap1");
    const other = transport.directFetch("/api/machines/b/pane/read?pane_id=w1%3Ap1");
    expect(calls.filter((call) => call.url.endsWith("/a/direct-access"))).toHaveLength(1);
    a.resolve(Response.json(credential("a")));
    await Promise.all([first, second, other]);
    const reads = calls.filter((call) => call.url.includes("/api/pane/read"));
    expect(reads).toHaveLength(3);
    for (const call of reads) {
      const machine = new URL(call.url).hostname.split(".")[0];
      const sent = new Headers(call.init?.headers);
      expect(sent.get("authorization")).toBe(`Bearer ${machine}-http`);
      expect(sent.has("cookie")).toBe(false);
      expect(call.init?.credentials).toBe("omit");
      expect(call.init?.redirect).toBe("error");
      expect(call.init?.cache).toBe("no-store");
      expect(new URL(call.url).searchParams.get("pane_id")).toBe("w1:p1");
    }
    expect(reads.some((call) => new Headers(call.init?.headers).get("x-request-id") === "request-1")).toBe(true);
    expect(headers.authorization).toBe("old-manager-auth");
    for (const call of calls.filter((call) => call.url.endsWith("direct-access"))) {
      expect(call.init?.method).toBe("POST");
      expect(call.init?.body).toBe("{}");
      expect(call.init?.credentials).toBe("same-origin");
      expect(new Headers(call.init?.headers).get("x-herdr-machine")).toBe("1");
    }
  });

  it("issues a fresh ticket on every WS connection, and cools down only a failed direct endpoint", async () => {
    let issued = 0;
    let elapsed = 0;
    const { transport, calls, advance } = harness(({ url }) => url.endsWith("direct-access")
      ? Response.json({ ...credential("a", String(++issued)), expires_at: NOW + elapsed + 60_000 }) : Response.json({ ok: true }));
    await transport.directFetch("/api/machines/a/pane/read?pane_id=same");
    const resolver = transport.resolveMachineSocket("a");
    const first = await resolver(signal());
    first.opened?.();
    const second = await resolver(signal());
    expect(first.url).toBe("wss://a.example/ws");
    expect(first.protocols).toEqual(["ovis.v1", "ovis.ticket.a-2"]);
    expect(second.protocols).toEqual(["ovis.v1", "ovis.ticket.a-3"]);
    expect(first.url).not.toContain("ticket");
    second.failed?.();
    expect((await resolver(signal())).url).toBe("wss://manager.example/ws?machine_id=a");
    elapsed += 60_001;
    advance(60_001);
    const retried = await resolver(signal());
    expect(retried.url).toBe("wss://a.example/ws");
    retried.opened?.();
    await resolver(signal());
    expect(calls.filter((call) => call.url.endsWith("direct-access"))).toHaveLength(5);
    expect((await transport.resolveMachineSocket("local")(signal())).url).toBe("wss://manager.example/ws?machine_id=local");
  });

  it("propagates caller abort and clear, ignores late credentials, and keeps other coalesced readers alive", async () => {
    const late = deferred<Response>();
    const { transport, calls } = harness(() => late.promise);
    const controller = new AbortController();
    const cancelled = transport.directFetch("/api/machines/a/session", { signal: controller.signal });
    const surviving = transport.directFetch("/api/machines/a/session");
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(calls[0]?.init?.signal?.aborted).toBe(false);
    transport.clear();
    await expect(surviving).rejects.toMatchObject({ name: "AbortError" });
    expect(calls[0]?.init?.signal?.aborted).toBe(true);
    late.resolve(Response.json(credential("a")));
    await late.promise;
    expect(calls).toHaveLength(1);

    const socketLate = deferred<Response>();
    const next = harness(() => socketLate.promise);
    const socketController = new AbortController();
    const socket = next.transport.resolveMachineSocket("a")(socketController.signal);
    socketController.abort();
    await expect(socket).rejects.toMatchObject({ name: "AbortError" });
    socketLate.resolve(Response.json(credential("a")));
    expect(next.calls).toHaveLength(1);
  });

  it("falls back for safe network failures and 401, but never replays a write", async () => {
    for (const method of ["GET", "HEAD", "POST"]) {
      for (const unauthorized of [false, true]) {
        const { transport, calls } = harness(({ url }) => {
          if (url.endsWith("direct-access")) return Response.json(credential("a"));
          if (url.startsWith("https://a.example/")) {
            if (unauthorized) return new Response(null, { status: 401 });
            throw new TypeError("network unavailable");
          }
          return new Response("relay");
        });
        const url = "/api/machines/a/pane/read?pane_id=same";
        const init: RequestInit = { method, ...(method === "POST" ? { body: "write-once" } : {}) };
        if (method === "POST" && !unauthorized) await expect(transport.directFetch(url, init)).rejects.toThrow("network unavailable");
        else {
          const result = await transport.directFetch(url, init);
          expect(result.status).toBe(method === "POST" ? 401 : 200);
        }
        expect(calls.filter((call) => call.url === url)).toHaveLength(method === "POST" ? 0 : 1);
        expect(calls.filter((call) => call.url.startsWith("https://a.example/"))).toHaveLength(1);
      }
    }
  });

  it("leaves local, external, admin, setup, roster, events and noncanonical routes on the relay", async () => {
    const { transport, calls } = harness(() => Response.json({ ok: true }));
    const urls = [
      "/api/machines", "/api/machines/events", "/api/machines/a/direct-access", "/api/machines/a/setup",
      "/api/machines/a/devices", "/api/machines/a/auth", "/api/machines/a/admin", "/api/machines/local/session",
      "https://elsewhere.example/api/machines/a/session", "/api/machines/a/pane/../session", "/api/machines/%61/session",
    ];
    for (const url of urls) await transport.directFetch(url);
    expect(calls.map((call) => call.url)).toEqual(urls);
    expect(calls.every((call) => call.init === undefined)).toBe(true);
  });

  it("cools down missing configuration and rejects invalid origins, token sizes and expiry", async () => {
    const missing = harness(() => new Response(null, { status: 404 }));
    await missing.transport.directFetch("/api/machines/a/session");
    await missing.transport.directFetch("/api/machines/a/session");
    expect(missing.calls.filter((call) => call.url.endsWith("direct-access"))).toHaveLength(1);
    missing.advance(60_001);
    await missing.transport.directFetch("/api/machines/a/session");
    expect(missing.calls.filter((call) => call.url.endsWith("direct-access"))).toHaveLength(2);
    for (const invalid of [
      { origin: "http://lan.example" }, { access_token: "" }, { ticket: "x".repeat(8193) },
      { expires_at: NOW }, { expires_at: NOW + 60_001 },
    ]) {
      const { transport, calls } = harness(({ url }) => url.endsWith("direct-access")
        ? Response.json({ ...credential("a"), ...invalid }) : Response.json({ ok: true }));
      await transport.directFetch("/api/machines/a/session");
      expect(calls.map((call) => call.url)).toEqual(["/api/machines/a/direct-access", "/api/machines/a/session"]);
    }
  });
});
