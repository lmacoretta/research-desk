import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspect } from "node:util";

import { EnvError } from "@/lib/env";
import { getMarketDataSource } from "@/lib/market-data/source";

const FINNHUB_API_KEY = "SENTINEL_FINNHUB_KEY";

describe("getMarketDataSource", () => {
  it("uses Finnhub when MARKET_DATA_SOURCE is live", () => {
    const source = getMarketDataSource({ MARKET_DATA_SOURCE: "live", FINNHUB_API_KEY });
    assert.equal(source.provider, "finnhub");
  });

  it("defaults to Finnhub when MARKET_DATA_SOURCE is unset or empty", () => {
    assert.equal(getMarketDataSource({ FINNHUB_API_KEY }).provider, "finnhub");
    assert.equal(
      getMarketDataSource({ MARKET_DATA_SOURCE: "", FINNHUB_API_KEY }).provider,
      "finnhub",
    );
  });

  it("uses fixtures when MARKET_DATA_SOURCE is fixtures, without needing the Finnhub key", () => {
    const source = getMarketDataSource({ MARKET_DATA_SOURCE: "fixtures" });
    assert.equal(source.provider, "fixture");
  });

  it("throws an EnvError naming FINNHUB_API_KEY when live has no key", () => {
    assert.throws(
      () => getMarketDataSource({ MARKET_DATA_SOURCE: "live" }),
      (error) =>
        error instanceof EnvError && /FINNHUB_API_KEY \(missing\)/.test(error.message),
    );
  });

  it("throws an EnvError for an unknown value without echoing it", () => {
    assert.throws(
      () => getMarketDataSource({ MARKET_DATA_SOURCE: "SENTINEL_SOURCE", FINNHUB_API_KEY }),
      (error) =>
        error instanceof EnvError &&
        /MARKET_DATA_SOURCE \(invalid\)/.test(error.message) &&
        !inspect(error).includes("SENTINEL_SOURCE") &&
        !inspect(error).includes(FINNHUB_API_KEY),
    );
  });
});
