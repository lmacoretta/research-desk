import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { simulateReadableStream, type UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";

import { STEP_LIMIT_NOTICE } from "@/lib/agents/market-data/prompt";
import { runMarketDataAgent } from "@/lib/agents/market-data/run";
import type { MarketDataUIMessage } from "@/lib/agents/market-data/ui-message";
import { UNVERIFIED_REASON } from "@/lib/agents/market-data/verify-sources";
import { createFixtureSource } from "@/lib/market-data/source/fixtures";

/*
 * Loop del agente con un modelo simulado de `ai/test`: sin red ni créditos y
 * con los fixtures como fuente. Cubre:
 * - 3.2 de punta a punta: un dato de una herramienta que corrió en un paso
 *   anterior al final recibe la procedencia real; uno inventado no.
 * - 3.4 de forma determinista: con `maxSteps: 2`, el segundo paso llega sin
 *   herramientas y con el aviso, no hay tercer paso y la respuesta es parcial.
 * - Salida inválida: `completion` rechaza en lugar de devolver algo mal formado.
 */

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

const REFERENCE_DATE = new Date("2025-01-31T21:00:00.000Z");

const FINISH_USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function toolCallStep(calls: Array<{ id: string; tool: string; input: object }>): StreamResult {
  const chunks: StreamPart[] = [
    ...calls.map((call): StreamPart => ({
      type: "tool-call",
      toolCallId: call.id,
      toolName: call.tool,
      input: JSON.stringify(call.input),
    })),
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: FINISH_USAGE },
  ];
  return { stream: simulateReadableStream({ chunks }) };
}

function answerStep(answer: unknown): StreamResult {
  const text = JSON.stringify(answer);
  const chunks: StreamPart[] = [
    { type: "text-start", id: "answer" },
    { type: "text-delta", id: "answer", delta: text },
    { type: "text-end", id: "answer" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: FINISH_USAGE },
  ];
  return { stream: simulateReadableStream({ chunks }) };
}

function run(model: MockLanguageModelV4, maxSteps?: number) {
  return runMarketDataAgent({
    question: "¿Cuál es el P/E de AAPL y cómo cerró ayer?",
    correlationId: "test-correlation-id",
    source: createFixtureSource(),
    referenceDate: REFERENCE_DATE,
    model,
    maxSteps,
  });
}

describe("runMarketDataAgent with a simulated model", () => {
  it("verifies sources across steps and lists invented data as unverified (task 3.2)", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStep([{ id: "call-quote", tool: "getQuote", input: { ticker: "AAPL" } }]),
        toolCallStep([{ id: "call-metric", tool: "getKeyMetrics", input: { ticker: "AAPL" } }]),
        answerStep({
          summary: "AAPL: P/E 37.8; cierre anterior 237.59 USD.",
          dataPoints: [
            { label: "Previous close", value: 237.59, unit: "USD", ticker: "AAPL", toolCallId: "call-quote" },
            { label: "P/E", value: 37.8, unit: "ratio", ticker: "AAPL", toolCallId: "call-metric" },
            { label: "Dividend yield", value: 0.5, unit: "percent", ticker: "AAPL", toolCallId: "call-invented" },
          ],
          unavailable: [],
        }),
      ],
    });

    // Sin leer `stream`: así lo usan las evals.
    const { completion } = await run(model);
    const { answer, toolCalls, stepCount } = await completion;

    assert.equal(stepCount, 3);
    assert.equal(answer.isPartial, false);
    assert.deepEqual(
      toolCalls.map((call) => call.toolName),
      ["getQuote", "getKeyMetrics"],
    );

    // El quote corrió en el paso 0, dos pasos antes de la respuesta.
    const [previousClose, peRatio] = answer.dataPoints;
    assert.deepEqual(previousClose.source, {
      provider: "fixture",
      endpoint: "quote",
      fetchedAt: "2025-01-31T21:00:00.000Z",
    });
    assert.equal(peRatio.source.endpoint, "metric");
    assert.equal(answer.dataPoints.length, 2);
    assert.deepEqual(answer.unavailable, [
      { label: "Dividend yield", ticker: "AAPL", reason: UNVERIFIED_REASON },
    ]);
  });

  it("shows the toolCallId to the model inside the tool result", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStep([{ id: "call-quote", tool: "getQuote", input: { ticker: "AAPL" } }]),
        answerStep({ summary: "ok", dataPoints: [], unavailable: [] }),
      ],
    });

    const { completion } = await run(model);
    await completion;

    const toolResult = model.doStreamCalls[1].prompt
      .filter((message) => message.role === "tool")
      .flatMap((message) => message.content)
      .find((part) => part.type === "tool-result" && part.toolCallId === "call-quote");
    assert.ok(toolResult && toolResult.type === "tool-result");
    assert.equal(toolResult.output.type, "text");
    const seen: unknown = JSON.parse(toolResult.output.type === "text" ? toolResult.output.value : "null");
    assert.ok(typeof seen === "object" && seen !== null && "toolCallId" in seen && "result" in seen);
    assert.equal(seen.toolCallId, "call-quote");
  });

  it("forces the final answer on the last allowed step (task 3.4)", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStep([{ id: "call-quote", tool: "getQuote", input: { ticker: "AAPL" } }]),
        answerStep({
          summary: "Solo llegué a la cotización.",
          dataPoints: [{ label: "Price", value: 236, unit: "USD", ticker: "AAPL", toolCallId: "call-quote" }],
          unavailable: [{ label: "P/E", ticker: "AAPL", reason: "step limit" }],
        }),
        // Si hubiera un tercer paso, usaría esta respuesta y el test lo detecta.
        answerStep({ summary: "third step", dataPoints: [], unavailable: [] }),
      ],
    });

    const { completion } = await run(model, 2);
    const { answer, stepCount } = await completion;

    assert.equal(model.doStreamCalls.length, 2, "there is no third model call");
    assert.equal(stepCount, 2);
    assert.equal(answer.isPartial, true);

    const [firstCall, lastCall] = model.doStreamCalls;
    assert.ok((firstCall.tools ?? []).length === 3, "the first step has the three tools");
    assert.equal((lastCall.tools ?? []).length, 0, "the last step has no tools");
    const lastSystemPrompt = lastCall.prompt
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n");
    assert.ok(lastSystemPrompt.includes(STEP_LIMIT_NOTICE));
  });

  it("rejects completion when the model output does not match the schema", async () => {
    const model = new MockLanguageModelV4({
      doStream: [answerStep({ summary: "sin dataPoints", unavailable: [] })],
    });

    const { completion } = await run(model);
    await assert.rejects(completion);
  });
});

// Chequeo de tipos: el mensaje de UI conoce las tres herramientas y la parte
// `data-answer`. Si la inferencia se rompiera, estos tipos serían `never` y
// `tsc` fallaría.
type UITools = MarketDataUIMessage extends UIMessage<unknown, DataParts, infer TOOLS> ? TOOLS : never;
type DataParts = MarketDataUIMessage extends UIMessage<unknown, infer DATA> ? DATA : never;
const toolNames: Array<keyof UITools> = ["getQuote", "getHistoricalPrices", "getKeyMetrics"];
const dataPartNames: Array<keyof DataParts> = ["answer"];
void toolNames;
void dataPartNames;
