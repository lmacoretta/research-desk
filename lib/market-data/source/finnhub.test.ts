import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isoDateSchema, tickerSchema } from "@/lib/market-data/schemas";
import {
  createFinnhubSource,
  FINNHUB_BASE_URL,
  FINNHUB_PATHS,
  FINNHUB_TIMEOUT_MS,
  type FetchLike,
  type FinnhubLogEvent,
} from "@/lib/market-data/source/finnhub";

const API_KEY = "SENTINEL_FINNHUB_KEY";
const FIXED_NOW = new Date("2025-01-31T21:00:00.000Z");
const AAPL = tickerSchema.parse("AAPL");

type Call = { url: URL; init: RequestInit };

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return respond();
  };
  return { fetch, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function source(fetch: FetchLike, logs: FinnhubLogEvent[] = []) {
  return createFinnhubSource({
    apiKey: API_KEY,
    fetch,
    now: () => FIXED_NOW,
    log: (event) => logs.push(event),
  });
}

function headerValue(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

describe("createFinnhubSource requests", () => {
  it("calls the fixed quote path with the key only in the header", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ c: 1 }));
    const result = await source(fetch).quote(AAPL);

    assert.equal(calls.length, 1);
    const [{ url, init }] = calls;
    assert.equal(url.origin + url.pathname, `${FINNHUB_BASE_URL}${FINNHUB_PATHS.quote}`);
    assert.equal(url.pathname, "/api/v1/quote");
    assert.equal(url.searchParams.get("symbol"), "AAPL");
    assert.ok(!url.href.includes(API_KEY), "the key must not be in the URL");
    assert.equal(url.searchParams.get("token"), null);
    assert.equal(headerValue(init, "X-Finnhub-Token"), API_KEY);
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);

    assert.deepEqual(result, {
      ok: true,
      body: { c: 1 },
      provider: "finnhub",
      endpoint: "quote",
      fetchedAt: FIXED_NOW.toISOString(),
    });
  });

  it("calls the candle path with daily resolution and UTC unix bounds", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ s: "ok" }));
    await source(fetch).candles(
      tickerSchema.parse("MSFT"),
      isoDateSchema.parse("2025-01-02"),
      isoDateSchema.parse("2025-01-31"),
    );

    const { url } = calls[0];
    assert.equal(url.pathname, "/api/v1/stock/candle");
    assert.equal(url.searchParams.get("symbol"), "MSFT");
    assert.equal(url.searchParams.get("resolution"), "D");
    // 2025-01-02T00:00:00Z y 2025-01-31T23:59:59Z
    assert.equal(url.searchParams.get("from"), "1735776000");
    assert.equal(url.searchParams.get("to"), "1738367999");
    assert.ok(!url.href.includes(API_KEY));
  });

  it("calls the metric path with metric=all", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ metric: {} }));
    await source(fetch).metrics(tickerSchema.parse("BRK.B"));

    const { url } = calls[0];
    assert.equal(url.pathname, "/api/v1/stock/metric");
    assert.equal(url.searchParams.get("symbol"), "BRK.B");
    assert.equal(url.searchParams.get("metric"), "all");
    assert.ok(!url.href.includes(API_KEY));
  });

  it("uses an 8 second timeout by default", () => {
    assert.equal(FINNHUB_TIMEOUT_MS, 8_000);
  });
});

describe("createFinnhubSource error mapping", () => {
  const statusCases: [number, string][] = [
    [429, "RATE_LIMITED"],
    [401, "ACCESS_DENIED"],
    [403, "ACCESS_DENIED"],
    [500, "UPSTREAM_UNAVAILABLE"],
    [502, "UPSTREAM_UNAVAILABLE"],
    [503, "UPSTREAM_UNAVAILABLE"],
  ];

  for (const [status, code] of statusCases) {
    it(`maps HTTP ${status} to ${code}`, async () => {
      const logs: FinnhubLogEvent[] = [];
      const { fetch } = fakeFetch(() =>
        jsonResponse({ error: `upstream detail ${API_KEY}` }, status),
      );
      const result = await source(fetch, logs).quote(AAPL);

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, code);
        assert.ok(!result.error.message.includes("upstream detail"));
      }
      assert.deepEqual(logs, [{ endpoint: "quote", status }]);
    });
  }

  it("maps a network error to UPSTREAM_UNAVAILABLE", async () => {
    const logs: FinnhubLogEvent[] = [];
    const { fetch } = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const result = await source(fetch, logs).quote(AAPL);

    assert.deepEqual(result.ok ? null : result.error.code, "UPSTREAM_UNAVAILABLE");
    assert.deepEqual(logs, [{ endpoint: "quote", errorName: "TypeError" }]);
  });

  it("maps a timeout to UPSTREAM_UNAVAILABLE", async () => {
    // fetch falso que respeta el AbortSignal, como el real. El timer de
    // `AbortSignal.timeout` no retiene el event loop, así que uno propio lo
    // mantiene vivo hasta que llegue el abort.
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(() => undefined, 5_000);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(keepAlive);
          reject(init.signal?.reason);
        });
      });
    const logs: FinnhubLogEvent[] = [];
    const result = await createFinnhubSource({
      apiKey: API_KEY,
      fetch,
      timeoutMs: 20,
      log: (event) => logs.push(event),
    }).quote(AAPL);

    assert.deepEqual(result.ok ? null : result.error.code, "UPSTREAM_UNAVAILABLE");
    assert.deepEqual(logs, [{ endpoint: "quote", errorName: "TimeoutError" }]);
  });

  it("maps a non-JSON body to UPSTREAM_UNAVAILABLE", async () => {
    const { fetch } = fakeFetch(() => new Response("<html>oops</html>", { status: 200 }));
    const result = await source(fetch).quote(AAPL);

    assert.deepEqual(result.ok ? null : result.error.code, "UPSTREAM_UNAVAILABLE");
  });

  it("never puts the key in log events", async () => {
    const logs: FinnhubLogEvent[] = [];
    const { fetch } = fakeFetch(() => jsonResponse({}, 500));
    await source(fetch, logs).metrics(AAPL);

    assert.ok(!JSON.stringify(logs).includes(API_KEY));
  });
});
