import "server-only";
import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import type { LanguageModel, LanguageModelUsage } from "ai";

import {
  createMarketDataAgent,
  MARKET_DATA_AGENT_FUNCTION_ID,
} from "@/lib/agents/market-data/agent";
import { MAX_STEPS } from "@/lib/agents/market-data/config";
import { logMarketDataError } from "@/lib/agents/market-data/log";
import {
  marketDataAnswerSchema,
  type MarketDataAnswer,
} from "@/lib/agents/market-data/output-schema";
import { verifySources } from "@/lib/agents/market-data/verify-sources";
import { getMarketDataSource } from "@/lib/market-data/source";
import type { MarketDataSource } from "@/lib/market-data/source/types";

/*
 * Núcleo de una consulta al agente: lo usan el route handler (streaming) y el
 * script de evals.
 *
 * - Devuelve dos cosas: `stream`, con los pasos del agente a medida que
 *   ocurren (llamadas y resultados de herramientas) para reenviar al cliente,
 *   y `completion`, que resuelve con la respuesta verificada cuando el loop
 *   termina. Las promesas del resultado del AI SDK consumen el stream por su
 *   cuenta, así que las evals pueden esperar `completion` sin leer `stream`:
 *   el mismo camino de código sirve a los dos (Goal del design).
 * - `isPartial` lo decide el servidor: si se usaron todos los pasos, el
 *   último corrió sin herramientas (ver agent.ts) y la respuesta es parcial.
 * - La procedencia la pone `verifySources` con los resultados de herramientas
 *   de todos los pasos (`result.toolResults` acumula todos, no solo el último).
 * - La respuesta final se valida con zod antes de devolverla. Si el modelo no
 *   produjo un objeto válido, `completion` rechaza (`NoOutputGeneratedError`
 *   del SDK) y quien llama responde con un error genérico.
 * - Los errores del stream del agente (por ejemplo, el gateway) se registran
 *   acá, con el `correlationId`. Quien llama no los vuelve a registrar.
 *
 * Tracing (Decisión 9): una observación raíz `answer-market-data-question`
 * con input = la pregunta y output = la respuesta verificada. Se cierra a
 * mano (`endOnExit: false`) cuando termina la verificación, no cuando vuelve
 * `stream()`. Sin Langfuse registrado, estas llamadas no hacen nada.
 */

export const MARKET_DATA_TRACE_NAME = "answer-market-data-question";

export type RunMarketDataAgentOptions = {
  question: string;
  correlationId: string;
  source?: MarketDataSource;
  referenceDate?: Date;
  model?: LanguageModel;
  maxSteps?: number;
};

export type MarketDataToolCallRecord = {
  toolCallId: string;
  toolName: string;
  input: unknown;
};

export type MarketDataRunResult = {
  answer: MarketDataAnswer;
  /** Todas las llamadas a herramientas de la consulta, en orden (para evals). */
  toolCalls: MarketDataToolCallRecord[];
  stepCount: number;
  usage: LanguageModelUsage;
};

export async function runMarketDataAgent({
  question,
  correlationId,
  source = getMarketDataSource(),
  referenceDate = new Date(),
  model,
  maxSteps = MAX_STEPS,
}: RunMarketDataAgentOptions) {
  const agent = createMarketDataAgent({
    source,
    referenceDate,
    model,
    maxSteps,
    // Acá y no en quien llama: `completion` rechaza con un
    // `NoOutputGeneratedError` sin `cause`, así que las evals (que no leen el
    // stream) solo ven el error real en este log.
    onError: ({ error }) => logMarketDataError(correlationId, "model", error),
  });

  return startActiveObservation(
    MARKET_DATA_TRACE_NAME,
    (rootObservation) => {
      rootObservation.update({ input: question });

      return propagateAttributes(
        {
          traceName: MARKET_DATA_TRACE_NAME,
          metadata: { correlationId, dataSource: source.provider },
          tags: [MARKET_DATA_AGENT_FUNCTION_ID],
        },
        async () => {
          const result = await agent.stream({ prompt: question });

          const completion = (async (): Promise<MarketDataRunResult> => {
            const [output, steps, toolResults, usage] = await Promise.all([
              result.output,
              result.steps,
              result.toolResults,
              // Suma de todos los pasos (`totalUsage` es el alias deprecado).
              result.usage,
            ]);

            const verified = verifySources(output.dataPoints, toolResults);
            const answer = marketDataAnswerSchema.parse({
              summary: output.summary,
              dataPoints: verified.dataPoints,
              isPartial: steps.length >= maxSteps,
              unavailable: [...output.unavailable, ...verified.unverified],
            });

            return {
              answer,
              toolCalls: steps.flatMap((step) =>
                step.toolCalls.map(({ toolCallId, toolName, input }) => ({
                  toolCallId,
                  toolName,
                  input,
                })),
              ),
              stepCount: steps.length,
              usage,
            };
          })().then(
            (runResult) => {
              rootObservation.update({ output: runResult.answer });
              rootObservation.end();
              return runResult;
            },
            (error: unknown) => {
              // Solo el nombre del error: el mensaje puede traer texto del
              // proveedor. El detalle lo registra quien llama.
              rootObservation.update({
                level: "ERROR",
                statusMessage: error instanceof Error ? error.name : "unknown",
              });
              rootObservation.end();
              throw error;
            },
          );

          return { stream: result.stream, completion };
        },
      );
    },
    { endOnExit: false },
  );
}

export type MarketDataRun = Awaited<ReturnType<typeof runMarketDataAgent>>;
