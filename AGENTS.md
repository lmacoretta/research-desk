<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Research Desk

App de análisis de acciones con múltiples agentes.

## Stack

- **Framework:** Next.js App Router
- **Lenguaje:** TypeScript estricto (`strict: true`; evitar `any` y aserciones innecesarias)
- **LLM:** Vercel AI SDK
- **Modelos:** Neon AI Gateway (endpoint compatible con OpenAI)
- **Base de datos:** Neon Postgres
- **Market data:** Finnhub
- **Tracing:** Langfuse

## Reglas

- **No instalar dependencias sin preguntar.** Antes de cualquier `npm install` / `npm i` (incluidas devDependencies), proponer el paquete y esperar aprobación.
- **Los modelos se configuran por variable de entorno.** Nunca hardcodear IDs de modelo en el código; leerlos de env.
- **Las claves solo van en `.env.local`.** Nunca en código, specs, logs ni commits. `.env*` ya está en `.gitignore`.

## Workflow

Los cambios se planifican con OpenSpec (`openspec/`). El contexto del proyecto para los artefactos está en [openspec/config.yaml](openspec/config.yaml).

## Convenciones

- Código, nombres de archivos e identificadores en inglés; artefactos de OpenSpec y comentarios de diseño en español.

## Verificación

Antes de dar una tarea por terminada:

- `npm run lint` sin errores
- `npx tsc --noEmit` sin errores
- Si la tarea toca un agente o herramienta: `npm run eval` (cuando exista)
