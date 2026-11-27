import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APICallError, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

import { runMarketDataAgent } from "@/lib/agents/market-data/run";
import {
  createToolErrorRedactor,
  toMarketDataUIStream,
  type MarketDataUIChunk,
} from "@/lib/agents/market-data/ui-stream";
import { toolErrorSchema } from "@/lib/market-data/schemas";
import { createFixtureSource } from "@/lib/market-data/source/fixtures";
import { createMarketDataInputSchemas } from "@/lib/market-data/tools";

/*
 * Tarea 4.1: reemplazo del `errorText` de los errores de herramienta
 * (Decisión 4) y armado del stream de UI (Decisión 7).
 *
 * - Unitarios sobre `createToolErrorRedactor` con chunks armados a mano.
 * - De punta a punta: el agente con un modelo simulado de `ai/test` y los
 *   fixtures, leyendo los chunks que saldrían hacia el cliente.
 */

const REFERENCE_DATE = new Date("2025-01-31T21:00:00.000Z");
const SDK_TEXT = "Invalid input for tool getQuote: Type validation failed: Invalid ticker format";
const GENERIC_ERROR = "generic error with reference";

const inputSchemas = createMarketDataInputSchemas(() => REFERENCE_DATE);

function parseErrorText(chunk: MarketDataUIChunk | undefined) {
  assert.ok(
    chunk && (chunk.type === "tool-input-error" || chunk.type === "tool-output-error"),
    "expected a tool error chunk",
  );
  return toolErrorSchema.parse(JSON.parse(chunk.errorText));
}

function inputError(toolCallId: string, toolName: string, input: unknown): MarketDataUIChunk {
  return {
    type: "tool-input-error",
    toolCallId,
    toolName,
    input,
    dynamic: true,
    errorText: SDK_TEXT,
  };
}

describe("createToolErrorRedactor (task 4.1)", () => {
  it("maps an invalid ticker to INVALID_TICKER", () => {
    const redact = createToolErrorRedactor(inputSchemas);
    const error = parseErrorText(redact(inputError("call-1", "getQuote", { ticker: "aapl" })));
    assert.equal(error.code, "INVALID_TICKER");
  });

  it("maps an extra field to INVALID_INPUT", () => {
    const redact = createToolErrorRedactor(inputSchemas);
    const error = parseErrorText(
      redact(inputError("call-1", "getKeyMetrics", { ticker: "AAPL", period: "annual" })),
    );
    assert.equal(error.code, "INVALID_INPUT");
  });

  it("maps a bad date range and an unknown tool to INVALID_INPUT", () => {
    const redact = createToolErrorRedactor(inputSchemas);
    const inverted = parseErrorText(
      redact(inputError("call-1", "getHistoricalPrices", { ticker: "AAPL", from: "2025-01-10", to: "2025-01-01" })),
    );
    const unknownTool = parseErrorText(redact(inputError("call-2", "getNews", { ticker: "AAPL" })));
    assert.equal(inverted.code, "INVALID_INPUT");
    assert.equal(unknownTool.code, "INVALID_INPUT");
  });

  it("gives the tool-output-error of the same call the same text", () => {
    const redact = createToolErrorRedactor(inputSchemas);
    const input = redact(inputError("call-1", "getQuote", { ticker: "aapl" }));
    const output = redact({ type: "tool-output-error", toolCallId: "call-1", errorText: SDK_TEXT });

    assert.ok(input.type === "tool-input-error" && output.type === "tool-output-error");
    assert.equal(output.errorText, input.errorText);
  });

  it("maps any other tool-output-error to UPSTREAM_UNAVAILABLE", () => {
    const redact = createToolErrorRedactor(inputSchemas);
    const output = redact({ type: "tool-output-error", toolCallId: "call-9", errorText: "socket hang up at 10.0.0.1" });
    assert.equal(parseErrorText(output).code, "UPSTREAM_UNAVAILABLE");
  });

  it("never lets the original SDK text through", () => {
    const redact = createToolErrorRedactor(inputSchemas);
    const chunks = [
      redact(inputError("call-1", "getQuote", { ticker: "aapl" })),
      redact(inputError("call-2", "getQuote", "{not json")),
      redact({ type: "tool-output-error", toolCallId: "call-1", errorText: SDK_TEXT }),
      redact({ type: "tool-output-error", toolCallId: "call-3", errorText: SDK_TEXT }),
    ];
    for (const chunk of chunks) {
      assert.ok("errorText" in chunk);
      assert.ok(!chunk.errorText.includes(SDK_TEXT));
      assert.ok(!chunk.errorText.includes("Type validation failed"));
    }
  });

  it("leaves other chunks untouched", () => {
    const redact = createToolErrorRedactor(inputSchemas);
    const chunk: MarketDataUIChunk = { type: "tool-output-available", toolCallId: "call-1", output: { ok: true } };
    assert.equal(redact(chunk), chunk);
  });
});

// --- De punta a punta con modelo simulado -----------------------------------

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

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
  const chunks: StreamPart[] = [
    { type: "text-start", id: "answer" },
    { type: "text-delta", id: "answer", delta: JSON.stringify(answer) },
    { type: "text-end", id: "answer" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: FINISH_USAGE },
  ];
  return { stream: simulateReadableStream({ chunks }) };
}

async function collectChunks(model: MockLanguageModelV4) {
  const errors: unknown[] = [];
  const run = await runMarketDataAgent({
    question: "¿Cuánto cotiza AAPL?",
    correlationId: "test-correlation-id",
    source: createFixtureSource(),
    referenceDate: REFERENCE_DATE,
    model,
  });
  const stream = toMarketDataUIStream({
    run,
    inputSchemas,
    errorText: GENERIC_ERROR,
    logError: (error) => errors.push(error),
  });

  // Con un reader: los tipos DOM del proyecto no declaran `ReadableStream`
  // como iterable asíncrono.
  const chunks: MarketDataUIChunk[] = [];
  const reader = stream.getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    chunks.push(next.value);
  }
  return { chunks, errors };
}

describe("toMarketDataUIStream with a simulated model (task 4.1)", () => {
  it("streams tool parts, redacts invalid calls and ends with the verified answer", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStep([
          { id: "call-invalid", tool: "getQuote", input: { ticker: "aapl" } },
          { id: "call-extra", tool: "getQuote", input: { ticker: "AAPL", exchange: "US" } },
          { id: "call-quote", tool: "getQuote", input: { ticker: "AAPL" } },
        ]),
        answerStep({
          summary: "AAPL cotiza a 236 USD.",
          dataPoints: [{ label: "Price", value: 236, unit: "USD", ticker: "AAPL", toolCallId: "call-quote" }],
          unavailable: [],
        }),
      ],
    });

    const { chunks, errors } = await collectChunks(model);
    const types = chunks.map((chunk) => chunk.type);

    assert.deepEqual(errors, []);
    // El JSON del objeto estructurado a medio generar no sale.
    assert.ok(!types.some((type) => type.startsWith("text-")));
    // `data-answer` y `finish` cierran el stream, en ese orden.
    assert.deepEqual(types.slice(-2), ["data-answer", "finish"]);

    // La llamada válida sale como pendiente y después con su resultado.
    assert.ok(chunks.some((chunk) => chunk.type === "tool-input-available" && chunk.toolCallId === "call-quote"));
    assert.ok(chunks.some((chunk) => chunk.type === "tool-output-available" && chunk.toolCallId === "call-quote"));

    // Las inválidas salen con el código tipado, sin el texto del SDK.
    const invalid = chunks.find((chunk) => chunk.type === "tool-input-error" && chunk.toolCallId === "call-invalid");
    const extra = chunks.find((chunk) => chunk.type === "tool-input-error" && chunk.toolCallId === "call-extra");
    assert.equal(parseErrorText(invalid).code, "INVALID_TICKER");
    assert.equal(parseErrorText(extra).code, "INVALID_INPUT");
    for (const chunk of chunks) {
      if (chunk.type === "tool-input-error" || chunk.type === "tool-output-error") {
        assert.doesNotThrow(() => toolErrorSchema.parse(JSON.parse(chunk.errorText)));
        assert.ok(!chunk.errorText.includes("validation"), chunk.errorText);
      }
    }

    const answer = chunks.find((chunk) => chunk.type === "data-answer");
    assert.ok(answer && answer.type === "data-answer");
    assert.equal(answer.data.dataPoints.length, 1);
    assert.equal(answer.data.dataPoints[0].source.provider, "fixture");
  });

  it("the model still receives the original validation message", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStep([{ id: "call-invalid", tool: "getQuote", input: { ticker: "aapl" } }]),
        answerStep({ summary: "ok", dataPoints: [], unavailable: [] }),
      ],
    });

    await collectChunks(model);

    const seen = JSON.stringify(model.doStreamCalls[1].prompt);
    assert.match(seen, /aapl/);
    assert.match(seen, /Invalid ticker format/);
  });

  it("sends a single generic error and logs once when the answer does not validate", async () => {
    const model = new MockLanguageModelV4({
      doStream: [answerStep({ summary: "sin dataPoints", unavailable: [] })],
    });

    const { chunks, errors } = await collectChunks(model);
    const errorChunks = chunks.filter((chunk) => chunk.type === "error");

    assert.equal(errors.length, 1, "the failure is logged once");
    assert.equal(errorChunks.length, 1);
    assert.ok(errorChunks[0].type === "error" && errorChunks[0].errorText === GENERIC_ERROR);
    assert.ok(!chunks.some((chunk) => chunk.type === "data-answer" || chunk.type === "finish"));
  });

  it("on a model error, the agent logs it once with the correlationId and the client gets only the generic text (task 4.3)", async (t) => {
    const consoleError = t.mock.method(console, "error", () => undefined);
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new APICallError({
          message: "provider detail: invalid credential",
          url: "https://gateway.invalid/v1/responses",
          requestBodyValues: {},
          statusCode: 401,
        });
      },
    });

    const { chunks, errors } = await collectChunks(model);
    const errorChunks = chunks.filter((chunk) => chunk.type === "error");

    // Una sola línea de log, la del agente, con la referencia y el detalle.
    assert.equal(consoleError.mock.callCount(), 1);
    const logged = JSON.stringify(consoleError.mock.calls[0].arguments);
    assert.match(logged, /test-correlation-id/);
    assert.match(logged, /provider detail/);
    assert.match(logged, /"statusCode":401/);
    // No se vuelve a registrar desde `completion`.
    assert.deepEqual(errors, []);

    assert.equal(errorChunks.length, 1);
    assert.ok(errorChunks[0].type === "error" && errorChunks[0].errorText === GENERIC_ERROR);
    assert.ok(!JSON.stringify(chunks).includes("provider detail"));
  });
});
