import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { z } from "zod";

import {
  isoDateSchema,
  tickerSchema,
  type Ticker,
} from "@/lib/market-data/schemas";
import { createFixtureSource } from "@/lib/market-data/source/fixtures";
import type { SourceResponse } from "@/lib/market-data/source/types";

const source = createFixtureSource();
const date = (value: string) => isoDateSchema.parse(value);

const objectBody = z.record(z.string(), z.unknown());
const numbers = z.array(z.number());

function body(response: SourceResponse): Record<string, unknown> {
  assert.ok(response.ok, "expected a successful response");
  return objectBody.parse(response.body);
}

function errorCode(response: SourceResponse): string | null {
  return response.ok ? null : response.error.code;
}

describe("createFixtureSource with the repo fixtures", () => {
  for (const name of ["AAPL", "MSFT", "NVDA"]) {
    const ticker = tickerSchema.parse(name);

    it(`reads quote, candle and metric for ${name}`, async () => {
      const quote = await source.quote(ticker);
      assert.equal(typeof body(quote).c, "number");
      assert.equal(quote.ok && quote.provider, "fixture");
      assert.equal(quote.ok && quote.endpoint, "quote");

      const candles = await source.candles(ticker, date("2025-01-02"), date("2025-01-31"));
      assert.equal(body(candles).s, "ok");
      assert.equal(numbers.parse(body(candles).t).length, 20);

      const metrics = await source.metrics(ticker);
      assert.equal(typeof body(metrics).metric, "object");
      assert.equal(body(metrics).symbol, name);
    });
  }

  it("returns NOT_FOUND for a ticker without fixtures", async () => {
    const zzzz = tickerSchema.parse("ZZZZ");
    assert.equal(errorCode(await source.quote(zzzz)), "NOT_FOUND");
    assert.equal(
      errorCode(await source.candles(zzzz, date("2025-01-02"), date("2025-01-31"))),
      "NOT_FOUND",
    );
    assert.equal(errorCode(await source.metrics(zzzz)), "NOT_FOUND");
  });

  it("trims candles to the requested range in ascending order", async () => {
    const response = await source.candles(
      tickerSchema.parse("MSFT"),
      date("2025-01-06"),
      date("2025-01-08"),
    );
    const trimmed = body(response);
    assert.deepEqual(
      numbers.parse(trimmed.t).map((s) => new Date(s * 1000).toISOString().slice(0, 10)),
      ["2025-01-06", "2025-01-07", "2025-01-08"],
    );
    for (const key of ["o", "h", "l", "c", "v"]) {
      assert.equal(numbers.parse(trimmed[key]).length, 3, key);
    }
  });

  it("answers no_data for a range outside the fixture", async () => {
    const response = await source.candles(
      tickerSchema.parse("AAPL"),
      date("2024-06-01"),
      date("2024-06-30"),
    );
    assert.deepEqual(body(response), { s: "no_data" });
  });

  it("uses a fixed fetchedAt", async () => {
    const response = await source.quote(tickerSchema.parse("AAPL"));
    assert.equal(response.ok && response.fetchedAt, "2025-01-31T21:00:00.000Z");
  });
});

describe("createFixtureSource defenses", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "fixtures-test-"));
    await mkdir(path.join(dir, "quote"));
    await writeFile(path.join(dir, "quote", "BAD.json"), "{ not json");
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("maps a broken JSON file to UPSTREAM_UNAVAILABLE", async () => {
    const response = await createFixtureSource({ rootDir: dir }).quote(
      tickerSchema.parse("BAD"),
    );
    assert.equal(errorCode(response), "UPSTREAM_UNAVAILABLE");
  });

  it("rejects a ticker that bypassed validation", async () => {
    // Simula un llamador que forzó el tipo marcado con un valor sin validar.
    const forged = "../quote/BAD" as Ticker;
    const response = await createFixtureSource({ rootDir: dir }).quote(forged);
    assert.equal(errorCode(response), "INVALID_TICKER");
  });
});
