import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { toolError } from "@/lib/market-data/errors";
import {
  isoDateToUtcMs,
  TICKER_PATTERN,
  type Clock,
  type Endpoint,
  type IsoDate,
  type Ticker,
} from "@/lib/market-data/schemas";
import type {
  MarketDataSource,
  SourceResponse,
} from "@/lib/market-data/source/types";

/*
 * Fuente desde fixtures locales (modo eval), sin red.
 *
 * Diseño:
 * - Cada archivo `evals/fixtures/finnhub/<endpoint>/<TICKER>.json` guarda una
 *   respuesta con la forma exacta de Finnhub, así que las herramientas parsean y
 *   validan igual que en vivo (Decisión 2 del design).
 * - Archivo faltante → `NOT_FOUND`; JSON roto → `UPSTREAM_UNAVAILABLE`, igual
 *   que un cuerpo inválido en vivo.
 * - Las velas se recortan al rango pedido, como hace Finnhub; si no queda
 *   ninguna, se responde `{ s: "no_data" }`, que es lo que devuelve Finnhub.
 * - Defensa en profundidad: aunque el tipo `Ticker` ya garantiza el formato, se
 *   revalida antes de armar la ruta del archivo y se comprueba que la ruta
 *   final quede dentro del directorio de fixtures.
 */

export const DEFAULT_FIXTURES_DIR = path.join(
  process.cwd(),
  "evals",
  "fixtures",
  "finnhub",
);

// Fecha fija de obtención: los fixtures son una foto del cierre del 2025-01-31.
const FIXTURE_FETCHED_AT = new Date("2025-01-31T21:00:00.000Z");

const SECONDS_PER_DAY = 24 * 60 * 60;

// Solo lo necesario para recortar por rango; la validación completa de la
// forma la hacen las herramientas.
const rawCandlesSchema = z.looseObject({
  s: z.literal("ok"),
  t: z.array(z.number()),
  o: z.array(z.number()),
  h: z.array(z.number()),
  l: z.array(z.number()),
  c: z.array(z.number()),
  v: z.array(z.number()),
});

export type FixtureSourceOptions = {
  rootDir?: string;
  now?: Clock;
};

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

export function createFixtureSource(
  options: FixtureSourceOptions = {},
): MarketDataSource {
  const rootDir = path.resolve(options.rootDir ?? DEFAULT_FIXTURES_DIR);
  const now = options.now ?? (() => FIXTURE_FETCHED_AT);

  async function read(
    endpoint: Endpoint,
    ticker: Ticker,
  ): Promise<SourceResponse> {
    if (!TICKER_PATTERN.test(ticker)) {
      return { ok: false, error: toolError("INVALID_TICKER") };
    }
    const file = path.resolve(rootDir, endpoint, `${ticker}.json`);
    if (!file.startsWith(rootDir + path.sep)) {
      return { ok: false, error: toolError("INVALID_TICKER") };
    }

    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      return {
        ok: false,
        error: toolError(isFileNotFound(error) ? "NOT_FOUND" : "UPSTREAM_UNAVAILABLE"),
      };
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, error: toolError("UPSTREAM_UNAVAILABLE") };
    }

    return {
      ok: true,
      body,
      provider: "fixture",
      endpoint,
      fetchedAt: now().toISOString(),
    };
  }

  return {
    provider: "fixture",

    quote(ticker) {
      return read("quote", ticker);
    },

    async candles(ticker, from: IsoDate, to: IsoDate) {
      const response = await read("candle", ticker);
      if (!response.ok) return response;

      const parsed = rawCandlesSchema.safeParse(response.body);
      // Si el fixture no tiene la forma esperada se entrega tal cual: las
      // herramientas lo van a rechazar como lo harían con Finnhub.
      if (!parsed.success) return response;

      const fromSeconds = isoDateToUtcMs(from) / 1000;
      const toSeconds = isoDateToUtcMs(to) / 1000 + SECONDS_PER_DAY - 1;
      const raw = parsed.data;
      const keep = raw.t
        .map((timestamp, index) => ({ timestamp, index }))
        .filter(({ timestamp }) => timestamp >= fromSeconds && timestamp <= toSeconds)
        .map(({ index }) => index);

      if (keep.length === 0) {
        return { ...response, body: { s: "no_data" } };
      }
      const pick = (values: number[]) => keep.map((index) => values[index]);
      return {
        ...response,
        body: {
          c: pick(raw.c),
          h: pick(raw.h),
          l: pick(raw.l),
          o: pick(raw.o),
          s: "ok",
          t: pick(raw.t),
          v: pick(raw.v),
        },
      };
    },

    metrics(ticker) {
      return read("metric", ticker);
    },
  };
}
