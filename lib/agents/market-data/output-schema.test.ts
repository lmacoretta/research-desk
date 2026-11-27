import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  marketDataAnswerSchema,
  modelAnswerSchema,
} from "@/lib/agents/market-data/output-schema";
import {
  buildMarketDataInstructions,
  formatReferenceDate,
} from "@/lib/agents/market-data/prompt";

/* Tarea 3.1: esquemas de la respuesta y fecha de referencia del prompt. */

const MODEL_ANSWER = {
  summary: "AAPL cotiza a 236 USD.",
  dataPoints: [
    { label: "Price", value: 236, unit: "USD", ticker: "AAPL", toolCallId: "call-1" },
  ],
  unavailable: [{ label: "News", ticker: null, reason: "out of scope" }],
};

const FINAL_ANSWER = {
  summary: MODEL_ANSWER.summary,
  dataPoints: [
    {
      ...MODEL_ANSWER.dataPoints[0],
      source: { provider: "fixture", endpoint: "quote", fetchedAt: "2025-01-31T21:00:00.000Z" },
    },
  ],
  isPartial: false,
  unavailable: MODEL_ANSWER.unavailable,
};

describe("modelAnswerSchema (task 3.1)", () => {
  it("accepts a well-formed answer, including an empty dataPoints list", () => {
    assert.ok(modelAnswerSchema.safeParse(MODEL_ANSWER).success);
    assert.ok(modelAnswerSchema.safeParse({ ...MODEL_ANSWER, dataPoints: [] }).success);
  });

  it("rejects an object without dataPoints", () => {
    const withoutDataPoints = { summary: MODEL_ANSWER.summary, unavailable: MODEL_ANSWER.unavailable };
    assert.equal(modelAnswerSchema.safeParse(withoutDataPoints).success, false);
  });

  it("rejects extra fields at the top level and inside a data point", () => {
    assert.equal(modelAnswerSchema.safeParse({ ...MODEL_ANSWER, extra: 1 }).success, false);
    // El modelo no puede escribir la fuente: `source` es un campo extra.
    const withSource = {
      ...MODEL_ANSWER,
      dataPoints: [{ ...MODEL_ANSWER.dataPoints[0], source: { provider: "finnhub" } }],
    };
    assert.equal(modelAnswerSchema.safeParse(withSource).success, false);
  });

  it("rejects units outside the closed set", () => {
    const withPercentSign = {
      ...MODEL_ANSWER,
      dataPoints: [{ ...MODEL_ANSWER.dataPoints[0], unit: "%" }],
    };
    assert.equal(modelAnswerSchema.safeParse(withPercentSign).success, false);
  });
});

describe("marketDataAnswerSchema (task 3.1)", () => {
  it("accepts a verified answer", () => {
    assert.ok(marketDataAnswerSchema.safeParse(FINAL_ANSWER).success);
  });

  it("rejects an object without dataPoints", () => {
    const withoutDataPoints = {
      summary: FINAL_ANSWER.summary,
      isPartial: FINAL_ANSWER.isPartial,
      unavailable: FINAL_ANSWER.unavailable,
    };
    assert.equal(marketDataAnswerSchema.safeParse(withoutDataPoints).success, false);
  });

  it("rejects extra fields and requires isPartial and source", () => {
    assert.equal(marketDataAnswerSchema.safeParse({ ...FINAL_ANSWER, extra: 1 }).success, false);
    const withoutIsPartial = {
      summary: FINAL_ANSWER.summary,
      dataPoints: FINAL_ANSWER.dataPoints,
      unavailable: FINAL_ANSWER.unavailable,
    };
    assert.equal(marketDataAnswerSchema.safeParse(withoutIsPartial).success, false);
    // Un dato sin fuente (la forma del modelo) no es una respuesta final válida.
    assert.equal(marketDataAnswerSchema.safeParse({ ...FINAL_ANSWER, dataPoints: MODEL_ANSWER.dataPoints }).success, false);
  });
});

describe("reference date in the instructions (task 3.1)", () => {
  it("formats the UTC date with its weekday", () => {
    assert.equal(formatReferenceDate(new Date("2026-11-27T12:00:00Z")), "2026-11-27 (Friday)");
    // 23:30 en UTC-3 ya es el día siguiente en UTC: manda UTC, como en las herramientas.
    assert.equal(formatReferenceDate(new Date("2025-02-01T02:30:00Z")), "2025-02-01 (Saturday)");
  });

  it("injects the date and leaves no placeholder", () => {
    const instructions = buildMarketDataInstructions(new Date("2025-01-31T21:00:00Z"));
    assert.match(instructions, /today is 2025-01-31 \(Friday\)\./);
    assert.ok(!instructions.includes("{referenceDate}"));
  });
});
