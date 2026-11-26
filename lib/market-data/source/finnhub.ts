import "server-only";

import { errorCodeFromHttpStatus, toolError } from "@/lib/market-data/errors";
import {
  isoDateToUtcMs,
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
 * Fuente en vivo: API REST de Finnhub.
 *
 * Diseño (Decisión 3 del design):
 * - Host y rutas son constantes. Los parámetros entran solo por
 *   `URLSearchParams` y ya validados, así que ningún input cambia el destino.
 * - La clave va en el header `X-Finnhub-Token`, nunca en la URL: las URLs
 *   terminan en logs y spans, los headers de esta request no.
 * - `redirect: "error"`: un 3xx no puede llevar la request (con el header) a
 *   otro host.
 * - Timeout de 8 s con `AbortSignal.timeout`.
 * - `fetch` y el reloj se inyectan para testear sin red.
 * - El log registra endpoint, status o nombre del error; nunca la URL completa,
 *   headers ni el cuerpo.
 */

export const FINNHUB_BASE_URL = "https://finnhub.io/api/v1";

export const FINNHUB_PATHS = {
  quote: "/quote",
  candle: "/stock/candle",
  metric: "/stock/metric",
} as const satisfies Record<Endpoint, string>;

export const FINNHUB_TIMEOUT_MS = 8_000;

const SECONDS_PER_DAY = 24 * 60 * 60;

export type FetchLike = (url: URL, init: RequestInit) => Promise<Response>;

export type FinnhubLogEvent = {
  endpoint: Endpoint;
  status?: number;
  errorName?: string;
};

export type FinnhubSourceOptions = {
  apiKey: string;
  fetch?: FetchLike;
  now?: Clock;
  timeoutMs?: number;
  log?: (event: FinnhubLogEvent) => void;
};

const defaultLog = (event: FinnhubLogEvent) => {
  console.error("[market-data] finnhub request failed", event);
};

export function createFinnhubSource(
  options: FinnhubSourceOptions,
): MarketDataSource {
  const {
    apiKey,
    fetch: fetchImpl = (url, init) => fetch(url, init),
    now = () => new Date(),
    timeoutMs = FINNHUB_TIMEOUT_MS,
    log = defaultLog,
  } = options;

  async function request(
    endpoint: Endpoint,
    params: Record<string, string>,
  ): Promise<SourceResponse> {
    const url = new URL(`${FINNHUB_BASE_URL}${FINNHUB_PATHS[endpoint]}`);
    url.search = new URLSearchParams(params).toString();

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { "X-Finnhub-Token": apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
        cache: "no-store",
      });
    } catch (error) {
      // Red caída, DNS, timeout (TimeoutError) o redirect rechazado.
      log({ endpoint, errorName: error instanceof Error ? error.name : "unknown" });
      return { ok: false, error: toolError("UPSTREAM_UNAVAILABLE") };
    }

    if (!response.ok) {
      log({ endpoint, status: response.status });
      // Libera la conexión sin leer el cuerpo.
      await response.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        error: toolError(errorCodeFromHttpStatus(response.status)),
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      log({
        endpoint,
        status: response.status,
        errorName: error instanceof Error ? error.name : "unknown",
      });
      return { ok: false, error: toolError("UPSTREAM_UNAVAILABLE") };
    }

    return {
      ok: true,
      body,
      provider: "finnhub",
      endpoint,
      fetchedAt: now().toISOString(),
    };
  }

  return {
    provider: "finnhub",

    quote(ticker: Ticker) {
      return request("quote", { symbol: ticker });
    },

    candles(ticker: Ticker, from: IsoDate, to: IsoDate) {
      // Velas diarias. `to` se lleva al final del día UTC para incluirlo.
      const fromSeconds = isoDateToUtcMs(from) / 1000;
      const toSeconds = isoDateToUtcMs(to) / 1000 + SECONDS_PER_DAY - 1;
      return request("candle", {
        symbol: ticker,
        resolution: "D",
        from: String(fromSeconds),
        to: String(toSeconds),
      });
    },

    metrics(ticker: Ticker) {
      return request("metric", { symbol: ticker, metric: "all" });
    },
  };
}
