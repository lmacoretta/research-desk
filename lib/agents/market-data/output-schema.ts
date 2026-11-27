import "server-only";
import { z } from "zod";

import { endpointSchema, providerSchema } from "@/lib/market-data/schemas";

/*
 * Esquemas de la respuesta del agente (Decisiones 5 y 6 del design).
 *
 * Hay dos esquemas a propósito:
 * - `modelAnswerSchema`: lo que genera el modelo con `Output.object`. Cada
 *   dato trae el `toolCallId` de la llamada de donde salió, pero no su
 *   procedencia: el modelo no la escribe, así que no la puede inventar.
 * - `marketDataAnswerSchema`: la respuesta final que arma el servidor. Cada
 *   dato verificado lleva `source` copiada del resultado real de la
 *   herramienta, y `isPartial` lo decide el servidor según el límite de pasos.
 *
 * Reglas para que el esquema sirva como salida estructurada:
 * - Todos los objetos son `.strict()`: en JSON Schema eso es
 *   `additionalProperties: false`, que exige el modo estricto de OpenAI, y en
 *   zod hace que un campo extra sea un error.
 * - Todos los campos son obligatorios. Lo que puede faltar es `nullable`, no
 *   `optional`, porque el modo estricto no admite propiedades opcionales.
 * - Sin `min`/`max` ni patrones: no todos los modelos del gateway los
 *   respetan. Las reglas de contenido las aplica `verify-sources.ts`.
 */

export const DATA_POINT_UNITS = ["USD", "percent", "ratio", "shares"] as const;
export const dataPointUnitSchema = z.enum(DATA_POINT_UNITS);
export type DataPointUnit = z.infer<typeof dataPointUnitSchema>;

const dataPointFields = {
  label: z.string().describe("What the value is, with the date if it refers to a past day"),
  value: z.number().describe("The number exactly as the tool returned it"),
  unit: dataPointUnitSchema,
  ticker: z.string(),
  toolCallId: z.string().describe("The exact ID of the tool call the value came from"),
};

export const modelDataPointSchema = z.object(dataPointFields).strict();
export type ModelDataPoint = z.infer<typeof modelDataPointSchema>;

export const unavailableItemSchema = z
  .object({
    label: z.string(),
    ticker: z.string().nullable(),
    reason: z.string(),
  })
  .strict();
export type UnavailableItem = z.infer<typeof unavailableItemSchema>;

export const modelAnswerSchema = z
  .object({
    summary: z.string(),
    dataPoints: z.array(modelDataPointSchema),
    unavailable: z.array(unavailableItemSchema),
  })
  .strict();
export type ModelAnswer = z.infer<typeof modelAnswerSchema>;

// --- Respuesta final (servidor) ----------------------------------------------

export const dataPointSourceSchema = z
  .object({
    provider: providerSchema,
    endpoint: endpointSchema,
    fetchedAt: z.iso.datetime(),
  })
  .strict();
export type DataPointSource = z.infer<typeof dataPointSourceSchema>;

export const verifiedDataPointSchema = z
  .object({ ...dataPointFields, source: dataPointSourceSchema })
  .strict();
export type VerifiedDataPoint = z.infer<typeof verifiedDataPointSchema>;

export const marketDataAnswerSchema = z
  .object({
    summary: z.string(),
    dataPoints: z.array(verifiedDataPointSchema),
    isPartial: z.boolean(),
    unavailable: z.array(unavailableItemSchema),
  })
  .strict();
export type MarketDataAnswer = z.infer<typeof marketDataAnswerSchema>;
