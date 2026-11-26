import "server-only";
import { tool } from "ai";
import { z } from "zod";

import { toolError } from "@/lib/market-data/errors";
import {
  createHistoricalPricesInputSchema,
  tickerInputSchema,
  toIsoDateString,
  type Candle,
  type Clock,
  type HistoricalPricesData,
  type HistoricalPricesInput,
  type KeyMetricsData,
  type MetricValue,
  type QuoteData,
  type TickerInput,
  type ToolResult,
} from "@/lib/market-data/schemas";
import type {
  MarketDataSource,
  SourceResponse,
} from "@/lib/market-data/source/types";

/*
 * Herramientas de market data para cualquier agente (Decisión 4 del design).
 *
 * - `inputSchema` estricto: el AI SDK valida el input del modelo antes de
 *   llamar a `execute`.
 * - `execute` nunca lanza: devuelve `{ ok: true, data, provenance }` o
 *   `{ ok: false, error }` (ver `ToolResult` en schemas.ts). Si algo lanza
 *   igual (un bug), `guard` lo convierte en `UPSTREAM_UNAVAILABLE`.
 * - La fuente se inyecta: el mismo código corre contra Finnhub o fixtures.
 * - El cuerpo de la fuente es `unknown` y se valida con zod antes de usarlo.
 *   Si no cumple la forma de Finnhub: `UPSTREAM_UNAVAILABLE`.
 * - La procedencia sale de la respuesta real de la fuente, nunca del modelo.
 */

// --- Formas crudas de Finnhub -------------------------------------------------

const finnhubQuoteSchema = z.object({
  c: z.number(), // precio actual
  d: z.number().nullable(), // cambio en $ (null si Finnhub no conoce el ticker)
  dp: z.number().nullable(), // cambio en % (ídem)
  h: z.number(), // máximo del día
  l: z.number(), // mínimo del día
  o: z.number(), // apertura
  pc: z.number(), // cierre anterior
  t: z.number().int(), // segundos unix
});

const finnhubCandlesSchema = z.discriminatedUnion("s", [
  z.object({
    s: z.literal("ok"),
    t: z.array(z.number().int()),
    o: z.array(z.number()),
    h: z.array(z.number()),
    l: z.array(z.number()),
    c: z.array(z.number()),
    v: z.array(z.number()),
  }),
  z.object({ s: z.literal("no_data") }),
]);

// Campo ausente o `null` → la métrica queda en `null`. Un tipo distinto
// (por ejemplo un string) es una respuesta mal formada.
const optionalMetric = z.number().nullish();

const finnhubMetricSchema = z.object({
  // `looseObject`: Finnhub manda decenas de métricas; se conservan las claves
  // para poder distinguir `metric` vacío (NOT_FOUND) de métricas faltantes.
  metric: z
    .looseObject({
      peTTM: optionalMetric,
      grossMarginTTM: optionalMetric,
      operatingMarginTTM: optionalMetric,
      netProfitMarginTTM: optionalMetric,
      revenueGrowthTTMYoy: optionalMetric,
      epsGrowthTTMYoy: optionalMetric,
    })
    .nullable(),
});

// --- Helpers compartidos ------------------------------------------------------

type SourceSuccess = Extract<SourceResponse, { ok: true }>;

function success<T>(
  response: SourceSuccess,
  ticker: string,
  data: T,
): ToolResult<T> {
  return {
    ok: true,
    data,
    provenance: {
      provider: response.provider,
      endpoint: response.endpoint,
      ticker,
      fetchedAt: response.fetchedAt,
    },
  };
}

function failure(code: Parameters<typeof toolError>[0]): ToolResult<never> {
  return { ok: false, error: toolError(code) };
}

/** Garantiza que `execute` no lance; el detalle va solo al log. */
async function guard<T>(
  toolName: string,
  run: () => Promise<ToolResult<T>>,
): Promise<ToolResult<T>> {
  try {
    return await run();
  } catch (error) {
    console.error("[market-data] tool failed", {
      tool: toolName,
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return failure("UPSTREAM_UNAVAILABLE");
  }
}

function metric(
  value: number | null | undefined,
  unit: MetricValue["unit"],
): MetricValue {
  return { value: value ?? null, period: "TTM", unit };
}

// --- Herramientas -------------------------------------------------------------

export type MarketDataToolsOptions = {
  // Reloj para la regla "no futuro" de los rangos de fechas.
  now?: Clock;
};

export function createMarketDataTools(
  source: MarketDataSource,
  options: MarketDataToolsOptions = {},
) {
  const historicalPricesInputSchema = createHistoricalPricesInputSchema(
    options.now,
  );

  async function quote(input: TickerInput): Promise<ToolResult<QuoteData>> {
    const response = await source.quote(input.ticker);
    if (!response.ok) {
      return { ok: false, error: response.error };
    }

    const parsed = finnhubQuoteSchema.safeParse(response.body);
    if (!parsed.success) {
      return failure("UPSTREAM_UNAVAILABLE");
    }
    const raw = parsed.data;

    // Así responde Finnhub a un ticker que no conoce: todo en cero.
    if (raw.c === 0 && raw.t === 0) {
      return failure("NOT_FOUND");
    }
    if (raw.d === null || raw.dp === null) {
      return failure("UPSTREAM_UNAVAILABLE");
    }

    return success(response, input.ticker, {
      ticker: input.ticker,
      price: raw.c,
      change: raw.d,
      changePercent: raw.dp,
      open: raw.o,
      high: raw.h,
      low: raw.l,
      previousClose: raw.pc,
      timestamp: raw.t,
    });
  }

  async function historicalPrices(
    input: HistoricalPricesInput,
  ): Promise<ToolResult<HistoricalPricesData>> {
    const response = await source.candles(input.ticker, input.from, input.to);
    if (!response.ok) {
      return { ok: false, error: response.error };
    }

    const parsed = finnhubCandlesSchema.safeParse(response.body);
    if (!parsed.success) {
      return failure("UPSTREAM_UNAVAILABLE");
    }
    const raw = parsed.data;
    if (raw.s === "no_data" || raw.t.length === 0) {
      return failure("NOT_FOUND");
    }

    // Finnhub manda columnas paralelas; si no miden lo mismo, no se puede
    // armar ninguna vela con confianza.
    const length = raw.t.length;
    if ([raw.o, raw.h, raw.l, raw.c, raw.v].some((column) => column.length !== length)) {
      return failure("UPSTREAM_UNAVAILABLE");
    }

    const candles: Candle[] = raw.t
      .map((timestamp, index) => ({ timestamp, index }))
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(({ timestamp, index }) => ({
        date: toIsoDateString(new Date(timestamp * 1000)),
        open: raw.o[index],
        high: raw.h[index],
        low: raw.l[index],
        close: raw.c[index],
        volume: raw.v[index],
      }));

    return success(response, input.ticker, {
      ticker: input.ticker,
      from: input.from,
      to: input.to,
      resolution: "D",
      candles,
    });
  }

  async function keyMetrics(
    input: TickerInput,
  ): Promise<ToolResult<KeyMetricsData>> {
    const response = await source.metrics(input.ticker);
    if (!response.ok) {
      return { ok: false, error: response.error };
    }

    const parsed = finnhubMetricSchema.safeParse(response.body);
    if (!parsed.success) {
      return failure("UPSTREAM_UNAVAILABLE");
    }
    const raw = parsed.data.metric;
    // Así responde Finnhub a un ticker que no conoce: `metric: {}`.
    if (raw === null || Object.keys(raw).length === 0) {
      return failure("NOT_FOUND");
    }

    return success(response, input.ticker, {
      ticker: input.ticker,
      metrics: {
        peRatio: metric(raw.peTTM, "ratio"),
        grossMargin: metric(raw.grossMarginTTM, "percent"),
        operatingMargin: metric(raw.operatingMarginTTM, "percent"),
        netMargin: metric(raw.netProfitMarginTTM, "percent"),
        revenueGrowth: metric(raw.revenueGrowthTTMYoy, "percent"),
        epsGrowth: metric(raw.epsGrowthTTMYoy, "percent"),
      },
    });
  }

  return {
    getQuote: tool({
      description:
        "Get the latest quote for a stock ticker: current price, change and percent change vs. the previous close, open, high, low, previous close and the quote timestamp (unix seconds).",
      inputSchema: tickerInputSchema,
      execute: (input) => guard("getQuote", () => quote(input)),
    }),

    getHistoricalPrices: tool({
      description:
        "Get daily OHLCV candles for a stock ticker between two dates (YYYY-MM-DD, inclusive, at most 366 days, not in the future), in ascending date order.",
      inputSchema: historicalPricesInputSchema,
      execute: (input) =>
        guard("getHistoricalPrices", () => historicalPrices(input)),
    }),

    getKeyMetrics: tool({
      description:
        "Get key metrics for a stock ticker: P/E, gross, operating and net margins, revenue growth and EPS growth (TTM; margins and growth in percent). Missing metrics are null.",
      inputSchema: tickerInputSchema,
      execute: (input) => guard("getKeyMetrics", () => keyMetrics(input)),
    }),
  };
}

export type MarketDataTools = ReturnType<typeof createMarketDataTools>;
