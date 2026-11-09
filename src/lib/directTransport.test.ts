import { describe, expect, it, jest } from "bun:test";
import { DirectTransport } from "./directTransport.ts";
import type { SocketEndpoint } from "./ws.ts";

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
const settle = async () => { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); };

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
      expect(JSON.parse(String(call.init?.body))).toMatchObject({ receipt_resume_id: expect.stringMatching(/^[a-f0-9-]{36}$/) });
      expect(call.init?.credentials).toBe("same-origin");
      expect(new Headers(call.init?.headers).get("x-herdr-machine")).toBe("1");
    }
  });

  it("does not replay a safe read through A after caller cancellation during direct failure or authorization", async () => {
    for (const phase of ["authorization", "direct"]) {
      const caller = new AbortController();
      const { transport, calls } = harness(({ url }) => {
        if (url.endsWith("direct-access")) {
          if (phase === "authorization") caller.abort();
          return Response.json(credential("a"));
        }
        if (url.startsWith("https://a.example/")) { caller.abort(); throw new Error("carrier failed after cancellation"); }
        throw new Error("must not fall back after abort");
      });
      await expect(transport.directFetch("/api/machines/a/session", { signal: caller.signal })).rejects.toMatchObject({ name: "AbortError" });
      expect(calls.some((call) => call.url === "/api/machines/a/session")).toBe(false);
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

  it("accepts conservatively shortened credentials and renews HTTP access at their actual expiry", async () => {
    let elapsed = 0;
    const { transport, calls, advance } = harness(({ url }) => url.endsWith("direct-access")
      ? Response.json({ ...credential("a"), expires_at: NOW + elapsed + 55_000 }) : Response.json({ ok: true }));
    expect((await transport.resolveMachineSocket("a")(signal())).url).toBe("wss://a.example/ws");
    await transport.directFetch("/api/machines/a/session");
    elapsed += 54_999;
    advance(54_999);
    await transport.directFetch("/api/machines/a/session");
    expect(calls.filter((call) => call.url.endsWith("direct-access"))).toHaveLength(1);
    elapsed++;
    advance(1);
    await transport.directFetch("/api/machines/a/session");
    expect(calls.filter((call) => call.url.endsWith("direct-access"))).toHaveLength(2);
    expect(calls.filter((call) => call.url === "https://a.example/api/session")).toHaveLength(3);
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

  it("times out socket authorization into relay cooldown and ignores late fetch or body credentials", async () => {
    jest.useFakeTimers();
    try {
      for (const stalled of ["fetch", "body"]) {
        const late = deferred<Response>();
        const body = deferred<unknown>();
        let issued = 0;
        const { transport, calls, advance } = harness(({ url }) => {
          if (!url.endsWith("direct-access")) return new Response("relay");
          if (++issued > 1) return Response.json({ ...credential("a", "fresh"), expires_at: NOW + 120_000 });
          return stalled === "fetch" ? late.promise : { ok: true, json: () => body.promise } as Response;
        });
        try {
          let endpoint: SocketEndpoint | undefined;
          const resolved = transport.resolveMachineSocket("a")(signal()).then((value) => { endpoint = value; return value; });
          void resolved.catch(() => {}); // Cleanup also settles this promise if a deadline regression fails an assertion.
          await settle();
          jest.advanceTimersByTime(4_999);
          await settle();
          expect(endpoint).toBeUndefined();
          jest.advanceTimersByTime(1);
          await settle();
          // Shorter than the WebSocket's initial 8s budget: the relay can still open on this attempt.
          expect(endpoint?.url).toBe("wss://manager.example/ws?machine_id=a");
          await resolved;
          expect(calls[0]?.init?.signal?.aborted).toBe(true);
          expect((await transport.resolveMachineSocket("a")(signal())).url).toBe("wss://manager.example/ws?machine_id=a");
          await transport.directFetch("/api/machines/a/session");
          expect(issued).toBe(1);
          advance(60_000);
          late.resolve(Response.json({ ...credential("a", "stale"), expires_at: NOW + 120_000 }));
          body.resolve({ ...credential("a", "stale"), expires_at: NOW + 120_000 });
          await settle();
          await transport.directFetch("/api/machines/a/session");
          // If a fetch/body ignores abort, its late token must not repopulate the HTTP cache.
          expect(issued).toBe(2);
          expect(calls.at(-1)?.url).toBe("https://a.example/api/session");
        } finally { transport.clear(); }
      }
    } finally { jest.useRealTimers(); }
  });

  it("propagates socket abort and sign-out without timeout cooldown or late credential caching", async () => {
    jest.useFakeTimers();
    try {
      for (const cancel of ["caller", "clear"]) {
        const late = deferred<Response>();
        let issued = 0;
        const { transport, calls } = harness(({ url }) => {
          if (!url.endsWith("direct-access")) return new Response("ok");
          return ++issued === 1 ? late.promise : Response.json(credential("a", "fresh"));
        });
        try {
          const controller = new AbortController();
          const resolved = transport.resolveMachineSocket("a")(controller.signal);
          if (cancel === "caller") controller.abort(new DOMException("Explicit cancellation", "TimeoutError"));
          else transport.clear();
          await expect(resolved).rejects.toMatchObject({ name: cancel === "caller" ? "TimeoutError" : "AbortError" });
          expect(calls[0]?.init?.signal?.aborted).toBe(true);
          late.resolve(Response.json(credential("a", "stale")));
          await settle();
          jest.advanceTimersByTime(5_000);
          await transport.directFetch("/api/machines/a/session");
          expect(issued).toBe(2);
          expect(calls.at(-1)?.url).toBe("https://a.example/api/session");
        } finally { transport.clear(); }
      }
    } finally { jest.useRealTimers(); }
  });

  it("ignores endpoint bookkeeping callbacks after transport clear", async () => {
    let issued = 0;
    const { transport } = harness(({ url }) => url.endsWith("direct-access")
      ? Response.json(credential("a", String(++issued))) : new Response("ok"));
    const stale = await transport.resolveMachineSocket("a")(signal());
    transport.clear();
    const current = await transport.resolveMachineSocket("a")(signal());
    current.failed?.();
    stale.opened?.();
    expect((await transport.resolveMachineSocket("a")(signal())).url).toBe("wss://manager.example/ws?machine_id=a");
    transport.clear();
    await transport.resolveMachineSocket("a")(signal());
    stale.failed?.();
    expect((await transport.resolveMachineSocket("a")(signal())).url).toBe("wss://a.example/ws");
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

  it("bounds blackholed safe direct reads, falls back once and enters cooldown", async () => {
    jest.useFakeTimers();
    try {
      for (const method of ["GET", "HEAD"] as const) {
        const late = deferred<Response>();
        const { transport, calls } = harness(({ url }) => url.endsWith("direct-access")
          ? Response.json(credential("a")) : url.startsWith("https://a.example/") ? late.promise : new Response("relay"));
        try {
          let response: Response | undefined;
          const read = transport.directFetch("/api/machines/a/session", { method }).then((next) => { response = next; return next; });
          void read.catch(() => {});
          await settle();
          jest.advanceTimersByTime(4_999); await settle(); expect(response).toBeUndefined();
          jest.advanceTimersByTime(1); await settle();
          expect(response?.status).toBe(200);
          await read;
          expect(calls.find((call) => call.url === "https://a.example/api/session")?.init?.signal?.aborted).toBe(true);
          await transport.directFetch("/api/machines/a/session");
          expect(calls.filter((call) => call.url.endsWith("direct-access"))).toHaveLength(1);
          expect(calls.filter((call) => call.url === "/api/machines/a/session")).toHaveLength(2);
          late.resolve(new Response("late direct")); await settle();
        } finally { transport.clear(); }
      }
    } finally { jest.useRealTimers(); }
  });

  it("never gives a blackholed direct write a read deadline or replays it through A", async () => {
    jest.useFakeTimers();
    const late = deferred<Response>(), caller = new AbortController();
    const { transport, calls } = harness(({ url }) => url.endsWith("direct-access") ? Response.json(credential("a")) : late.promise);
    try {
      let settled = false;
      const write = transport.directFetch("/api/machines/a/pane/input", { method: "POST", body: "explicit-once", signal: caller.signal });
      void write.then(() => { settled = true; }, () => { settled = true; });
      await settle(); jest.advanceTimersByTime(60_000); await settle();
      expect(settled).toBe(false);
      expect(calls.find((call) => call.url === "https://a.example/api/pane/input")?.init?.signal?.aborted).toBe(false);
      caller.abort();
      await expect(write).rejects.toMatchObject({ name: "AbortError" });
      expect(calls.filter((call) => call.url === "https://a.example/api/pane/input")).toHaveLength(1);
      expect(calls.some((call) => call.url === "/api/machines/a/pane/input")).toBe(false);
    } finally { transport.clear(); jest.useRealTimers(); late.resolve(new Response("late")); }
  });

  it("does not fall back from a blackholed direct read after cancellation or sign-out", async () => {
    for (const cancel of ["caller", "clear"]) {
      const late = deferred<Response>(), caller = new AbortController();
      const { transport, calls } = harness(({ url }) => url.endsWith("direct-access") ? Response.json(credential("a")) : late.promise);
      const read = transport.directFetch("/api/machines/a/session", { signal: caller.signal });
      await settle();
      if (cancel === "caller") caller.abort(new DOMException("Explicit cancel", "TimeoutError")); else transport.clear();
      await expect(read).rejects.toMatchObject({ name: cancel === "caller" ? "TimeoutError" : "AbortError" });
      expect(calls.some((call) => call.url === "/api/machines/a/session")).toBe(false);
      late.resolve(new Response("late")); transport.clear();
    }
  });

  it("keeps caller cancellation attached to a direct response body after headers arrive", async () => {
    for (const combine of [true, false]) {
      const any = AbortSignal.any;
      if (!combine) Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined });
      const caller = new AbortController();
      let directSignal: AbortSignal | undefined;
      const { transport, calls } = harness(({ url, init }) => {
        if (url.endsWith("direct-access")) return Response.json(credential("a"));
        directSignal = init!.signal!;
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"));
          directSignal!.addEventListener("abort", () => controller.error(directSignal!.reason), { once: true });
        } }));
      });
      try {
        const response = await transport.directFetch("/api/machines/a/session", { signal: caller.signal });
        const body = response.text();
        expect(directSignal?.aborted).toBe(false);
        const reason = new DOMException("Viewer closed", "AbortError");
        caller.abort(reason);
        await expect(body).rejects.toBe(reason);
        expect(directSignal?.aborted).toBe(true);
        expect(calls.some((call) => call.url === "/api/machines/a/session")).toBe(false);
      } finally {
        transport.clear();
        Object.defineProperty(AbortSignal, "any", { configurable: true, value: any });
      }
    }
  });

  it("cools down broker outages, malformed credentials and authorization timeouts for HTTP reads", async () => {
    const failures = [() => new Response(null, { status: 503 }), () => new Response(null, { status: 429 }),
      () => Response.json({ invalid: true }), () => { throw new TypeError("control unavailable"); }];
    for (const fail of failures) {
      const { transport, calls, advance } = harness(({ url }) => url.endsWith("direct-access") ? fail() : new Response("relay"));
      await transport.directFetch("/api/machines/a/session");
      await transport.directFetch("/api/machines/a/session");
      expect(calls.filter((call) => call.url.endsWith("direct-access"))).toHaveLength(1);
      advance(60_000);
      await transport.directFetch("/api/machines/a/session");
      expect(calls.filter((call) => call.url.endsWith("direct-access"))).toHaveLength(2);
      transport.clear();
    }
    jest.useFakeTimers();
    const late = deferred<Response>();
    const { transport, calls } = harness(({ url }) => url.endsWith("direct-access") ? late.promise : new Response("relay"));
    try {
      const read = transport.directFetch("/api/machines/a/session");
      await settle(); jest.advanceTimersByTime(5_000); await settle(); await read;
      await transport.directFetch("/api/machines/a/session");
      expect(calls.filter((call) => call.url.endsWith("direct-access"))).toHaveLength(1);
    } finally { transport.clear(); jest.useRealTimers(); late.resolve(Response.json(credential("a"))); }
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
