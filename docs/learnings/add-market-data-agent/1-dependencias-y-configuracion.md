# 1. Dependencias y configuración base

## Qué se hizo
- Presenté la tabla de dependencias del design, la aprobé e instalé con `--save-exact`: AI SDK 7 (`ai`, `@ai-sdk/react`), el provider de Neon, zod, `server-only`, los paquetes de Langfuse y OpenTelemetry, y `tsx` como devDependency.
- En `package.json` agregué los scripts `test` y `eval`, y `"engines": { "node": ">=22" }`.
- `lib/env.ts`: valida las variables de entorno con zod, con un getter por área (gateway, modelo, fuente de datos, Finnhub, Langfuse).
- `lib/llm/models.ts`: `getMarketDataModel()` crea el provider con `createNeon({ baseURL, apiKey })` y toma el ID del modelo de `MODEL_MARKET_DATA`.
- Tests de las dos cosas, y una consulta a `/v1/models` del gateway para confirmar que el modelo configurado está habilitado y soporta tools y salida estructurada.

## Conceptos clave
- **Peer dependency:** un paquete declara "el proyecto tiene que tener X en este rango", pero no lo trae. Si dos paquetes piden rangos incompatibles del mismo peer, npm falla.
- **`node_modules/ai/docs/`:** el AI SDK trae su documentación adentro. La uso como referencia, porque la v7 renombró APIs que conocía de la v6 (`system` → `instructions`, `stepCountIs` → `isStepCount`).
- **`node:test` + `tsx`:** el test runner de Node, sin vitest ni jest. `tsx` ejecuta TypeScript y resuelve `@/`.
- **`--conditions=react-server`:** `import "server-only"` lanza fuera de un contexto de servidor. Con esta condición, Node elige la variante que no lanza y los tests y scripts pueden importar código de servidor fuera de Next.
- **"Parse, don't validate":** valido una vez en el borde, y lo que sale ya está tipado y es válido.
- **Valores centinela en tests:** el test pone un secreto reconocible y comprueba que no aparece en `util.inspect(error)`. Así pruebo "el secreto no se filtra", no la redacción del mensaje.

## Decisiones
- **Versiones `latest` de `ai` y `@ai-sdk/react` en lugar de las del design.** `@ai-sdk/react` fija `ai` en versión exacta; con la vieja habría dos copias de `ai` y los tipos de UI podían no coincidir entre servidor y cliente.
- **`env.ts` valida al usar, no al importar, y por área.** Las evals con fixtures no exigen `FINNHUB_API_KEY`, y `next build` no falla por variables de runtime.
- **`EnvError` nombra la variable, nunca el valor**, y no guarda el `ZodError` como `cause` (el error de zod incluye el valor recibido). Una variable vacía cuenta como faltante. Langfuse no lanza: el tracing no debe bloquear la app.
- **`createNeon(...)` en lugar de la instancia `neon` por defecto**, que lee `process.env` por su cuenta. Así hay una sola fuente de configuración y un faltante sale como `EnvError` antes de cualquier request.

## Problemas
- **Conflicto de peers de OpenTelemetry.** Revisé los peers a mano y no vi conflictos, pero `npm install` falló. La rama 2.x del SDK de OpenTelemetry (`sdk-trace-node`, `core`) pide `@opentelemetry/api >=1.0.0 <1.10.0`, y el design decía 1.10.0. El design solo había mirado el peer de `@langfuse/vercel-ai-sdk` (`^1.9.0`). Opciones: bajar a 1.9.1, usar `--legacy-peer-deps` (esconde el conflicto y deja un árbol inválido) o pasar al SDK 3.x (imposible: `@langfuse/otel` exige `core ^2`). Elegí 1.9.1, que cumple los dos rangos, y lo dejé anotado en la Decisión 12.
- **SDK de OpenTelemetry duplicado:** `sdk-trace-node` trae `core` 2.12.0 y los peers de Langfuse resolvieron 2.12.1. Las interfaces son compatibles; quedó como riesgo para la sección 6.
- **El design estaba desactualizado:** decía que el gateway no informa precios, pero `/v1/models` sí los devuelve. Actualicé el design y la tarea 6.4.

## Para recordar
- Un conflicto de peers se resuelve buscando la intersección de rangos de **todos** los paquetes que comparten la dependencia, no con `--legacy-peer-deps`.
- Un error de configuración nombra la variable, nunca su valor.
