import "server-only";

import {
  getFinnhubEnv,
  getMarketDataSourceKind,
  type EnvSource,
} from "@/lib/env";
import { createFinnhubSource } from "@/lib/market-data/source/finnhub";
import { createFixtureSource } from "@/lib/market-data/source/fixtures";
import type { MarketDataSource } from "@/lib/market-data/source/types";

export type { MarketDataSource, SourceResponse } from "@/lib/market-data/source/types";

/*
 * Punto único de elección de la fuente según `MARKET_DATA_SOURCE`
 * (`live` por defecto, o `fixtures`).
 *
 * - `FINNHUB_API_KEY` se exige solo en modo `live`: las evals con fixtures
 *   corren sin la clave.
 * - Lanza `EnvError` (nombres de variables, sin valores) si la configuración no
 *   sirve; quien llama decide cómo responder.
 * - El entorno se inyecta para testear cada valor sin tocar `process.env`.
 */
export function getMarketDataSource(
  env: EnvSource = process.env,
): MarketDataSource {
  const kind = getMarketDataSourceKind(env);
  switch (kind) {
    case "live":
      return createFinnhubSource({ apiKey: getFinnhubEnv(env).apiKey });
    case "fixtures":
      return createFixtureSource();
    default: {
      // Si se agrega un valor a MARKET_DATA_SOURCES, TypeScript marca acá.
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
