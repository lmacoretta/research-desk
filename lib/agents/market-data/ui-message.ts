import "server-only";
import type { InferAgentUIMessage, UIMessage } from "ai";

import type { MarketDataAgent } from "@/lib/agents/market-data/agent";
import type { MarketDataAnswer } from "@/lib/agents/market-data/output-schema";

/*
 * Tipo de los mensajes de UI del agente (Decisión 5 del design).
 *
 * - Las partes `tool-getQuote`, `tool-getHistoricalPrices` y
 *   `tool-getKeyMetrics` salen de las herramientas del agente vía
 *   `InferAgentUIMessage`, así input y output quedan tipados en el cliente.
 * - `InferAgentUIMessage` fija las partes de datos en `never`, así que se toma
 *   solo su parámetro de herramientas y se agrega `data-answer`: la respuesta
 *   final ya verificada que escribe el endpoint.
 * - El cliente lo importa con `import type`, que se borra al compilar: no
 *   arrastra código de servidor (ni este `server-only`) al bundle.
 */

type MarketDataUITools =
  InferAgentUIMessage<MarketDataAgent> extends UIMessage<unknown, never, infer TOOLS>
    ? TOOLS
    : never;

export type MarketDataDataParts = {
  answer: MarketDataAnswer;
};

export type MarketDataUIMessage = UIMessage<
  unknown,
  MarketDataDataParts,
  MarketDataUITools
>;
