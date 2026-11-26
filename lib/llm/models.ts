import "server-only";
import { createNeon } from "@neon/ai-sdk-provider";
import type { LanguageModel } from "ai";

import {
  getMarketDataModelId,
  getNeonGatewayEnv,
  type EnvSource,
} from "@/lib/env";

/*
 * Resolución de modelos por agente.
 *
 * - El ID del modelo sale siempre de una variable de entorno (MODEL_MARKET_DATA);
 *   no hay IDs en el código.
 * - Se usa `createNeon` con la configuración ya validada por `lib/env.ts` en lugar
 *   de la instancia `neon` por defecto, que lee `process.env` por su cuenta: así
 *   hay una sola fuente de verdad y un error de configuración sale como
 *   `EnvError` (con nombres de variables, sin valores) antes de cualquier request.
 * - La resolución es perezosa (una función, no una constante de módulo) para que
 *   importar este archivo no lance si faltan variables.
 */

export function getMarketDataModel(
  source: EnvSource = process.env,
): LanguageModel {
  const modelId = getMarketDataModelId(source);
  const gateway = getNeonGatewayEnv(source);
  const neon = createNeon({ baseURL: gateway.baseURL, apiKey: gateway.token });
  return neon(modelId);
}
