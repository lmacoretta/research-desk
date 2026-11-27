import { randomUUID } from "node:crypto";

import { MAX_STEPS } from "@/lib/agents/market-data/config";
import { marketDataAnswerSchema } from "@/lib/agents/market-data/output-schema";
import { runMarketDataAgent } from "@/lib/agents/market-data/run";
import { createFixtureSource } from "@/lib/market-data/source/fixtures";

/*
 * Prueba manual del agente con el modelo real (consume créditos del gateway)
 * y los fixtures como fuente (sin requests a Finnhub).
 *
 *   npx tsx --conditions=react-server --env-file=.env.local \
 *     scripts/try-market-data-agent.ts "pregunta" [maxSteps]
 *
 * Imprime cada paso del loop a medida que llega por el stream: qué
 * herramienta eligió el modelo, con qué parámetros y qué recibió. Después
 * imprime la respuesta verificada. La fecha de referencia es la de los
 * fixtures (2025-01-31) para que "ayer" o "el último mes" tengan datos.
 */

const REFERENCE_DATE = new Date("2025-01-31T21:00:00.000Z");

/** Resume las velas para que la salida se pueda leer. */
function summarizeOutput(output: unknown): unknown {
  if (
    typeof output === "object" && output !== null &&
    "data" in output && typeof output.data === "object" && output.data !== null &&
    "candles" in output.data && Array.isArray(output.data.candles)
  ) {
    const candles: unknown[] = output.data.candles;
    return {
      ...output,
      data: {
        ...output.data,
        candles: `${candles.length} candles`,
        firstCandle: candles[0],
        lastCandle: candles.at(-1),
      },
    };
  }
  return output;
}

async function main() {
  const question = process.argv[2] ?? "¿Cuál es el P/E de AAPL y cómo cerró ayer?";
  const maxSteps = process.argv[3] ? Number(process.argv[3]) : MAX_STEPS;
  console.log(`Pregunta: ${question}`);
  console.log(`maxSteps: ${maxSteps}\n`);

  const { stream, completion } = await runMarketDataAgent({
    question,
    correlationId: randomUUID(),
    source: createFixtureSource(),
    referenceDate: REFERENCE_DATE,
    maxSteps,
  });

  let step = -1;
  for await (const part of stream) {
    switch (part.type) {
      case "start-step":
        step += 1;
        console.log(`── Paso ${step} ──`);
        break;
      case "tool-call":
        console.log(`  → ${part.toolName}(${JSON.stringify(part.input)})  [${part.toolCallId}]`);
        break;
      case "tool-result":
        console.log(`  ← ${part.toolName} [${part.toolCallId}]: ${JSON.stringify(summarizeOutput(part.output))}`);
        break;
      case "tool-error":
        console.log(`  ✗ ${part.toolName} [${part.toolCallId}]: ${String(part.error)}`);
        break;
      case "finish-step":
        console.log(`  (fin del paso: ${part.finishReason})`);
        break;
      default:
        break;
    }
  }

  const { answer, usage, stepCount } = await completion;
  console.log("\nRespuesta verificada:");
  console.log(JSON.stringify(answer, null, 2));
  console.log(`\nValida contra marketDataAnswerSchema: ${marketDataAnswerSchema.safeParse(answer).success}`);
  console.log(`Fuentes: ${[...new Set(answer.dataPoints.map((point) => point.source.provider))].join(", ") || "(ninguna)"}`);
  console.log(`Pasos: ${stepCount}  Tokens: entrada ${usage.inputTokens ?? "?"}, salida ${usage.outputTokens ?? "?"}`);
}

main().catch((error: unknown) => {
  console.error("La consulta falló:", error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
});
