# 4. Endpoint de servidor

## Qué se hizo
- `app/api/agents/market-data/route.ts`: el `POST` que valida la pregunta, crea el `correlationId`, corre el agente y devuelve un UI message stream.
- En `lib/agents/market-data/`:
  - `request.ts`: el esquema zod del cuerpo (`{ question }`, estricto, 1 a 500 caracteres después de `trim`).
  - `ui-stream.ts`: convierte el stream del agente en chunks de UI, saca las partes de texto, reemplaza los `errorText` de las herramientas y agrega `data-answer` al final.
  - `log.ts`: un solo formato de log de errores, siempre con el `correlationId`.
- Cambios chicos en código anterior: `tools.ts` exporta `createMarketDataInputSchemas`, `agent.ts` acepta `onError`, `run.ts` lo usa para registrar los errores del modelo, y `fixtures.ts` tiene un `turbopackIgnore`.
- Tests en `ui-stream.test.ts`: la función de reemplazo con chunks armados a mano, y el stream completo con un modelo simulado.
- Verifiqué con `curl` contra `next dev` los 400, una pregunta real, la variable faltante y el token inválido. Después corrí `npm run build` y busqué las claves en `.next/static`.

## Conceptos clave
- **UI message stream:** el protocolo SSE que entiende `useChat`. Cada línea `data:` es un chunk (`start`, `tool-input-available`, `tool-output-available`, `data-answer`, `finish`…). El cliente arma el mensaje a partir de esos chunks.
- **`toUIMessageStream({ stream })`:** el helper sin estado de AI SDK 7 que pasa del stream del modelo a chunks de UI. Reemplaza a `result.toUIMessageStream()`, que quedó deprecado.
- **`createUIMessageStream` + `writer.merge`:** permite componer un stream propio. Acá mezcla el stream del agente ya procesado.
- **`TransformStream` con `flush`:** `transform` ve cada chunk; `flush` corre una vez cuando el stream de entrada terminó. Ahí espero la respuesta verificada y la escribo después de todas las partes de herramientas.
- **Partes de datos (`data-*`):** chunks tipados propios. `data-answer` lleva la respuesta final y su tipo sale de `MarketDataUIMessage`.
- **`correlationId`:** un UUID por request que va en el header, en el mensaje de error al cliente y en el log. Con la referencia que ve el usuario encuentro el detalle en el servidor.

## Decisiones
- **La lógica del stream en `lib/`, no en el route:** así la pruebo con un modelo simulado y sin levantar un servidor. Además, el script de tests solo toma `app/**/*.test.tsx`.
- **Revalidar con los mismos esquemas de las herramientas** para elegir `INVALID_TICKER` o `INVALID_INPUT`, en lugar de leer el texto del SDK. El texto cambia entre versiones; el esquema es mío. Por eso `tools.ts` exporta los esquemas y el route les pasa la misma fecha de referencia que al agente.
- **`sendFinish: false` y `finish` propio:** si no, `finish` saldría antes de `data-answer`.
- **`sendReasoning: false`:** la UI no lo muestra, así que no tiene por qué viajar.
- **`redactToolErrors: false`:** con un `onError` propio, el SDK reemplazaría el `errorText` de las herramientas con mi texto genérico de error del sistema. Prefiero que pase el original y que lo reemplace mi función con el código tipado.
- **Registrar los errores del modelo en el agente (`run.ts`), no en el route:** las evals no leen el stream y solo ven un `NoOutputGeneratedError` sin detalle. Si registrara en los dos lugares, cada falla saldría dos veces.
- **Configuración faltante → 500 antes del stream; error del modelo → chunk `error` dentro del stream:** cuando el modelo falla ya se mandó el 200, así que el error solo puede viajar en el stream.

## Problemas
- **El error del gateway salía dos veces en el log.** Una con mi formato y el `correlationId`, y otra como un dump entero del `APICallError` (URL, cuerpo del request, headers de respuesta) sin referencia. Era el `onError` por defecto de `ToolLoopAgent`. Antes de silenciarlo probé qué recibe quien espera `completion`: un `NoOutputGeneratedError` sin `cause`. O sea que ese log era lo único útil para las evals. Lo moví al agente con el `correlationId` y saqué el registro del stream de UI. Un test con `t.mock.method(console, "error")` comprueba que hay una sola línea.
- **El build avisó que `fixtures.ts` hacía trazar todo el proyecto.** Es código de la sección 2, pero recién apareció cuando el route lo importó. Con `path.resolve(options.rootDir ?? …)` Turbopack no puede acotar el acceso e incluye todo en el output del servidor, `.env.local` incluido. Lo resolví con `/*turbopackIgnore: true*/`. Revisé el `.nft.json` del route: ya no hay `.env*` y los JSON de fixtures siguen.
- **El 200 que no correspondía.** Al reiniciar `next dev` con otra variable, un `curl` respondió 200 cuando esperaba 500. El servidor nuevo había fallado con `EADDRINUSE`: detener `npx` no había matado el proceso de Next que tenía el puerto. Lo vi en el log y en `netstat`.
- **Para probar "sin la variable":** Next no pisa con `.env.local` lo que ya está en el entorno, así que usé `MODEL_MARKET_DATA=` (vacía cuenta como faltante en `lib/env.ts`).
- **El SDK ya no manda `tool-output-error` para una llamada inválida,** solo `tool-input-error`. Lo vi en el código de `toUIMessageStream`. El reemplazo igual cubre los dos casos.
- **`for await` sobre `ReadableStream` no compila** con los tipos DOM del proyecto; en el test uso un `reader`.

## Para recordar
- Antes de silenciar un log "duplicado", hay que ver quién más depende de él: acá era la única fuente de detalle para las evals.
- Los warnings del build sobre el trace no son ruido: decían que el deploy iba a incluir `.env.local`.
