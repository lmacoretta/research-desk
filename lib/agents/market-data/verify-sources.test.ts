import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ModelDataPoint } from "@/lib/agents/market-data/output-schema";
import {
  UNVERIFIED_REASON,
  verifySources,
  type ToolResultRecord,
} from "@/lib/agents/market-data/verify-sources";
import { toolError } from "@/lib/market-data/errors";

/*
 * Tarea 3.2: verificación de fuentes sobre resultados de herramientas.
 * El caso de punta a punta (herramienta en un paso anterior al final, con el
 * loop real del AI SDK) está en run.test.ts.
 */

const QUOTE_PROVENANCE = {
  provider: "fixture",
  endpoint: "quote",
  ticker: "AAPL",
  fetchedAt: "2025-01-31T21:00:00.000Z",
} as const;

const METRIC_PROVENANCE = { ...QUOTE_PROVENANCE, endpoint: "metric" } as const;

// Resultados de dos pasos distintos: el quote en el paso 0, las métricas en el 1.
const RESULTS_BY_STEP: ToolResultRecord[][] = [
  [{ toolCallId: "call-quote", output: { ok: true, data: { price: 236 }, provenance: QUOTE_PROVENANCE } }],
  [
    { toolCallId: "call-metric", output: { ok: true, data: {}, provenance: METRIC_PROVENANCE } },
    { toolCallId: "call-missing", output: { ok: false, error: toolError("NOT_FOUND") } },
  ],
  [], // paso final: solo la respuesta estructurada, sin herramientas
];
const ALL_RESULTS = RESULTS_BY_STEP.flat();

function point(overrides: Partial<ModelDataPoint>): ModelDataPoint {
  return { label: "Price", value: 236, unit: "USD", ticker: "AAPL", toolCallId: "call-quote", ...overrides };
}

describe("verifySources (task 3.2)", () => {
  it("copies the provenance of the real result, also from an earlier step", () => {
    const { dataPoints, unverified } = verifySources(
      [point({}), point({ label: "P/E", value: 37.2, unit: "ratio", toolCallId: "call-metric" })],
      ALL_RESULTS,
    );

    assert.equal(unverified.length, 0);
    assert.deepEqual(dataPoints[0].source, {
      provider: "fixture",
      endpoint: "quote",
      fetchedAt: "2025-01-31T21:00:00.000Z",
    });
    assert.equal(dataPoints[1].source.endpoint, "metric");
    // El resto del dato queda como lo escribió el modelo.
    assert.equal(dataPoints[0].value, 236);
    assert.equal(dataPoints[0].toolCallId, "call-quote");
  });

  it("moves a data point with an unknown toolCallId to unverified", () => {
    const { dataPoints, unverified } = verifySources([point({ toolCallId: "call-invented" })], ALL_RESULTS);
    assert.equal(dataPoints.length, 0);
    assert.deepEqual(unverified, [{ label: "Price", ticker: "AAPL", reason: UNVERIFIED_REASON }]);
  });

  it("moves a data point that cites an ok: false result to unverified", () => {
    const { dataPoints, unverified } = verifySources([point({ toolCallId: "call-missing" })], ALL_RESULTS);
    assert.equal(dataPoints.length, 0);
    assert.equal(unverified[0].reason, UNVERIFIED_REASON);
  });

  it("moves a data point whose ticker does not match the cited call to unverified", () => {
    const { dataPoints, unverified } = verifySources([point({ ticker: "MSFT" })], ALL_RESULTS);
    assert.equal(dataPoints.length, 0);
    assert.deepEqual(unverified, [{ label: "Price", ticker: "MSFT", reason: UNVERIFIED_REASON }]);
  });

  it("ignores results that do not have the expected shape", () => {
    const malformed: ToolResultRecord[] = [
      { toolCallId: "call-quote", output: { ok: true, provenance: { provider: "somewhere-else" } } },
    ];
    const { dataPoints, unverified } = verifySources([point({})], malformed);
    assert.equal(dataPoints.length, 0);
    assert.equal(unverified.length, 1);
  });
});
