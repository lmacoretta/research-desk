# 2. Herramientas de market data

## Qué se hizo
- `lib/market-data/schemas.ts` y `errors.ts`: ticker, fechas `YYYY-MM-DD`, rangos (no invertidos, hasta 366 días, sin futuro), inputs `.strict()`, resultados normalizados y seis códigos de error con mensajes fijos.
- `source/types.ts` (interfaz `MarketDataSource`), `source/finnhub.ts` (cliente en vivo), `source/fixtures.ts` con nueve fixtures en `evals/fixtures/finnhub/` (AAPL, MSFT, NVDA) y `source/index.ts`, que elige la fuente según `MARKET_DATA_SOURCE`.
- `tools.ts`: `createMarketDataTools(source, { now? })` con `getQuote`, `getHistoricalPrices` y `getKeyMetrics`.
- Tests de todo, más `decoupling.test.ts` (el módulo no importa de `lib/agents` ni de `app/`) e `invalid-input.test.ts` (qué pasa con un input inválido).

## Conceptos clave
- **Branded types (`.brand()` de zod):** `Ticker` e `IsoDate` son strings que solo zod puede producir. Pasarle a una fuente un string sin validar no compila.
- **Errores como valores:** `execute` devuelve `{ ok: false, error }` en lugar de lanzar. El modelo ve el error y puede seguir.
- **Inversión de dependencias:** las herramientas dependen de la interfaz, no de Finnhub. En vivo y con fixtures corre el mismo parseo.
- **SSRF y path traversal:** que un input haga pedir a otro host o leer otro archivo. Se evitan con host y rutas constantes, y comprobando que la ruta del fixture queda dentro de su carpeta.
- **Procedencia:** de dónde salió el dato y cuándo. Se toma de la respuesta real de la fuente, así dice `fixture` o `finnhub` según corresponda.
- **`MockLanguageModelV4` (`ai/test`):** un modelo simulado que devuelve respuestas guionadas. Permite correr el loop real del SDK sin red ni créditos.

## Decisiones
- **Los fixtures guardan la respuesta cruda de Finnhub**, no el resultado normalizado: más trabajo, pero las evals cubren el parseo real.
- **La clave de Finnhub va en el header `X-Finnhub-Token`**, nunca en la URL, que termina en logs y trazas. `redirect: "error"` evita que el header viaje a otro host.
- **La regla "no futuro" recibe `now` desde afuera:** si leyera el reloj, los tests dependerían del día y las evals no podrían usar una fecha fija.
- **`execute` no revalida el input**, porque el SDK ya lo hizo (ver abajo). El mapeo a `INVALID_TICKER`/`INVALID_INPUT` para el cliente queda en el endpoint (sección 4).
- **El test de desacople tiene su propio autotest:** comprueba que detecta imports prohibidos de ejemplo. Un escáner que nunca encuentra nada podría estar roto.

## Problemas
- **El input inválido lo rechaza el SDK antes de `execute`.** El design y la spec decían que una herramienta con ticker `aapl` "devuelve `INVALID_TICKER`". Leyendo el código del SDK y con la tarea 2.7 confirmé otra cosa: si el input no cumple el `inputSchema`, el SDK no llama a `execute`. Marca la llamada como `invalid: true` y `dynamic: true` y le devuelve al modelo un `tool-error` con el mensaje de zod (su propio input y el motivo, sin secretos), que le sirve para corregirse. Hacia el cliente salen dos chunks, `tool-input-error` y `tool-output-error`, con el texto crudo del SDK, y en la UI la parte llega como `dynamic-tool`, no como `tool-getQuote`. Actualicé la Decisión 4, los escenarios de la spec y las tareas 4.1 y 5.1: el endpoint reemplaza ese `errorText` por `{ code, message }` y la UI acepta partes `dynamic-tool`.
- **Ticker desconocido en Finnhub:** responde `{ c: 0, d: null, dp: null, ... }`. Con `d` y `dp` como números obligatorios en el esquema crudo, caía como `UPSTREAM_UNAVAILABLE` en lugar de `NOT_FOUND`. Los acepté `nullable` y chequeo `c === 0 && t === 0` primero.
- **El test de timeout terminaba antes del timeout:** el temporizador de `AbortSignal.timeout` no mantiene vivo al proceso de Node. El `fetch` falso agrega un temporizador propio.

## Para recordar
- Antes de diseñar el manejo de errores alrededor de un SDK, verificar en su código qué hace con un input inválido: puede no llegar nunca a mi función.
- Los fixtures valen lo que valga su fidelidad con la fuente real, en forma y en comportamiento.
