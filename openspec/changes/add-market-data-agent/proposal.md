# Proposal

## Why

Research Desk todavía no tiene ningún agente: el repo es el scaffold de Next.js. El primer paso es un agente de market data que responda preguntas sobre acciones con datos reales de Finnhub, citando de dónde sale cada dato. Ese agente fija las piezas que van a reutilizar los agentes siguientes: herramientas desacopladas, loop con límites, tracing con costo por consulta y un arnés de evals reproducible.

## What Changes

- Agregar tres herramientas de market data de solo lectura (`getQuote`, `getHistoricalPrices`, `getKeyMetrics`), independientes de cualquier agente, con validación estricta de parámetros y errores tipados (ticker inválido, rate limit, API caída, sin acceso).
- Agregar una fuente de datos intercambiable: Finnhub en vivo o fixtures JSON locales (modo eval), elegida por variable de entorno.
- Agregar el agente de market data: loop ReAct sobre esas herramientas, con límite de pasos y de tokens de salida, y una respuesta final estructurada (resumen, datos usados y la fuente de cada dato).
- Agregar un endpoint de servidor que valida la pregunta del usuario, aplica límites, ejecuta el agente con streaming y devuelve solo errores genéricos al cliente.
- Agregar una UI de chat con streaming: cada llamada a herramienta aparece como una tarjeta (pendiente / ok / error) con sus parámetros y su resultado, y la respuesta final se renderiza de forma segura.
- Agregar tracing con Langfuse: cada paso, el uso de tokens y el costo por consulta, sin registrar claves ni headers.
- Agregar un script `npm run eval` que corre 10 preguntas con respuesta conocida contra los fixtures y reporta cuántas pasan.
- Nuevas dependencias (AI SDK, provider de Neon, zod, Langfuse/OpenTelemetry, etc.): aprobadas por el usuario e instaladas con versiones exactas (ver Decisión 12 del design).

## Capabilities

### New Capabilities
- `market-data-tools`: herramientas reutilizables de solo lectura para cotización, precios históricos y métricas clave, con validación de parámetros, errores tipados, procedencia de cada dato y fuente intercambiable (en vivo / fixtures).
- `market-data-agent`: el agente que responde preguntas de mercado usando esas herramientas, sus límites de ejecución, la salida estructurada con fuentes y el endpoint de servidor que lo expone con validación y errores genéricos.
- `agent-chat-ui`: la interfaz de chat con streaming, las tarjetas de estado de cada herramienta y el render seguro de la respuesta.
- `agent-observability`: el tracing por consulta (pasos, tokens, costo) y la redacción de secretos en los traces.
- `agent-evals`: el arnés de evaluación offline sobre fixtures, sus preguntas con respuesta conocida y su reporte.

### Modified Capabilities

Ninguna (no hay specs existentes).

## Impact

- **Código nuevo:** módulos de servidor para herramientas, fuente de datos, agente y tracing; un route handler bajo `app/api/`; reemplazo de `app/page.tsx` (hoy es la página por defecto de create-next-app) por la UI de chat; `instrumentation.ts` en la raíz; fixtures y script de evals.
- **Configuración:** `package.json` gana el script `eval`. Las variables de entorno nuevas se leen de `.env.local` (las de Neon, Finnhub, Langfuse y `MODEL_MARKET_DATA` ya están definidas; se agrega una para elegir la fuente de datos).
- **Dependencias:** varias nuevas, todas sujetas a aprobación (ver design).
- **Sistemas externos:** Finnhub (solo lectura), Neon AI Gateway (consumo de créditos por consulta y por cada corrida de evals), Langfuse.
- **Fuera de alcance:** autenticación de usuarios, rate limiting del endpoint propio, persistencia en Neon Postgres e historial de conversaciones.
