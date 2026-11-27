import "server-only";
import { z } from "zod";

import { MAX_QUESTION_CHARS } from "@/lib/agents/market-data/config";

/*
 * Cuerpo del request del endpoint (Decisión 7 del design).
 *
 * - `.strict()`: un campo desconocido (por ejemplo, un historial `messages`)
 *   es un error, no algo que se ignora.
 * - `trim` antes de medir: una pregunta de solo espacios es vacía, y el tope
 *   de caracteres se aplica al texto que llega al modelo.
 */
export const marketDataRequestSchema = z
  .object({
    question: z.string().trim().min(1).max(MAX_QUESTION_CHARS),
  })
  .strict();

export type MarketDataRequest = z.infer<typeof marketDataRequestSchema>;
