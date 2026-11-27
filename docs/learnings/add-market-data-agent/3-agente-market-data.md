# 3. Agente de market data

## Qué se hizo
- En `lib/agents/market-data/`:
  - `config.ts`: límites de pasos, tokens de salida y largo de la pregunta.
  - `prompt.ts`: las instrucciones, la fecha de referencia en UTC con día de la semana y el aviso del último paso.
  - `output-schema.ts`: el esquema que genera el modelo y el de la respuesta final del servidor.
  - `verify-sources.ts`: cruza cada dato con los resultados reales de las herramientas.
  - `agent.ts`: crea el `ToolLoopAgent`.
  - `ui-message.ts`: el tipo de mensaje para el cliente.
  - `run.ts`: devuelve `{ stream, completion }` y abre la traza raíz de Langfuse.
- Tests con modelo simulado (`run.test.ts`, `verify-sources.test.ts`, `output-schema.test.ts`) y un script manual, `scripts/try-market-data-agent.ts`, que imprime cada paso del loop con el modelo real y los fixtures.
- Probé el límite de pasos con `maxSteps: 2`. El plan B (herramienta `submitAnswer`) no hizo falta: `Output.object` con tools dio objetos válidos.

## Conceptos clave
- **Loop de agente (`ToolLoopAgent`):** el modelo pide herramientas, el SDK las ejecuta y le devuelve los resultados, y así hasta que responde o se corta. `stopWhen: isStepCount(n)` pone el tope.
- **`prepareStep`:** cambia la configuración antes de cada paso. En el último apago las herramientas (`activeTools: []`) y agrego un aviso para que el modelo responda con lo que tiene.
- **La salida estructurada cuenta como un paso:** con 8 pasos quedan 7 para herramientas y uno para la respuesta.
- **Procedencia verificada por el servidor:** el modelo cita el `toolCallId` de cada dato y el servidor completa la fuente desde el resultado real. El modelo no puede inventar la fuente.
- **`toModelOutput`:** cambia solo lo que lee el modelo de un resultado; el stream, `toolResults` y la verificación siguen usando el original.
- **Modo estricto de salida estructurada:** todos los objetos con `.strict()` y los campos que pueden faltar como `nullable`, no `optional`.

## Decisiones
- **`agent.ts` es una fábrica:** la fuente y la fecha cambian por consulta (en vivo o fixtures, hoy o una fecha fija).
- **La fecha de referencia también es el reloj de las herramientas:** si el prompt y `getHistoricalPrices` usaran fechas distintas, el modelo pediría rangos que la herramienta rechaza por "futuros".
- **Dos esquemas:** el del modelo no tiene `source` ni `isPartial`; esos campos los pone el servidor.
- **Un solo camino, `{ stream, completion }`,** en lugar de `stream()` para la API y `generate()` para las evals: las evals esperan `completion` sin leer el stream.
- **`isPartial` = "se usaron todos los pasos".** Acepté el falso positivo: si el modelo ya tenía todo y responde justo en el último paso, sale como parcial.
- **El límite se probó con el parámetro `maxSteps`,** sin editar la constante y restaurarla.
- **Además del `toolCallId`, verifico el ticker:** un precio de MSFT citado con una llamada de AAPL tendría una fuente válida pero equivocada.

## Problemas
- **Contradicciones del prompt.** Antes de escribirlo lo revisé contra el design, las specs y las herramientas, y aparecieron varios choques:
  - prohibía calcular, pero el design y las evals piden una variación porcentual en un rango, que Finnhub no da. Quedó una excepción: calcular la variación entre dos cierres del mismo resultado, con los dos cierres en `dataPoints`;
  - decía "no reintentes", pero la Decisión 4 existe para que el modelo corrija un input inválido. Quedó: corregir y reintentar una vez;
  - una pregunta mixta ("P/E y noticias") se rechazaba entera. Quedó: responder lo que cubre y listar el resto en `unavailable`;
  - para "ayer" no decía qué herramienta usar, y la spec espera `getQuote`;
  - faltaban los nombres de los campos de `unavailable`, el formato de `value` y `unit` (tal cual lo devuelve la herramienta, con unidades de un conjunto cerrado) y que el output de herramientas es dato no confiable;
  - "un año" no coincidía con el límite real de 366 días.

  Lo aprobé con esos cambios.
- **El `toolCallId` inventado frenó `verify-sources`.** En la primera corrida con el modelo real, el loop funcionó pero todos los datos quedaron como "no verificado". El modelo citaba IDs como `getQuote:AAPL` porque el ID real de la llamada no le llega como texto que pueda copiar. Lo resolví en `agent.ts` con un wrapper `citable` que usa `toModelOutput` para mostrarle `{ toolCallId, result }`, y ajusté la línea del prompt para que diga de dónde copiarlo. En la segunda corrida los datos salieron verificados. Lo documenté en la Decisión 6 y un test con modelo simulado comprueba que el modelo ve el ID.
- **Error de tipos al envolver las herramientas:** hacer spread sobre la unión `Tool<INPUT, OUTPUT>` no compilaba. Lo resolví con un genérico `T extends Tool` y una salida tipo `text` con `JSON.stringify`.
- **El modelo no siempre usa `getQuote` para "ayer":** una corrida usó `getHistoricalPrices`. El dato fue correcto, pero el eval de ese caso puede fallar; queda para revisar en la sección 7.

## Para recordar
- Un mecanismo de verificación no sirve si el modelo no tiene a la vista lo que tiene que citar: probar con el modelo real temprano.
- Revisar el prompt contra las specs y las herramientas antes de escribirlo encuentra contradicciones que después aparecerían como fallas raras del modelo.
