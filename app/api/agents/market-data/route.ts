import { createUIMessageStream, createUIMessageStreamResponse } from "ai";

import { logMarketDataError } from "@/lib/agents/market-data/log";
import { marketDataRequestSchema } from "@/lib/agents/market-data/request";
import { runMarketDataAgent } from "@/lib/agents/market-data/run";
import type { MarketDataUIMessage } from "@/lib/agents/market-data/ui-message";
import { toMarketDataUIStream } from "@/lib/agents/market-data/ui-stream";
import { createMarketDataInputSchemas } from "@/lib/market-data/tools";

/*
 * POST /api/agents/market-data (Decisión 7 del design).
 *
 * - Cuerpo `{ question }` validado con zod `.strict()`. Si falla (JSON
 *   inválido, campo extra, vacía o más de 500 caracteres): 400 genérico, sin
 *   invocar al modelo.
 * - Cada request tiene un `correlationId` que va en el header
 *   `x-correlation-id`, en los mensajes de error al cliente, en los logs y en
 *   la metadata del trace (lo propaga `runMarketDataAgent`).
 * - La respuesta es un UI message stream: partes `tool-*` a medida que corren
 *   las herramientas y, al final, `data-answer` con la respuesta verificada.
 *   La conversión y el filtrado están en `toMarketDataUIStream`.
 * - Errores: al cliente, siempre el mismo texto genérico con la referencia.
 *   El detalle va solo al log del servidor (`logMarketDataError`), una vez
 *   por falla: los errores del modelo los registra el agente (run.ts) y los
 *   demás, este handler. Una configuración faltante (`EnvError`) se detecta
 *   antes de abrir el stream y responde 500; un error durante la consulta
 *   llega como chunk `error` dentro del stream, porque el 200 ya se envió.
 */

const CORRELATION_HEADER = "x-correlation-id";
const INVALID_REQUEST_MESSAGE = "La solicitud no es válida.";

function genericErrorMessage(correlationId: string): string {
  return `No pudimos completar la consulta. Referencia: ${correlationId}`;
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  const correlationId = crypto.randomUUID();
  const headers = { [CORRELATION_HEADER]: correlationId };

  const parsed = marketDataRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: INVALID_REQUEST_MESSAGE },
      { status: 400, headers },
    );
  }

  // La misma fecha es el "hoy" del prompt, el reloj de las herramientas y el
  // de la revalidación de inputs rechazados.
  const referenceDate = new Date();

  let run;
  try {
    run = await runMarketDataAgent({
      question: parsed.data.question,
      correlationId,
      referenceDate,
    });
  } catch (error) {
    logMarketDataError(correlationId, "setup", error);
    return Response.json(
      { error: genericErrorMessage(correlationId) },
      { status: 500, headers },
    );
  }

  const errorText = genericErrorMessage(correlationId);
  const logAnswerError = (error: unknown) =>
    logMarketDataError(correlationId, "answer", error);

  const stream = createUIMessageStream<MarketDataUIMessage>({
    execute: ({ writer }) => {
      writer.merge(
        toMarketDataUIStream({
          run,
          inputSchemas: createMarketDataInputSchemas(() => referenceDate),
          errorText,
          logError: logAnswerError,
        }),
      );
    },
    // Fallas del propio armado del stream (no del agente): log + genérico.
    onError: (error) => {
      logAnswerError(error);
      return errorText;
    },
  });

  return createUIMessageStreamResponse({ stream, headers });
}
