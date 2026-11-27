import "server-only";
import { z } from "zod";

/*
 * Esquemas del módulo de market data.
 *
 * Diseño:
 * - "Parse, don't validate": el ticker y las fechas se validan una sola vez y
 *   salen con un tipo marcado (`Ticker`, `IsoDate`). Las fuentes de datos solo
 *   aceptan esos tipos, así que un string sin validar no puede llegar a una URL
 *   ni a una ruta de archivo sin que TypeScript lo rechace.
 * - Los esquemas de input son `.strict()`: un campo desconocido es un error, no
 *   algo que se ignora en silencio.
 * - La fecha "de hoy" se inyecta (`now`) para que la regla "no futuro" sea
 *   testeable y para que las evals usen una fecha de referencia fija.
 * - Los esquemas de resultado describen la forma normalizada que ven el modelo,
 *   la UI y la verificación de fuentes. La forma cruda de Finnhub no está acá:
 *   la validan las herramientas (tarea 2.5).
 */

// --- Códigos de error --------------------------------------------------------

export const TOOL_ERROR_CODES = [
  "INVALID_TICKER",
  "INVALID_INPUT",
  "NOT_FOUND",
  "RATE_LIMITED",
  "ACCESS_DENIED",
  "UPSTREAM_UNAVAILABLE",
] as const;

export const toolErrorCodeSchema = z.enum(TOOL_ERROR_CODES);
export type ToolErrorCode = z.infer<typeof toolErrorCodeSchema>;

export const toolErrorSchema = z
  .object({
    code: toolErrorCodeSchema,
    message: z.string(),
  })
  .strict();
export type ToolError = z.infer<typeof toolErrorSchema>;

// --- Ticker ------------------------------------------------------------------

// 1 a 5 mayúsculas, opcionalmente un punto y 1 a 2 mayúsculas (BRK.B).
// Sin minúsculas, barras, `?`, `&` ni espacios: nada que pueda alterar una
// ruta o una query.
export const TICKER_PATTERN = /^[A-Z]{1,5}(\.[A-Z]{1,2})?$/;

export const tickerSchema = z
  .string()
  .regex(TICKER_PATTERN, "Invalid ticker format")
  .brand<"Ticker">();
export type Ticker = z.infer<typeof tickerSchema>;

// --- Fechas ------------------------------------------------------------------

export const MAX_RANGE_DAYS = 366;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// `z.iso.date()` exige `YYYY-MM-DD` y una fecha de calendario real
// (rechaza `2025-02-30`).
export const isoDateSchema = z.iso.date().brand<"IsoDate">();
export type IsoDate = z.infer<typeof isoDateSchema>;

/** Fecha UTC de `date` en formato `YYYY-MM-DD`. */
export function toIsoDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Medianoche UTC de una fecha `YYYY-MM-DD`, en milisegundos. */
export function isoDateToUtcMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

export type DateRangeProblem = "inverted" | "too_long" | "future";

/**
 * Reglas de rango. Se exporta aparte del esquema para que las reglas tengan
 * nombre y se puedan testear sin zod. Las fechas `YYYY-MM-DD` se comparan como
 * strings porque ese formato ordena lexicográficamente igual que en el tiempo.
 */
export function checkDateRange(
  from: string,
  to: string,
  today: string,
): DateRangeProblem | null {
  if (from > to) return "inverted";
  if (to > today) return "future";
  const days = (isoDateToUtcMs(to) - isoDateToUtcMs(from)) / MS_PER_DAY;
  if (days > MAX_RANGE_DAYS) return "too_long";
  return null;
}

const DATE_RANGE_MESSAGES: Record<DateRangeProblem, string> = {
  inverted: "`from` must be on or before `to`",
  too_long: `The range must not exceed ${MAX_RANGE_DAYS} days`,
  future: "`to` must not be in the future",
};

// --- Esquemas de input de las herramientas ----------------------------------

export const tickerInputSchema = z.object({ ticker: tickerSchema }).strict();
export type TickerInput = z.infer<typeof tickerInputSchema>;

export type Clock = () => Date;
const systemClock: Clock = () => new Date();

/**
 * Input de `getHistoricalPrices`. Es una fábrica porque la regla "no futuro"
 * depende del reloj, y el reloj se inyecta.
 */
export function createHistoricalPricesInputSchema(now: Clock = systemClock) {
  return z
    .object({
      ticker: tickerSchema,
      from: isoDateSchema,
      to: isoDateSchema,
    })
    .strict()
    .superRefine((input, ctx) => {
      const problem = checkDateRange(
        input.from,
        input.to,
        toIsoDateString(now()),
      );
      if (problem) {
        ctx.addIssue({
          code: "custom",
          path: problem === "inverted" ? ["from"] : ["to"],
          message: DATE_RANGE_MESSAGES[problem],
        });
      }
    });
}
export type HistoricalPricesInput = z.infer<
  ReturnType<typeof createHistoricalPricesInputSchema>
>;

// --- Procedencia --------------------------------------------------------------

export const PROVIDERS = ["finnhub", "fixture"] as const;
export const providerSchema = z.enum(PROVIDERS);
export type Provider = z.infer<typeof providerSchema>;

// Endpoint lógico: nombra qué se consultó, no la URL real.
export const ENDPOINTS = ["quote", "candle", "metric"] as const;
export const endpointSchema = z.enum(ENDPOINTS);
export type Endpoint = z.infer<typeof endpointSchema>;

export const provenanceSchema = z
  .object({
    provider: providerSchema,
    endpoint: endpointSchema,
    ticker: z.string(),
    fetchedAt: z.iso.datetime(),
  })
  .strict();
export type Provenance = z.infer<typeof provenanceSchema>;

// --- Formas normalizadas de resultado --------------------------------------

export const quoteDataSchema = z
  .object({
    ticker: z.string(),
    price: z.number(),
    change: z.number(),
    changePercent: z.number(),
    open: z.number(),
    high: z.number(),
    low: z.number(),
    previousClose: z.number(),
    // Segundos unix de la última cotización, como los informa Finnhub.
    timestamp: z.number().int(),
  })
  .strict();
export type QuoteData = z.infer<typeof quoteDataSchema>;

export const candleSchema = z
  .object({
    date: z.iso.date(),
    open: z.number(),
    high: z.number(),
    low: z.number(),
    close: z.number(),
    volume: z.number(),
  })
  .strict();
export type Candle = z.infer<typeof candleSchema>;

export const historicalPricesDataSchema = z
  .object({
    ticker: z.string(),
    from: z.iso.date(),
    to: z.iso.date(),
    resolution: z.literal("D"),
    // Orden ascendente por fecha.
    candles: z.array(candleSchema),
  })
  .strict();
export type HistoricalPricesData = z.infer<typeof historicalPricesDataSchema>;

export const METRIC_PERIODS = ["TTM", "annual", "quarterly"] as const;

export const metricValueSchema = z
  .object({
    // `null` cuando la fuente no informa la métrica.
    value: z.number().nullable(),
    period: z.enum(METRIC_PERIODS),
    unit: z.enum(["ratio", "percent"]),
  })
  .strict();
export type MetricValue = z.infer<typeof metricValueSchema>;

export const keyMetricsDataSchema = z
  .object({
    ticker: z.string(),
    metrics: z
      .object({
        peRatio: metricValueSchema,
        grossMargin: metricValueSchema,
        operatingMargin: metricValueSchema,
        netMargin: metricValueSchema,
        revenueGrowth: metricValueSchema,
        epsGrowth: metricValueSchema,
      })
      .strict(),
  })
  .strict();
export type KeyMetricsData = z.infer<typeof keyMetricsDataSchema>;

// --- Envoltorio de resultado de herramienta ---------------------------------

/**
 * Resultado de una herramienta: éxito con datos y procedencia, o error tipado.
 * Es un valor, no una excepción, para que el modelo vea el error y siga.
 */
export function toolResultSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion("ok", [
    z
      .object({ ok: z.literal(true), data, provenance: provenanceSchema })
      .strict(),
    z.object({ ok: z.literal(false), error: toolErrorSchema }).strict(),
  ]);
}

export type ToolResult<T> =
  | { ok: true; data: T; provenance: Provenance }
  | { ok: false; error: ToolError };

export const quoteResultSchema = toolResultSchema(quoteDataSchema);
export const historicalPricesResultSchema = toolResultSchema(
  historicalPricesDataSchema,
);
export const keyMetricsResultSchema = toolResultSchema(keyMetricsDataSchema);
