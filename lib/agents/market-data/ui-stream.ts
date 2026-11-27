import "server-only";
import { toUIMessageStream, type InferUIMessageChunk } from "ai";

import type { MarketDataRun } from "@/lib/agents/market-data/run";
import type { MarketDataUIMessage } from "@/lib/agents/market-data/ui-message";
import { toolError, toolErrorFromInputIssues } from "@/lib/market-data/errors";
import type { ToolError } from "@/lib/market-data/schemas";
import type {
  MarketDataInputSchemas,
  MarketDataTools,
} from "@/lib/market-data/tools";

/*
 * Stream de UI del agente de market data (Decisiones 4 y 7 del design).
 *
 * Convierte el stream del agente en chunks de UI y, antes de que salgan al
 * cliente:
 * - quita las partes de texto: son el JSON del objeto estructurado a medio
 *   generar. La respuesta llega entera y verificada en `data-answer`;
 * - reemplaza el `errorText` de los chunks `tool-input-error` y
 *   `tool-output-error` por `{ code, message }` de un conjunto cerrado
 *   (`createToolErrorRedactor`), así el cliente nunca recibe el texto del SDK;
 * - al final escribe `data-answer` con la respuesta ya verificada y después
 *   `finish`. Si la consulta falla, escribe un solo chunk `error` genérico.
 *
 * El modelo sigue recibiendo el mensaje de validación original (con los
 * issues de zod) para poder corregirse: el reemplazo afecta solo al cliente.
 */

export type MarketDataUIChunk = InferUIMessageChunk<MarketDataUIMessage>;

const STRUCTURED_TEXT_CHUNKS = new Set<MarketDataUIChunk["type"]>([
  "text-start",
  "text-delta",
  "text-end",
]);

function isMarketDataToolName(
  inputSchemas: MarketDataInputSchemas,
  toolName: string,
): toolName is keyof MarketDataInputSchemas {
  return Object.hasOwn(inputSchemas, toolName);
}

/**
 * Error tipado para un input que el SDK rechazó: se revalida con el mismo
 * esquema de la herramienta y se mapea con `toolErrorFromInputIssues`.
 * Una herramienta desconocida (el modelo inventó un nombre) o un input que
 * igual valida (no debería pasar) quedan como `INVALID_INPUT`.
 */
function toolErrorForInvalidInput(
  inputSchemas: MarketDataInputSchemas,
  toolName: string,
  input: unknown,
): ToolError {
  if (!isMarketDataToolName(inputSchemas, toolName)) {
    return toolError("INVALID_INPUT");
  }
  const parsed = inputSchemas[toolName].safeParse(input);
  return parsed.success
    ? toolError("INVALID_INPUT")
    : toolErrorFromInputIssues(parsed.error);
}

/**
 * Devuelve una función con estado que reemplaza el `errorText` de los chunks
 * de error de herramienta. Una instancia por consulta: recuerda el texto de
 * cada `toolCallId` inválido para que el `tool-output-error` de esa misma
 * llamada reciba el mismo texto. Cualquier otro `tool-output-error` (una
 * herramienta que lanzó, cosa que `execute` evita) es `UPSTREAM_UNAVAILABLE`.
 */
export function createToolErrorRedactor(inputSchemas: MarketDataInputSchemas) {
  const errorTextByToolCallId = new Map<string, string>();

  return (chunk: MarketDataUIChunk): MarketDataUIChunk => {
    switch (chunk.type) {
      case "tool-input-error": {
        const errorText = JSON.stringify(
          toolErrorForInvalidInput(inputSchemas, chunk.toolName, chunk.input),
        );
        errorTextByToolCallId.set(chunk.toolCallId, errorText);
        return { ...chunk, errorText };
      }
      case "tool-output-error":
        return {
          ...chunk,
          errorText:
            errorTextByToolCallId.get(chunk.toolCallId) ??
            JSON.stringify(toolError("UPSTREAM_UNAVAILABLE")),
        };
      default:
        return chunk;
    }
  };
}

export type MarketDataUIStreamOptions = {
  run: MarketDataRun;
  /** Los mismos esquemas (y reloj) que usan las herramientas de la consulta. */
  inputSchemas: MarketDataInputSchemas;
  /** Texto genérico (con la referencia) que recibe el cliente ante una falla. */
  errorText: string;
  /**
   * Registra una falla que no pasó por el stream del agente, por ejemplo una
   * respuesta final que no valida. Los errores del stream ya los registra
   * el agente (ver run.ts), así que no se registran dos veces.
   */
  logError: (error: unknown) => void;
};

export function toMarketDataUIStream({
  run,
  inputSchemas,
  errorText,
  logError,
}: MarketDataUIStreamOptions): ReadableStream<MarketDataUIChunk> {
  const redact = createToolErrorRedactor(inputSchemas);
  let errorSent = false;

  // Si el cliente corta la conexión, `flush` no corre y nadie espera
  // `completion`: sin este handler, su rechazo quedaría sin manejar.
  run.completion.catch(() => undefined);

  return toUIMessageStream<MarketDataTools, MarketDataUIMessage>({
    stream: run.stream,
    // Errores del stream (por ejemplo, el gateway): el cliente recibe solo
    // el texto genérico. El detalle ya quedó en el log del agente.
    onError: () => errorText,
    // Los errores de herramienta no pasan por `onError` (no son fallas del
    // sistema): los reemplaza `redact` a partir del input.
    redactToolErrors: false,
    // La UI no muestra razonamiento: no se envía.
    sendReasoning: false,
    // `finish` se escribe después de `data-answer`.
    sendFinish: false,
  }).pipeThrough(
    new TransformStream<MarketDataUIChunk, MarketDataUIChunk>({
      transform(chunk, controller) {
        if (STRUCTURED_TEXT_CHUNKS.has(chunk.type)) {
          return;
        }
        if (chunk.type === "error") {
          errorSent = true;
        }
        controller.enqueue(redact(chunk));
      },

      // Corre cuando el stream del agente terminó: todas las partes de
      // herramientas ya salieron y solo falta la respuesta verificada.
      async flush(controller) {
        try {
          const { answer } = await run.completion;
          controller.enqueue({ type: "data-answer", data: answer });
          controller.enqueue({ type: "finish" });
        } catch (error) {
          // Si el stream ya informó el error, esta es la misma falla vista
          // desde `completion` (un `NoOutputGeneratedError` sin detalle): no
          // se registra ni se manda otro chunk de error.
          if (!errorSent) {
            logError(error);
            controller.enqueue({ type: "error", errorText });
          }
        }
      },
    }),
  );
}
