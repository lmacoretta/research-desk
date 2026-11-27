import "server-only";
import { z } from "zod";

import type {
  ModelDataPoint,
  UnavailableItem,
  VerifiedDataPoint,
} from "@/lib/agents/market-data/output-schema";
import { provenanceSchema } from "@/lib/market-data/schemas";

/*
 * Verificación de fuentes (Decisión 6 del design).
 *
 * El modelo cita cada dato con el `toolCallId` de la llamada de donde lo sacó.
 * El servidor cruza esa cita con los resultados reales de herramientas de
 * TODOS los pasos de la consulta y:
 * - si el `toolCallId` es de un resultado `ok: true` y el ticker coincide con
 *   el de ese resultado, completa `source` copiando la procedencia del
 *   resultado real;
 * - si no, saca el dato de `dataPoints` y lo agrega a `unavailable` como
 *   "no verificado".
 *
 * El chequeo de ticker es un agregado sobre el design: sin él, un precio de
 * MSFT citado con el `toolCallId` de una llamada de AAPL saldría con una
 * fuente válida pero equivocada.
 *
 * Los resultados se leen como `unknown` y se validan con zod: el output de una
 * herramienta es dato no confiable aunque lo hayamos producido nosotros.
 */

export const UNVERIFIED_REASON = "no verificado";

/** Lo mínimo que se necesita de un resultado de herramienta del AI SDK. */
export type ToolResultRecord = {
  toolCallId: string;
  output: unknown;
};

// Solo interesa la procedencia de los resultados exitosos; el resto de los
// campos (`data`) se ignora.
const successfulResultSchema = z.object({
  ok: z.literal(true),
  provenance: provenanceSchema,
});

export type VerifiedSources = {
  dataPoints: VerifiedDataPoint[];
  unverified: UnavailableItem[];
};

export function verifySources(
  dataPoints: readonly ModelDataPoint[],
  toolResults: readonly ToolResultRecord[],
): VerifiedSources {
  const provenanceByCallId = new Map(
    toolResults.flatMap((result) => {
      const parsed = successfulResultSchema.safeParse(result.output);
      return parsed.success
        ? [[result.toolCallId, parsed.data.provenance] as const]
        : [];
    }),
  );

  const verified: VerifiedDataPoint[] = [];
  const unverified: UnavailableItem[] = [];

  for (const dataPoint of dataPoints) {
    const provenance = provenanceByCallId.get(dataPoint.toolCallId);
    if (provenance && provenance.ticker === dataPoint.ticker) {
      verified.push({
        ...dataPoint,
        source: {
          provider: provenance.provider,
          endpoint: provenance.endpoint,
          fetchedAt: provenance.fetchedAt,
        },
      });
    } else {
      unverified.push({
        label: dataPoint.label,
        ticker: dataPoint.ticker,
        reason: UNVERIFIED_REASON,
      });
    }
  }

  return { dataPoints: verified, unverified };
}
