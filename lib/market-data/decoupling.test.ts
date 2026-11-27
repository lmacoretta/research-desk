import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { tickerSchema } from "@/lib/market-data/schemas";
import { createFixtureSource } from "@/lib/market-data/source/fixtures";
// Este archivo importa solo `lib/market-data`: si las herramientas dependieran
// del agente, la UI o el endpoint, esa dependencia aparecería acá.
import { createMarketDataTools } from "@/lib/market-data/tools";

/*
 * Requisito "Herramientas desacopladas del agente" (spec market-data-tools).
 * Dos comprobaciones: las herramientas se usan sin cargar nada del agente, y
 * ningún archivo de `lib/market-data` importa de `lib/agents` ni de `app/`.
 */

const MODULE_DIR = path.join(process.cwd(), "lib", "market-data");
const ROOT = process.cwd();

// `from "…"`, `import("…")` y `require("…")`.
const IMPORT_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(ts|tsx|mts|js|mjs)$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/** Resuelve un specifier a una ruta relativa a la raíz del repo, si es local. */
function resolveLocal(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith("@/")) return specifier.slice(2);
  if (specifier.startsWith(".")) {
    return path
      .relative(ROOT, path.resolve(path.dirname(fromFile), specifier))
      .split(path.sep)
      .join("/");
  }
  return null;
}

describe("market-data module decoupling", () => {
  it("can use the tools without loading agent code", async () => {
    const tools = createMarketDataTools(createFixtureSource());
    assert.deepEqual(Object.keys(tools).sort(), [
      "getHistoricalPrices",
      "getKeyMetrics",
      "getQuote",
    ]);
    assert.ok(tools.getQuote.execute);
    const result = await tools.getQuote.execute(
      { ticker: tickerSchema.parse("AAPL") },
      { toolCallId: "call-1", messages: [], context: {} },
    );
    assert.equal(
      typeof result === "object" && result !== null && "ok" in result && result.ok,
      true,
    );
  });

  it("no file in lib/market-data imports from lib/agents or app/", async () => {
    // Este test se excluye: sus ejemplos del autotest son imports prohibidos.
    const self = path.join(MODULE_DIR, "decoupling.test.ts");
    const files = (await listSourceFiles(MODULE_DIR)).filter((file) => file !== self);
    assert.ok(files.length > 0, "expected source files in lib/market-data");

    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const match of text.matchAll(IMPORT_PATTERN)) {
        const target = resolveLocal(match[1], file);
        if (target && /^(lib\/agents|app)(\/|$)/.test(target)) {
          offenders.push(`${path.relative(ROOT, file)} → ${match[1]}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("detects a forbidden import (self-check of the scanner)", () => {
    const fake = path.join(MODULE_DIR, "source", "x.ts");
    const samples = [
      'import { a } from "@/lib/agents/market-data/agent";',
      'import x from "../../agents/market-data/run";',
      'const m = await import("@/app/page");',
    ];
    for (const sample of samples) {
      const [match] = [...sample.matchAll(IMPORT_PATTERN)];
      assert.ok(match, sample);
      const target = resolveLocal(match[1], fake);
      assert.ok(target && /^(lib\/agents|app)(\/|$)/.test(target), sample);
    }
  });
});
