import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateText, isStepCount } from "ai";
import { MockLanguageModelV4 } from "ai/test";

import { quoteResultSchema } from "@/lib/market-data/schemas";
import {
  createFinnhubSource,
  type FetchLike,
} from "@/lib/market-data/source/finnhub";
import { createMarketDataTools } from "@/lib/market-data/tools";

/*
 * Tarea 2.7: camino del input inválido (Decisión 4 del design).
 *
 * Con un modelo simulado de `ai/test` (sin red ni créditos) se corre un loop
 * real de dos pasos del AI SDK:
 *   1. el modelo pide `getQuote` dos veces: con `aapl` (inválido) y con `AAPL`;
 *   2. el modelo responde texto.
 * Se verifica que la llamada inválida no ejecuta la herramienta ni toca la
 * fuente, que produce un `tool-error`, y qué recibe el modelo en el paso 2.
 */

const SECRET = "SENTINEL_FINNHUB_KEY";

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

const APPLE_QUOTE = { c: 236, d: -1.59, dp: -0.6692, h: 240.44, l: 232.7, o: 237.59, pc: 237.59, t: 1738357200 };

async function runInvalidCallScenario() {
  // Fuente en vivo real con `fetch` falso: cuenta requests y lleva la clave
  // centinela, así se puede comprobar que no llega al modelo.
  const requests: URL[] = [];
  const fetch: FetchLike = async (url) => {
    requests.push(url);
    return new Response(JSON.stringify(APPLE_QUOTE), { status: 200 });
  };
  const source = createFinnhubSource({ apiKey: SECRET, fetch, log: () => undefined });

  const model = new MockLanguageModelV4({
    doGenerate: [
      {
        content: [
          { type: "tool-call", toolCallId: "call-invalid", toolName: "getQuote", input: '{"ticker":"aapl"}' },
          { type: "tool-call", toolCallId: "call-valid", toolName: "getQuote", input: '{"ticker":"AAPL"}' },
        ],
        finishReason: { unified: "tool-calls", raw: undefined },
        usage: USAGE,
        warnings: [],
      },
      {
        content: [{ type: "text", text: "done" }],
        finishReason: { unified: "stop", raw: undefined },
        usage: USAGE,
        warnings: [],
      },
    ],
  });

  const result = await generateText({
    model,
    tools: createMarketDataTools(source),
    stopWhen: isStepCount(2),
    prompt: "Quote for Apple",
  });

  return { result, model, requests };
}

describe("invalid tool input (task 2.7)", () => {
  it("does not execute the tool nor reach the source for an invalid ticker", async () => {
    const { requests } = await runInvalidCallScenario();

    // Solo la llamada válida llegó a Finnhub.
    assert.equal(requests.length, 1);
    assert.equal(requests[0].searchParams.get("symbol"), "AAPL");
  });

  it("produces a tool-error for the invalid call and a result for the valid one", async () => {
    const { result } = await runInvalidCallScenario();
    const [firstStep] = result.steps;

    const invalid = firstStep.content.find(
      (part) => part.type === "tool-error" && part.toolCallId === "call-invalid",
    );
    assert.ok(invalid, "expected a tool-error for call-invalid");
    assert.equal(invalid.type === "tool-error" && invalid.toolName, "getQuote");
    // El SDK marca la llamada inválida como dinámica: en la UI llega como
    // parte `dynamic-tool`, no como `tool-getQuote` (Decisión 8).
    assert.equal(invalid.type === "tool-error" && invalid.dynamic, true);

    const valid = firstStep.content.find(
      (part) => part.type === "tool-result" && part.toolCallId === "call-valid",
    );
    assert.ok(valid, "expected a tool-result for call-valid");
    // El SDK tipa el output como `unknown`: se lee con el esquema del módulo.
    const output = quoteResultSchema.parse(valid.type === "tool-result" ? valid.output : null);
    assert.ok(output.ok);
    assert.equal(output.data.price, 236);
    assert.equal(output.provenance.provider, "finnhub");
    assert.equal(output.provenance.ticker, "AAPL");
  });

  it("sends the validation message back to the model, without secrets", async () => {
    const { model } = await runInvalidCallScenario();
    assert.equal(model.doGenerateCalls.length, 2);

    // Lo que ve el modelo en el paso 2: el resultado de cada herramienta.
    const toolResults = model.doGenerateCalls[1].prompt
      .filter((message) => message.role === "tool")
      .flatMap((message) => message.content)
      .filter((part) => part.type === "tool-result");

    const invalid = toolResults.find((part) => part.toolCallId === "call-invalid");
    assert.ok(invalid, "the model must receive a result for the invalid call");
    assert.equal(invalid.output.type, "error-text");
    const text = invalid.output.type === "error-text" ? invalid.output.value : "";
    assert.match(text, /aapl/, "the message mentions the ticker the model sent");
    assert.match(text, /Invalid ticker format/, "the message carries the zod reason");

    const everything = JSON.stringify(model.doGenerateCalls);
    assert.ok(!everything.includes(SECRET), "the API key must never reach the model");
    assert.ok(!everything.includes("X-Finnhub-Token"));
  });
});
