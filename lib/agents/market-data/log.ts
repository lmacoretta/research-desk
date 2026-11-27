import "server-only";

/*
 * Registro de errores del agente de market data (solo servidor).
 *
 * - Siempre con el `correlationId` de la consulta: es la referencia que ve el
 *   cliente en el mensaje genérico, y con ella se encuentra el detalle acá.
 * - El detalle se arma a mano en lugar de imprimir el objeto entero: los
 *   errores del provider traen el cuerpo del request (la pregunta, las
 *   instrucciones, el esquema) y de la respuesta, que no hacen falta para
 *   diagnosticar. `EnvError` nombra la variable faltante, nunca su valor.
 */

export type MarketDataErrorStage = "setup" | "model" | "answer";

export function describeError(error: unknown) {
  if (!(error instanceof Error)) {
    return { name: "unknown" };
  }
  const statusCode =
    "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : undefined;
  return {
    name: error.name,
    message: error.message,
    statusCode,
    cause: error.cause instanceof Error ? error.cause.name : undefined,
    stack: error.stack,
  };
}

export function logMarketDataError(
  correlationId: string,
  stage: MarketDataErrorStage,
  error: unknown,
): void {
  console.error("[market-data-agent] request failed", {
    correlationId,
    stage,
    error: describeError(error),
  });
}
