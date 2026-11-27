/*
 * Genera los fixtures de `evals/fixtures/finnhub/{quote,candle,metric}/` para
 * AAPL, MSFT y NVDA.
 *
 * Los datos son SINTÉTICOS y existen solo para las evals y los tests: los
 * cierres de enero de 2025 son aproximaciones, y apertura, máximo, mínimo,
 * volumen y métricas se derivan con fórmulas fijas. No son datos de mercado
 * reales ni deben usarse como tales.
 *
 * - Respetan la forma exacta de las respuestas de Finnhub, para que el modo
 *   fixtures pase por el mismo parseo y validación que el modo en vivo.
 * - Son deterministas: correr el script de nuevo produce los mismos archivos.
 * - La cotización es la del cierre del 2025-01-31, y a MSFT le falta
 *   `revenueGrowthTTMYoy` a propósito (caso "métrica faltante → null").
 *
 * Uso: node scripts/gen-fixtures.mjs [outDir]
 * (por defecto, evals/fixtures/finnhub; sobrescribe los archivos existentes)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2] ?? join("evals", "fixtures", "finnhub");

// Días hábiles de enero 2025 (cerrado 1, 9, 20).
const days = [2, 3, 6, 7, 8, 10, 13, 14, 15, 16, 17, 21, 22, 23, 24, 27, 28, 29, 30, 31];

const closes = {
  AAPL: [243.85, 243.36, 245.0, 242.21, 242.7, 236.85, 234.4, 233.28, 237.87, 228.26, 229.98, 222.64, 223.83, 223.66, 222.78, 229.86, 238.26, 239.36, 237.59, 236.0],
  MSFT: [418.58, 423.35, 427.85, 422.37, 424.56, 418.95, 417.19, 415.67, 426.31, 424.58, 429.03, 428.5, 446.2, 446.71, 444.06, 434.56, 447.2, 442.33, 414.99, 415.06],
  NVDA: [138.31, 144.47, 149.43, 140.14, 140.11, 135.91, 133.23, 131.76, 136.24, 133.57, 137.71, 140.83, 147.07, 147.22, 142.62, 118.42, 128.99, 123.7, 124.65, 120.07],
};
const firstOpen = { AAPL: 248.93, MSFT: 425.53, NVDA: 136.0 };
const baseVolume = { AAPL: 55_000_000, MSFT: 20_000_000, NVDA: 250_000_000 };

const metrics = {
  AAPL: { peTTM: 37.8, grossMarginTTM: 46.21, operatingMarginTTM: 31.51, netProfitMarginTTM: 23.97, revenueGrowthTTMYoy: 2.02, epsGrowthTTMYoy: -0.34 },
  // MSFT sin revenueGrowthTTMYoy: cubre "métrica faltante → null".
  MSFT: { peTTM: 34.6, grossMarginTTM: 69.35, operatingMarginTTM: 44.96, netProfitMarginTTM: 35.43, epsGrowthTTMYoy: 10.3 },
  NVDA: { peTTM: 54.3, grossMarginTTM: 75.86, operatingMarginTTM: 62.06, netProfitMarginTTM: 55.69, revenueGrowthTTMYoy: 152.4, epsGrowthTTMYoy: 168.1 },
};
const extraMetrics = {
  AAPL: { "52WeekHigh": 260.1, "52WeekLow": 164.08, beta: 1.24, marketCapitalization: 3545000 },
  MSFT: { "52WeekHigh": 468.35, "52WeekLow": 385.58, beta: 0.9, marketCapitalization: 3086000 },
  NVDA: { "52WeekHigh": 153.13, "52WeekLow": 60.7, beta: 1.66, marketCapitalization: 2940000 },
};

const r2 = (n) => Math.round(n * 100) / 100;
const write = (dir, ticker, body) => {
  mkdirSync(join(out, dir), { recursive: true });
  writeFileSync(join(out, dir, `${ticker}.json`), JSON.stringify(body, null, 2) + "\n");
};

for (const [ticker, c] of Object.entries(closes)) {
  const o = c.map((_, i) => (i === 0 ? firstOpen[ticker] : r2(c[i - 1] * (1 + ((i % 3) - 1) * 0.004))));
  const h = c.map((close, i) => r2(Math.max(close, o[i]) * (1 + 0.006 + (i % 4) * 0.002)));
  const l = c.map((close, i) => r2(Math.min(close, o[i]) * (1 - 0.006 - (i % 5) * 0.002)));
  const v = c.map((_, i) => baseVolume[ticker] + ((i * 7919) % 13) * 1_000_000);
  // Velas de Finnhub: timestamp unix de medianoche UTC de cada día.
  const t = days.map((d) => Date.UTC(2025, 0, d) / 1000);
  write("candle", ticker, { c, h, l, o, s: "ok", t, v });

  // Cotización al cierre del 2025-01-31 (16:00 ET = 21:00 UTC).
  const last = c.length - 1;
  const pc = c[last - 1];
  write("quote", ticker, {
    c: c[last],
    d: r2(c[last] - pc),
    dp: Math.round(((c[last] - pc) / pc) * 100 * 10000) / 10000,
    h: h[last],
    l: l[last],
    o: o[last],
    pc,
    t: Date.UTC(2025, 0, 31, 21) / 1000,
  });

  write("metric", ticker, {
    metric: { ...extraMetrics[ticker], ...metrics[ticker] },
    metricType: "all",
    series: {},
    symbol: ticker,
  });
}
console.log("ok");
