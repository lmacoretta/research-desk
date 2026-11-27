import "server-only";

import type { ToolError } from "@/lib/market-data/errors";
import type {
  Endpoint,
  IsoDate,
  Provider,
  Ticker,
} from "@/lib/market-data/schemas";

/*
 * Contrato de una fuente de market data.
 *
 * Diseño:
 * - La fuente devuelve el cuerpo **crudo** con forma de Finnhub (`unknown`):
 *   validarlo y normalizarlo es trabajo de las herramientas, así que el modo
 *   fixtures recorre el mismo parseo que el modo en vivo.
 * - Nunca lanza: los fallos de transporte (HTTP, red, timeout, archivo faltante)
 *   vuelven como `{ ok: false, error }` con un código del conjunto cerrado.
 * - Solo acepta `Ticker` e `IsoDate` (tipos marcados), es decir, valores que ya
 *   pasaron por zod.
 */

export type SourceResponse =
  | {
      ok: true;
      body: unknown;
      provider: Provider;
      endpoint: Endpoint;
      fetchedAt: string;
    }
  | { ok: false; error: ToolError };

export interface MarketDataSource {
  readonly provider: Provider;
  quote(ticker: Ticker): Promise<SourceResponse>;
  candles(ticker: Ticker, from: IsoDate, to: IsoDate): Promise<SourceResponse>;
  metrics(ticker: Ticker): Promise<SourceResponse>;
}
