# Design

## Context

- El repo es el scaffold de `create-next-app` con Next.js 16.4 (App Router, `cacheComponents: true`), React 19.3, TypeScript `strict` y alias `@/*` a la raíz. No hay `lib/`, route handlers ni dependencias de AI, zod u observabilidad instaladas.
- `.env.local` ya define `NEON_AI_GATEWAY_BASE_URL`, `NEON_AI_GATEWAY_TOKEN`, `FINNHUB_API_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` y `MODEL_MARKET_DATA`.
- Node local: v22.23. Es el mínimo que exigen AI SDK 7 y `@langfuse/vercel-ai-sdk` (`>=22`). Node 22 terminó su mantenimiento en abril de 2026, así que para producción conviene Node 24 LTS.
- La versión vigente del AI SDK es la **7** (`ai@7.0.183`, la instalada). Respecto de la 6 cambia nombres que este diseño usa: `system` → `instructions`, `stepCountIs` → `isStepCount`, `experimental_telemetry` → `telemetry`, la telemetría OTel salió del paquete `ai`, y los helpers `result.toUIMessageStream*()` quedaron deprecados en favor de helpers sin estado (`toUIMessageStream({ stream })`). Al implementar, cada API se verifica contra `node_modules/ai/docs/` (skill `ai-sdk`), no de memoria.
- El Neon AI Gateway informa precios por token en `/v1/models`, en el campo `pricing` (`prompt`, `completion` e `input_cache_read`, en USD por token). Verificado el 2026-11-26 para `gpt-5-4-nano`: 0.0000002 / 0.00000125 / 0.00000002. Langfuse no lee esos precios del gateway: hay que cargarlos como definición de modelo (Decisión 9). models.dev queda como respaldo si algún modelo viene con `pricing: null`.
- Motivación: ver proposal.md (Why). Requisitos: ver `specs/`.

## Goals / Non-Goals

**Goals:**
- Que las herramientas y la fuente de datos sean un módulo que otros agentes importen tal cual.
- Que un solo núcleo del agente sirva al route handler (streaming) y al script de evals (sin HTTP).
- Que la procedencia de cada dato la ponga el servidor, no el modelo.

**Non-Goals:**
- Conversación multi-turno: cada consulta es una sola pregunta sin historial.
- Caché de respuestas de Finnhub.
- Reintentos automáticos ante errores de Finnhub (el modelo decide con el error tipado).
- Un framework de agentes externo (Mastra u otro): alcanza con `ToolLoopAgent`, que es la abstracción de agente del propio AI SDK.

## Decisions

### 1. Estructura de módulos

```
lib/
  env.ts                         # lectura y validación zod de env (server-only)
  llm/models.ts                  # resuelve el modelo de cada agente desde su variable de entorno
  market-data/
    schemas.ts                   # ticker, fechas, formas de resultado, códigos de error
    errors.ts                    # tipo ToolError y mapeo HTTP → código
    source/types.ts              # interfaz MarketDataSource
    source/finnhub.ts            # implementación en vivo
    source/fixtures.ts           # implementación desde evals/fixtures
    source/index.ts              # elige la fuente según MARKET_DATA_SOURCE
    tools.ts                     # createMarketDataTools(source) → { getQuote, getHistoricalPrices, getKeyMetrics }
  agents/market-data/
    config.ts                    # MAX_STEPS, MAX_OUTPUT_TOKENS, MAX_QUESTION_CHARS
    prompt.ts                    # instructions del agente (incluye la fecha de referencia)
    output-schema.ts             # esquema zod de la respuesta final
    agent.ts                     # createMarketDataAgent({ source, referenceDate }) → ToolLoopAgent
    run.ts                       # runMarketDataAgent({ question, correlationId, source? }): agente + traza raíz + verificación
    ui-message.ts                # MarketDataUIMessage (InferAgentUIMessage + parte data-answer)
    verify-sources.ts            # cruza dataPoints con las llamadas reales
  observability/tracing.ts       # LangfuseSpanProcessor (máscara) + registerTelemetry; lo usan instrumentation.ts y scripts/eval.ts
app/
  api/agents/market-data/route.ts
  page.tsx                       # UI de chat (reemplaza la página por defecto)
  _components/…                  # ChatPanel, ToolCallCard, FinalAnswer (client)
instrumentation.ts
evals/
  fixtures/finnhub/{quote,candle,metric}/<TICKER>.json
  cases.ts                       # 10 preguntas + checks
scripts/eval.ts
```

Todo lo que está bajo `lib/` empieza con `import "server-only"`. **Alternativa descartada:** poner las herramientas dentro de la carpeta del agente; eso las acopla y contradice `market-data-tools`.

### 2. Fuente de datos detrás de una interfaz

`MarketDataSource` expone `quote(ticker)`, `candles(ticker, from, to)` y `metrics(ticker)` y devuelve **la respuesta cruda con forma de Finnhub**. Las herramientas validan esa forma con zod, la normalizan y agregan la procedencia. Los fixtures guardan JSON con la misma forma que Finnhub, así que el modo eval pasa por el mismo parseo y la misma validación que el modo en vivo. La fuente se elige con `MARKET_DATA_SOURCE=live|fixtures` (por defecto `live`), y `runMarketDataAgent` acepta una fuente inyectada para las evals.

**Alternativa descartada:** que los fixtures guarden el resultado ya normalizado. Es más simple, pero las evals dejarían de cubrir el parseo de Finnhub.

### 3. Cliente de Finnhub

- Base fija `https://finnhub.io/api/v1`; las rutas son constantes (`/quote`, `/stock/candle`, `/stock/metric`). Los parámetros van con `URLSearchParams` solo después de validarlos, así que ningún input del usuario toca el host ni la ruta.
- La clave va en el header `X-Finnhub-Token`, **nunca en la query string**, para que no aparezca en URLs registradas por spans o logs.
- Timeout de 8 s con `AbortSignal.timeout`. Mapeo de errores: 429 → `RATE_LIMITED`, 401/403 → `ACCESS_DENIED`, 5xx/red/timeout/cuerpo inválido → `UPSTREAM_UNAVAILABLE`.
- `NOT_FOUND`: en quote, `c === 0 && t === 0`; en candle, `s === "no_data"`; en metric, `metric` vacío.
- Velas: resolución `D`; `from`/`to` se convierten a timestamps unix en UTC.
- Métricas: `peTTM`, `grossMarginTTM`, `operatingMarginTTM`, `netProfitMarginTTM`, `revenueGrowthTTMYoy` y `epsGrowthTTMYoy` (con su período). Si falta un campo, va `null`.

### 4. Herramientas como `tool()` del AI SDK con errores como valor

`createMarketDataTools(source)` devuelve las tres herramientas, con `inputSchema` zod `.strict()` y ticker `^[A-Z]{1,5}(\.[A-Z]{1,2})?$`. `execute` nunca lanza: devuelve `{ ok: true, data, provenance }` o `{ ok: false, error: { code, message } }`. Así el modelo ve el error y puede seguir, y la UI distingue el error de herramienta (resultado `ok: false`, tarjeta `error`) del error del sistema.

**Input inválido: sin revalidación en `execute`.** Si el modelo manda un input que falla `inputSchema`, el AI SDK no llama a `execute`: marca la llamada como inválida (`invalid: true`, `dynamic: true`) y le devuelve al modelo un `tool-error` con el mensaje de validación. Ese mensaje solo contiene el input que mandó el propio modelo y los issues de zod, sin datos sensibles, y lo ayuda a corregirse en el paso siguiente. Por eso `execute` no revalida.

Hacia el cliente, el SDK emite ese caso como chunks `tool-input-error` y `tool-output-error` con `errorText`. El endpoint (Decisión 7) reemplaza ese `errorText` antes de enviarlo. Para eso valida el `input` del chunk con el `inputSchema` de la herramienta y lo mapea con `toolErrorFromInputIssues`: `INVALID_TICKER` si el problema está en el ticker, `INVALID_INPUT` si no. El `errorText` pasa a ser `JSON.stringify({ code, message })`, con el mensaje fijo de `toolError`. El `tool-output-error` con el mismo `toolCallId` recibe el mismo texto, y cualquier otro `tool-output-error` recibe `UPSTREAM_UNAVAILABLE`. La UI (Decisión 8) muestra la tarjeta en estado `error` con ese código y mensaje.

**Alternativa descartada:** lanzar excepciones y dejar que el SDK las serialice; el mensaje crudo podría filtrar detalles internos al modelo y al cliente.

### 5. Loop del agente: `ToolLoopAgent` con `stopWhen` y salida estructurada

El skill `ai-sdk` recomienda usar la abstracción de agente del SDK (`ToolLoopAgent`) en lugar de armar el loop a mano con `streamText`. `ToolLoopAgent` acepta las mismas opciones que `streamText`/`generateText` y expone `agent.stream()` (route handler) y `agent.generate()` (evals), así que sigue habiendo un solo núcleo.

- `agent.ts` exporta una fábrica, porque la fuente y la fecha de referencia cambian por invocación: `createMarketDataAgent({ source, referenceDate })` → `new ToolLoopAgent({ model, instructions, tools: createMarketDataTools(source), stopWhen: isStepCount(MAX_STEPS), maxOutputTokens, output: Output.object({ schema }), prepareStep, telemetry: { functionId: "market-data-agent" } })`. La pregunta entra como `prompt` en `stream()`/`generate()`.
- En AI SDK 7 el system prompt se pasa como `instructions` (ya no `system`), y el helper de límite es `isStepCount` (ya no `stepCountIs`).
- Límites en `agents/market-data/config.ts`: `MAX_STEPS = 8`, `MAX_OUTPUT_TOKENS = 1024`, `MAX_QUESTION_CHARS = 500`. El default de `ToolLoopAgent` es 20 pasos, así que `stopWhen` se fija explícitamente.
- **La salida estructurada cuenta como un paso.** Según la documentación del SDK, generar el objeto final consume un paso del loop; por eso `MAX_STEPS = 8` deja hasta 7 pasos con herramientas más el de la respuesta.
- **Respuesta parcial al llegar al límite:** con `prepareStep`, en el último paso permitido (`stepNumber === MAX_STEPS - 1`) se fija `activeTools: []` para forzar la respuesta final. Si eso ocurrió, el servidor marca `isPartial: true`.
- **Tipos de UI:** `ui-message.ts` define `MarketDataUIMessage` a partir de `InferAgentUIMessage<typeof agent>` más la parte `data-answer`, y el cliente lo usa en `useChat<MarketDataUIMessage>()` para tener tipadas las partes `tool-*`.
- **Fecha de referencia:** las `instructions` incluyen la fecha actual (o una fija en modo eval) para que el modelo resuelva "ayer" y "el último mes" sin adivinar.
- **Alternativa considerada:** una herramienta final `submitAnswer` con el esquema como input y `toolChoice: "required"`. Queda como plan B si `Output.object` combinado con tools no se comporta bien con los modelos del gateway; las specs no cambian.

### 6. Procedencia verificada por el servidor

El esquema que ve el modelo pide, en cada `dataPoint`, `label`, `value`, `unit`, `ticker` y `toolCallId`. Al terminar, `verify-sources.ts` recorre los resultados de herramientas de **todos** los pasos (en AI SDK 7, `result.toolResults` ya acumula todos los pasos; `finalStep` es solo el último) y, para cada `dataPoint`:

- si `toolCallId` corresponde a un resultado `ok: true` de esa consulta, completa `source` (`provider`, `endpoint`, `fetchedAt`) **desde el resultado real**;
- si no, lo saca de `dataPoints` y lo agrega a `unavailable` con el motivo "no verificado".

El modelo nunca escribe la procedencia, así que no la puede inventar.

### 7. Endpoint y protocolo de streaming

- `POST /api/agents/market-data`. El cuerpo `{ question }` se valida con zod `.strict()`, con un tope de 500 caracteres (`trim`, no vacío). Si falla, responde 400 genérico.
- Se genera un `correlationId` (`crypto.randomUUID()`) que va en el header `x-correlation-id`, en los metadatos del trace y en los logs.
- La respuesta es un UI message stream del AI SDK: `createUIMessageStream<MarketDataUIMessage>({ execute, onError })` + `createUIMessageStreamResponse`. Dentro de `execute`, el stream del agente se convierte con el helper sin estado `toUIMessageStream({ stream: result.stream })` y se mezcla con `writer.merge(…)`; los métodos `result.toUIMessageStream()`/`toUIMessageStreamResponse()` están deprecados en AI SDK 7 y no se usan. Las partes `tool-*` se transmiten tal cual (estados `input-available`, `output-available`, `output-error`), y la respuesta final se emite con `writer.write({ type: "data-answer", … })` **después** de validarla y verificarla. Las partes de texto del objeto estructurado en curso se filtran antes del merge y no se reenvían.
- Antes del merge, los chunks `tool-input-error` y `tool-output-error` pasan por el reemplazo de `errorText` de la Decisión 4: el cliente nunca recibe el texto original del SDK, solo `{ code, message }` con un código del conjunto cerrado.
- No se usa `createAgentUIStreamResponse`: entrega el stream del agente directo y no deja intercalar la verificación de fuentes antes de la parte final.
- `onError` devuelve siempre `"No pudimos completar la consulta. Referencia: <correlationId>"`, y el error real va a `console.error` con el `correlationId`.
- Si falta `MODEL_MARKET_DATA` o alguna variable de Neon o Finnhub, `lib/env.ts` lanza al resolverla. El handler lo captura, responde 500 genérico y lo registra.
- `lib/llm/models.ts` crea el provider con `createNeon({ baseURL, apiKey })` a partir de `getNeonGatewayEnv()` y `getMarketDataModelId()` de `lib/env.ts`, en lugar de la instancia `neon` por defecto, que lee `process.env` por su cuenta. Así hay una sola fuente de configuración, y una variable faltante sale como `EnvError` (con el nombre, sin el valor) antes de cualquier request. `lib/env.ts` valida por sección y al usarla, no al importarla, así que las evals en modo fixtures no exigen `FINNHUB_API_KEY`.
- `@neon/ai-sdk-provider` rechaza con `APICallError` y pone en `error.message` el motivo textual del gateway. Ese texto nunca llega al cliente: queda solo en el log del servidor.

### 8. UI

`app/page.tsx` renderiza un componente cliente que usa `useChat<MarketDataUIMessage>()` de `@ai-sdk/react` con `DefaultChatTransport` hacia el endpoint (el tipo se importa con `import type`, así que no arrastra código de servidor al cliente). Como `useChat` es de las APIs que más cambian entre versiones, sus opciones se verifican contra la documentación incluida en `node_modules/@ai-sdk/react`. Con `prepareSendMessagesRequest` se envía solo `{ question }`, no el historial.

- Las partes `tool-getQuote`, `tool-getHistoricalPrices` y `tool-getKeyMetrics` se muestran en `ToolCallCard`: `input-streaming`/`input-available` → pendiente; `output-available` con `ok: true` → ok; `output-available` con `ok: false` u `output-error` → error.
- Las partes `dynamic-tool` en `output-error` (el SDK marca así las llamadas con input inválido, Decisión 4) también van a `ToolCallCard`. La tarjeta lee el `errorText` con zod (`toolErrorSchema`) y muestra su código y mensaje; si no lo puede leer, muestra un mensaje genérico.
- Parámetros y resultados se muestran con `JSON.stringify(…, null, 2)` dentro de un `<pre>`.
- La parte `data-answer` se muestra en `FinalAnswer`.
- Render seguro: solo nodos de texto de React. No se usa `dangerouslySetInnerHTML`, ni un renderer de markdown, ni links o imágenes generados desde el contenido.
- Estilos con Tailwind, que ya está en el proyecto.

### 9. Tracing con Langfuse (integración para AI SDK 7)

Para AI SDK 7, Langfuse recomienda su integración `@langfuse/vercel-ai-sdk` registrada con `registerTelemetry`, más `LangfuseSpanProcessor` para exportar. El esquema anterior (`experimental_telemetry: { isEnabled: true }` + spans OTel emitidos por `ai`) es el "legacy setup" de AI SDK 6 y no aplica.

- `lib/observability/tracing.ts` exporta `setupTracing()`: crea un `LangfuseSpanProcessor` (con `mask`), lo registra en un `NodeTracerProvider` y llama a `registerTelemetry(new LangfuseVercelAiSdkIntegration())`. Devuelve el procesador para poder hacer `forceFlush()`. Se usa `NodeTracerProvider` (la variante que la guía de Langfuse muestra para Next.js, sin restricción de versión) en lugar de `NodeSDK`, cuya guía pide `@opentelemetry/sdk-node` `<0.300.0`.
- `instrumentation.ts` → `register()`: si `NEXT_RUNTIME === "nodejs"` y están las tres variables de Langfuse, llama a `setupTracing()`. Si faltan, emite un `console.warn` y no registra nada; sin integración registrada, AI SDK 7 no emite telemetría.
- **Telemetría del agente:** con la integración registrada, AI SDK 7 emite telemetría por defecto (opt-out). El agente solo fija `telemetry: { functionId: "market-data-agent" }`; no hace falta `isEnabled: true`. Cada llamada al modelo aparece como `generation` (modelo y tokens) y cada herramienta como `tool` (argumentos, resultado y duración), anidadas bajo la ejecución del agente.
- **Traza raíz:** `run.ts` abre una observación raíz con `startActiveObservation("answer-market-data-question", …)` de `@langfuse/tracing` y ejecuta el agente dentro de `propagateAttributes({ traceName: "answer-market-data-question", metadata: { correlationId, dataSource }, tags: ["market-data-agent"] })`. La observación raíz tiene como **input solo la pregunta** y como **output la respuesta verificada** (no los argumentos crudos de la función), y se cierra cuando termina la verificación, no cuando vuelve `stream()`. Nombres estables, en verbo y sin el ID del modelo, según la guía de buenas prácticas de Langfuse.
- **Sin `sessionId`:** cada consulta es de un solo turno y sin historial (Non-Goals), así que no se agrupa en sesiones; el `correlationId` va en metadata.
- **Entorno:** `LANGFUSE_TRACING_ENVIRONMENT` (`development`/`production`; las evals usan `eval`) para que las trazas de prueba no se mezclen con las reales.
- **Filtro:** se usa el filtro por defecto de `LangfuseSpanProcessor` (exporta spans de Langfuse y de GenAI/LLM). Los spans HTTP automáticos de Next.js quedan afuera, así que no salen URLs ni headers. Pasar `shouldExportSpan` reemplazaría ese filtro, así que no se define uno propio.
- **Máscara:** el `mask` del `LangfuseSpanProcessor` se aplica al input, el output y la metadata de cada observación. Reemplaza por `[REDACTED]` los valores de las claves configuradas y los patrones `Bearer …` y `nt_live_…`. Es una segunda barrera por si algo se filtra en un argumento.
- **Flush:** en el route handler, `after(() => spanProcessor.forceFlush())` de `next/server`, para no demorar la respuesta. El procesador exporta en lote y sus errores no se propagan.
- **Costo:** el gateway informa precios en `/v1/models`, pero Langfuse no los toma de ahí. Langfuse calcula el costo cruzando el nombre del modelo de la generation con sus definiciones de modelo. Para los IDs que no conozca, se carga una vez una definición con los precios de `/v1/models` de la branch (models.dev como respaldo). Se carga desde **Project Settings > Models** o con `langfuse-cli` (API de modelos); es configuración, no código. **Alternativa descartada:** calcular el costo en código con una tabla de precios propia; duplica datos que cambian y Langfuse ya lo resuelve.

### 10. Evals

- `evals/fixtures/finnhub/…`: JSON estáticos con forma de Finnhub para AAPL, MSFT y NVDA (quote, candle de un mes fijo, metric). Ningún fixture para `ZZZZ`.
- `evals/cases.ts`: 10 casos `{ id, question, expect: { toolsCalled, numbers: [{ label, value, tolerance }], unavailable?, isPartial? } }`. Incluyen al menos: cierre en una fecha, variación porcentual en un rango, P/E, márgenes, combinación de quote + metric, comparación entre dos tickers, ticker inexistente y rango invertido.
- `scripts/eval.ts` llama a `runMarketDataAgent` con la fuente de fixtures y una fecha de referencia fija (internamente, `agent.generate()`), consume el resultado completo y aplica checks deterministas sobre la respuesta verificada y la lista de llamadas a herramientas. Imprime una tabla, el total `N/10` y los tokens, y termina con `process.exitCode = 1` si algo falla.
- Script npm: `"eval": "tsx --conditions=react-server --env-file=.env.local scripts/eval.ts"`. `--conditions=react-server` hace que `import "server-only"` no lance fuera de Next, y `--env-file` evita sumar `dotenv`.
- Tracing en evals: `instrumentation.ts` no corre fuera de Next, así que el script llama a `setupTracing()` si están las variables de Langfuse, con `LANGFUSE_TRACING_ENVIRONMENT=eval`, y hace `await spanProcessor.forceFlush()` antes de salir. Sin el flush, un script corto termina antes de exportar y las trazas se pierden.
- Las evals usan el modelo real vía gateway: consumen créditos y tienen algo de variabilidad. Los checks se apoyan en valores numéricos y en herramientas llamadas, no en el texto del resumen.

### 11. Tests unitarios sin runner nuevo

Los tests unitarios (validación, mapeo de errores, parseo de Finnhub, verificación de fuentes, checks de evals) usan `node:test` + `node:assert` ejecutados con `tsx`. Script: `"test": "tsx --conditions=react-server --test \"lib/**/*.test.ts\" \"app/**/*.test.tsx\" \"evals/**/*.test.ts\""`. Para Finnhub, los tests inyectan un `fetch` falso en el cliente, sin red. De la UI, el render seguro se testea con `renderToStaticMarkup` (de `react-dom/server`, ya instalado); el flujo de streaming se verifica en el navegador. **Alternativa descartada:** `vitest`, que sería una dependencia más sin ganancia real a este tamaño.

### 12. Dependencias — APROBADA E INSTALADA

Aprobada por el usuario e instalada en la tarea 1.2 con `--save-exact`.

| Paquete | Versión instalada | Tipo | Para qué | Alternativa sin el paquete |
|---|---|---|---|---|
| `ai` | 7.0.183 | runtime | `ToolLoopAgent`, `tool`, `Output`, `isStepCount`, `registerTelemetry`, UI message stream | — (es el stack definido) |
| `@neon/ai-sdk-provider` | 1.6.0 | runtime | provider del gateway; se instancia con `createNeon` y la config validada de `lib/env.ts`, y enruta por dialecto. Soporta `ai@^6 \|\| ^7` | `@ai-sdk/openai` con `createOpenAI` con `apiKey` = `NEON_AI_GATEWAY_TOKEN` y `baseURL` = `NEON_AI_GATEWAY_BASE_URL` + `/openai/v1` |
| `@ai-sdk/react` | 4.0.188 | runtime | `useChat` y el parseo del stream en el cliente (depende de `ai@7.0.183` exacta) | parsear el stream SSE a mano (más código y más frágil) |
| `zod` | 4.6.7 | runtime | esquemas de inputs, herramientas, Finnhub y salida | — (pedido explícito) |
| `server-only` | 0.0.1 | runtime | hace fallar el build si se importa código de servidor desde el cliente | ninguna equivalente |
| `@langfuse/otel` | 6.1.1 | runtime | `LangfuseSpanProcessor` (filtro por defecto, `mask`, `forceFlush`) | SDK con instrumentación manual de cada paso |
| `@langfuse/vercel-ai-sdk` | 6.1.1 | runtime | `LangfuseVercelAiSdkIntegration` para `registerTelemetry` de AI SDK 7 (requiere `ai >=7 <8` y Node ≥ 22) | `@ai-sdk/otel` genérico, con menos mapeo al modelo de datos de Langfuse |
| `@langfuse/tracing` | 6.1.1 | runtime | `startActiveObservation` y `propagateAttributes` para la traza raíz (nombre, input/output, metadata) | trazas sin input/output legibles en la raíz |
| `@opentelemetry/sdk-trace-node` | 2.12.0 | runtime | `NodeTracerProvider` que recibe los spans | `@vercel/otel` v2+ con `registerOTel` |
| `@opentelemetry/api` | 1.9.1 | runtime | peer de los paquetes de Langfuse (`^1.9.0`) y del SDK de OTel 2.x (`<1.10.0`); 1.10.0 rompe la resolución. Se instala explícita | — |
| `tsx` | 4.23.15 | dev | correr `scripts/eval.ts` y los tests `node:test` con alias `@/` y `--conditions` | type stripping nativo de Node 22, que exige extensiones `.ts` en imports y no resuelve `@/` |

Notas de la instalación (2026-11-26):
- Se tomaron las `latest` de ese día. `ai` y `@ai-sdk/react` subieron de patch respecto del diseño (7.0.181 → 7.0.183 y 4.0.186 → 4.0.188), porque `@ai-sdk/react` fija `ai` en versión exacta y con la versión vieja habría quedado una segunda copia de `ai`.
- `@opentelemetry/api` bajó a 1.9.1: con 1.10.0, `npm install` falla por el peer `<1.10.0` de `@opentelemetry/core` y `@opentelemetry/sdk-trace-node` 2.x.
- npm instaló solos los peers de `@langfuse/otel`: `@opentelemetry/core` y `@opentelemetry/sdk-trace-base` 2.12.1, y `@opentelemetry/exporter-trace-otlp-http` 0.223.2. `@ai-sdk/otel` llega como dependencia de `@langfuse/vercel-ai-sdk`.
- `npm audit`: 0 vulnerabilidades. `npm ls`: sin errores de peers, una sola copia de `ai`, `zod` y `@opentelemetry/api`.

## Risks / Trade-offs

- **Velas de Finnhub en plan gratuito** → `/stock/candle` suele devolver 403 en el plan gratuito. Mitigación: `ACCESS_DENIED` tipado, que el agente reporta como dato no disponible; las evals usan fixtures y no dependen de esto. Ver Open Questions.
- **Rate limit de Finnhub (60 req/min en el plan gratuito)** → con 8 pasos por consulta, unas pocas consultas simultáneas pueden agotarlo. Mitigación: `RATE_LIMITED` tipado y sin reintentos automáticos.
- **`Output.object` + tools varía entre modelos** → algunos modelos pueden terminar sin objeto válido. Según `@neon/ai-sdk-provider`, salida estructurada y tools en varios pasos están verificadas con modelos de OpenAI (incluido Codex), Meta, Alibaba y Zhipu; **Gemini no las soporta** por el gateway, y Claude no figura en esa lista. Mitigación: elegir `MODEL_MARKET_DATA` de una familia verificada y que figure con `enabled: true` en `/v1/models`; validación y error genérico (ya en la spec), y plan B con una herramienta `submitAnswer` (Decisión 5).
- **Opciones de llamada que el gateway descarta** → según el modelo, el provider descarta `temperature`, `topP` o las penalties y lo informa en `result.warnings`. Mitigación: el agente no depende de esas opciones (solo `maxOutputTokens`); las advertencias se registran en el log del servidor.
- **AI SDK 7 es solo ESM y exige Node ≥ 22** → Next.js y `tsx` cargan ESM sin cambios; el `package.json` declara `"engines": { "node": ">=22" }`.
- **Endpoint público sin auth ni rate limit propio** → cualquiera que llegue a la URL consume créditos del gateway y cuota de Finnhub. Mitigación en este cambio: límites de pasos, tokens y largo de la pregunta. Auth y rate limiting quedan fuera de alcance; no conviene desplegarlo público así.
- **Costo en Langfuse depende de las definiciones de modelo** → si el ID de `MODEL_MARKET_DATA` no matchea ninguna definición, el trace muestra tokens pero costo vacío. Mitigación: cargar la definición en Langfuse al elegir el modelo (tarea explícita).
- **SDK de OTel duplicado y deprecado** → `@opentelemetry/sdk-trace-node@2.12.0` trae `core`/`sdk-trace-base` 2.12.0, y los peers de `@langfuse/otel` resolvieron 2.12.1. Además, npm marca `sdk-trace-node` como deprecado en favor de `@opentelemetry/sdk-trace`. Mitigación: las interfaces son compatibles; si en la tarea 6.1 hay errores de tipos al pasar el `LangfuseSpanProcessor` al `NodeTracerProvider`, evaluar `@opentelemetry/sdk-trace` (con aprobación, porque es otra dependencia).
- **Evals con modelo real** → cuestan créditos y pueden variar. Mitigación: checks numéricos con tolerancia y fecha de referencia fija.
- **`cacheComponents` activo** → el route handler es `POST`, así que no se prerenderiza. La página de chat es un componente cliente sin datos de servidor, así que no aplican restricciones de prerender.

## Migration Plan

No hay datos ni APIs previas. El despliegue consiste en aprobar dependencias, instalar y hacer merge. Rollback: revertir el commit. Las variables de entorno nuevas (`MARKET_DATA_SOURCE`) tienen valor por defecto.

## Open Questions

- ¿El plan de Finnhub tiene acceso a `/stock/candle`? Si no, `getHistoricalPrices` va a responder `ACCESS_DENIED` en vivo hasta cambiar de plan o de proveedor para históricos. No cambia specs ni tareas.
- ¿Qué modelo va en `MODEL_MARKET_DATA` en producción? Tiene que ser de una familia con salida estructurada y tools en varios pasos verificadas por el provider (ver Risks) y estar habilitado en `/v1/models` de la branch. Define también la definición de precios a cargar en Langfuse.
