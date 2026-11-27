import "server-only";
import type { z } from "zod";

import type { ToolError, ToolErrorCode } from "@/lib/market-data/schemas";

export type { ToolError, ToolErrorCode } from "@/lib/market-data/schemas";

/*
 * Errores tipados del módulo de market data.
 *
 * Diseño:
 * - Los mensajes son fijos por código. Nunca se arman con texto de la fuente,
 *   del error de red ni de zod: así no pueden filtrar URLs, credenciales ni
 *   detalles internos al modelo o al cliente. El detalle va solo al log.
 * - El mapeo HTTP → código vive en un solo lugar para que el cliente de Finnhub
 *   y los tests compartan la misma tabla.
 */

const MESSAGES: Record<ToolErrorCode, string> = {
  INVALID_TICKER:
    "The ticker is not valid. Use 1-5 uppercase letters, optionally followed by a dot and 1-2 letters (e.g. BRK.B).",
  INVALID_INPUT: "The request parameters are not valid.",
  NOT_FOUND: "No data was found for this ticker.",
  RATE_LIMITED: "The data provider rate limit was reached. Try again later.",
  ACCESS_DENIED: "This data is not available with the current data plan.",
  UPSTREAM_UNAVAILABLE: "The data provider is unavailable right now.",
};

export function toolError(code: ToolErrorCode): ToolError {
  return { code, message: MESSAGES[code] };
}

/**
 * Mapea un status HTTP de error de la fuente a un código.
 * Cualquier otro status no exitoso (400, 404, 3xx…) es inesperado porque los
 * parámetros ya se validaron: se trata como fuente no disponible.
 */
export function errorCodeFromHttpStatus(status: number): ToolErrorCode {
  if (status === 429) return "RATE_LIMITED";
  if (status === 401 || status === 403) return "ACCESS_DENIED";
  return "UPSTREAM_UNAVAILABLE";
}

/**
 * Convierte un error de validación de input en un error tipado.
 * Si el problema está en el ticker gana `INVALID_TICKER`; cualquier otro
 * (fechas, rango, campos desconocidos) es `INVALID_INPUT`.
 */
export function toolErrorFromInputIssues(error: z.ZodError): ToolError {
  const tickerIssue = error.issues.some((issue) => issue.path[0] === "ticker");
  return toolError(tickerIssue ? "INVALID_TICKER" : "INVALID_INPUT");
}
