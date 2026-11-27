import "server-only";
import {
  isStepCount,
  Output,
  ToolLoopAgent,
  type LanguageModel,
  type Tool,
} from "ai";

import {
  MAX_OUTPUT_TOKENS,
  MAX_STEPS,
} from "@/lib/agents/market-data/config";
import { modelAnswerSchema } from "@/lib/agents/market-data/output-schema";
import {
  buildMarketDataInstructions,
  STEP_LIMIT_NOTICE,
} from "@/lib/agents/market-data/prompt";
import { getMarketDataModel } from "@/lib/llm/models";
import type { MarketDataSource } from "@/lib/market-data/source/types";
import { createMarketDataTools } from "@/lib/market-data/tools";

/*
 * Agente de market data (Decisión 5 del design).
 *
 * - Es una fábrica porque la fuente y la fecha de referencia cambian por
 *   consulta: en vivo, Finnhub y la fecha del request; en evals, fixtures y
 *   una fecha fija.
 * - La fecha de referencia también es el reloj de las herramientas, así el
 *   prompt ("today is …") y la regla "no futuro" de `getHistoricalPrices`
 *   usan la misma fecha.
 * - `stopWhen: isStepCount(maxSteps)` cuenta también el paso de la respuesta
 *   estructurada. En el último paso permitido, `prepareStep` apaga las
 *   herramientas (`activeTools: []`) y agrega `STEP_LIMIT_NOTICE`: el modelo
 *   tiene que responder con lo que tiene. Sin eso, el loop podría cortarse
 *   en un paso con `tool-calls` y no habría objeto final.
 * - `model` y `maxSteps` se pueden inyectar para tests (modelo simulado de
 *   `ai/test`, límite bajo). Por defecto salen de env y de config.ts.
 * - Cada herramienta se envuelve con `citable` (ver abajo) para que el modelo
 *   pueda citar el `toolCallId` real.
 */

export const MARKET_DATA_AGENT_FUNCTION_ID = "market-data-agent";

/**
 * Hace visible el `toolCallId` dentro del resultado que lee el modelo.
 *
 * En la prueba con el modelo real (tarea 3.3), el ID de la llamada no le
 * llega al modelo como texto que pueda copiar: inventó citas como
 * `getQuote:AAPL` y la verificación descartó todos los datos. Con
 * `toModelOutput`, el modelo recibe `{ toolCallId, result }`.
 *
 * `toModelOutput` solo cambia lo que ve el modelo: `toolResults`, el stream
 * hacia la UI y la verificación de fuentes siguen usando el resultado
 * original. Vive acá y no en `lib/market-data` porque la cita es una
 * necesidad de este agente, no de las herramientas.
 */
function citable<T extends Tool>(tool: T): T {
  return {
    ...tool,
    // Texto con JSON: es lo mismo que el SDK le manda al modelo por defecto
    // para un resultado `json`, sin exigir que `output` se tipe como JSONValue.
    toModelOutput: ({ toolCallId, output }: { toolCallId: string; output: unknown }) => ({
      type: "text" as const,
      value: JSON.stringify({ toolCallId, result: output }),
    }),
  };
}

export type CreateMarketDataAgentOptions = {
  source: MarketDataSource;
  referenceDate: Date;
  model?: LanguageModel;
  maxSteps?: number;
};

export function createMarketDataAgent({
  source,
  referenceDate,
  model = getMarketDataModel(),
  maxSteps = MAX_STEPS,
}: CreateMarketDataAgentOptions) {
  const instructions = buildMarketDataInstructions(referenceDate);
  const lastStepInstructions = `${instructions}\n\n${STEP_LIMIT_NOTICE}`;
  const tools = createMarketDataTools(source, { now: () => referenceDate });

  return new ToolLoopAgent({
    model,
    instructions,
    tools: {
      getQuote: citable(tools.getQuote),
      getHistoricalPrices: citable(tools.getHistoricalPrices),
      getKeyMetrics: citable(tools.getKeyMetrics),
    },
    stopWhen: isStepCount(maxSteps),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    output: Output.object({
      name: "market_data_answer",
      description: "Answer to a stock market data question, citing the tool call of each data point.",
      schema: modelAnswerSchema,
    }),
    prepareStep: ({ stepNumber }) =>
      stepNumber >= maxSteps - 1
        ? { activeTools: [], instructions: lastStepInstructions }
        : {},
    telemetry: { functionId: MARKET_DATA_AGENT_FUNCTION_ID },
  });
}

export type MarketDataAgent = ReturnType<typeof createMarketDataAgent>;
