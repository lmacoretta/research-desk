import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { z } from "zod";

import {
  errorCodeFromHttpStatus,
  toolErrorFromInputIssues,
} from "@/lib/market-data/errors";
import {
  checkDateRange,
  createHistoricalPricesInputSchema,
  isoDateSchema,
  quoteResultSchema,
  tickerInputSchema,
  tickerSchema,
} from "@/lib/market-data/schemas";

// Reloj fijo: "hoy" es 2025-06-15 en UTC.
const fixedNow = () => new Date("2025-06-15T12:00:00Z");
const historicalInput = createHistoricalPricesInputSchema(fixedNow);

function inputErrorCode(schema: z.ZodType, value: unknown) {
  const result = schema.safeParse(value);
  assert.equal(result.success, false, `expected ${JSON.stringify(value)} to fail`);
  return result.success ? undefined : toolErrorFromInputIssues(result.error).code;
}

describe("tickerSchema", () => {
  for (const valid of ["AAPL", "BRK.B", "F", "GOOGL", "BF.AB"]) {
    it(`accepts ${valid}`, () => {
      assert.equal(tickerSchema.safeParse(valid).success, true);
    });
  }

  for (const invalid of [
    "aapl",
    "../quote",
    "AAPL?x=1",
    "TOOLONG",
    "aapl; DROP",
    "",
    "AAPL ",
    "BRK.",
    "BRK.BBB",
    "A/B",
    "https://evil.example",
  ]) {
    it(`rejects ${JSON.stringify(invalid)}`, () => {
      assert.equal(tickerSchema.safeParse(invalid).success, false);
    });
  }
});

describe("isoDateSchema", () => {
  it("accepts real calendar dates", () => {
    assert.equal(isoDateSchema.safeParse("2024-02-29").success, true);
  });

  for (const invalid of ["2025-02-30", "2025-1-01", "01/02/2025", "2025-01-01T00:00:00Z"]) {
    it(`rejects ${invalid}`, () => {
      assert.equal(isoDateSchema.safeParse(invalid).success, false);
    });
  }
});

describe("checkDateRange", () => {
  const today = "2025-06-15";

  it("accepts a single day and a normal range", () => {
    assert.equal(checkDateRange("2025-01-02", "2025-01-02", today), null);
    assert.equal(checkDateRange("2025-01-02", "2025-01-31", today), null);
  });

  it("accepts exactly 366 days and rejects 367", () => {
    assert.equal(checkDateRange("2024-01-01", "2025-01-01", today), null);
    assert.equal(checkDateRange("2024-01-01", "2025-01-02", today), "too_long");
  });

  it("rejects an inverted range", () => {
    assert.equal(checkDateRange("2025-01-31", "2025-01-02", today), "inverted");
  });

  it("accepts today and rejects tomorrow", () => {
    assert.equal(checkDateRange("2025-06-01", "2025-06-15", today), null);
    assert.equal(checkDateRange("2025-06-01", "2025-06-16", today), "future");
  });
});

describe("tool input schemas", () => {
  it("accepts a valid ticker input", () => {
    assert.equal(tickerInputSchema.safeParse({ ticker: "AAPL" }).success, true);
  });

  it("maps an invalid ticker to INVALID_TICKER", () => {
    assert.equal(inputErrorCode(tickerInputSchema, { ticker: "aapl; DROP" }), "INVALID_TICKER");
    assert.equal(inputErrorCode(tickerInputSchema, { ticker: "../quote" }), "INVALID_TICKER");
    assert.equal(inputErrorCode(tickerInputSchema, {}), "INVALID_TICKER");
  });

  it("maps an unknown field to INVALID_INPUT", () => {
    assert.equal(
      inputErrorCode(tickerInputSchema, { ticker: "AAPL", url: "https://evil.example" }),
      "INVALID_INPUT",
    );
  });

  it("accepts a valid historical range", () => {
    const result = historicalInput.safeParse({
      ticker: "MSFT",
      from: "2025-01-02",
      to: "2025-01-31",
    });
    assert.equal(result.success, true);
  });

  it("maps inverted, too long and future ranges to INVALID_INPUT", () => {
    for (const [from, to] of [
      ["2025-01-31", "2025-01-02"],
      ["2023-01-01", "2025-01-31"],
      ["2025-06-01", "2025-07-01"],
    ]) {
      assert.equal(
        inputErrorCode(historicalInput, { ticker: "MSFT", from, to }),
        "INVALID_INPUT",
        `${from}..${to}`,
      );
    }
  });

  it("maps a malformed date to INVALID_INPUT", () => {
    assert.equal(
      inputErrorCode(historicalInput, { ticker: "MSFT", from: "2025-02-30", to: "2025-03-01" }),
      "INVALID_INPUT",
    );
  });

  it("prefers INVALID_TICKER when the ticker is also invalid", () => {
    assert.equal(
      inputErrorCode(historicalInput, { ticker: "msft", from: "x", to: "y" }),
      "INVALID_TICKER",
    );
  });
});

describe("result envelope", () => {
  it("accepts an error result and rejects unknown error codes", () => {
    assert.equal(
      quoteResultSchema.safeParse({
        ok: false,
        error: { code: "NOT_FOUND", message: "No data" },
      }).success,
      true,
    );
    assert.equal(
      quoteResultSchema.safeParse({
        ok: false,
        error: { code: "BOOM", message: "x" },
      }).success,
      false,
    );
  });

  it("requires provenance on success", () => {
    const data = {
      ticker: "AAPL",
      price: 1,
      change: 0,
      changePercent: 0,
      open: 1,
      high: 1,
      low: 1,
      previousClose: 1,
      timestamp: 1,
    };
    assert.equal(quoteResultSchema.safeParse({ ok: true, data }).success, false);
    assert.equal(
      quoteResultSchema.safeParse({
        ok: true,
        data,
        provenance: {
          provider: "fixture",
          endpoint: "quote",
          ticker: "AAPL",
          fetchedAt: "2025-01-31T21:00:00.000Z",
        },
      }).success,
      true,
    );
  });
});

describe("errorCodeFromHttpStatus", () => {
  const cases: [number, string][] = [
    [429, "RATE_LIMITED"],
    [401, "ACCESS_DENIED"],
    [403, "ACCESS_DENIED"],
    [500, "UPSTREAM_UNAVAILABLE"],
    [502, "UPSTREAM_UNAVAILABLE"],
    [503, "UPSTREAM_UNAVAILABLE"],
    [400, "UPSTREAM_UNAVAILABLE"],
  ];
  for (const [status, code] of cases) {
    it(`${status} → ${code}`, () => {
      assert.equal(errorCodeFromHttpStatus(status), code);
    });
  }
});
