## Purpose

Tracing por consulta de los agentes en Langfuse: cada paso del modelo y cada llamada a herramienta, el uso de tokens y el costo, sin exponer credenciales ni headers.

## ADDED Requirements

### Requirement: Un trace por consulta
Cada consulta al agente MUST generar un trace en Langfuse identificado por el identificador de correlación de la consulta, con el nombre del agente y el modelo usado.

#### Scenario: Consulta trazada
- **WHEN** se completa una consulta
- **THEN** existe en Langfuse un trace con ese identificador de correlación, el nombre del agente y el modelo

### Requirement: Pasos y herramientas en el trace
El trace MUST incluir un span por cada paso del modelo y por cada llamada a herramienta, con sus parámetros, su resultado o código de error y su duración.

#### Scenario: Herramienta con error
- **WHEN** una herramienta devuelve `UPSTREAM_UNAVAILABLE`
- **THEN** su span registra el código de error y la duración

### Requirement: Tokens y costo por consulta
El trace MUST registrar los tokens de entrada y salida de cada llamada al modelo, y Langfuse MUST poder calcular el costo total de la consulta a partir de ellos.

#### Scenario: Costo visible
- **WHEN** una consulta termina después de tres pasos del modelo
- **THEN** el trace muestra los tokens de cada paso y un costo total de la consulta

### Requirement: Sin secretos en los traces
Los traces y logs MUST NOT contener claves de API, tokens, headers HTTP ni URLs con credenciales. Esto aplica a Finnhub, al Neon AI Gateway y a Langfuse.

#### Scenario: Revisión de un trace
- **WHEN** se inspecciona cualquier span de una consulta
- **THEN** no aparece el valor de `FINNHUB_API_KEY`, `NEON_AI_GATEWAY_TOKEN`, `LANGFUSE_SECRET_KEY` ni ningún header `Authorization` o `X-Finnhub-Token`

### Requirement: Tracing no bloqueante
Una falla de Langfuse MUST NOT hacer fallar ni demorar de forma perceptible la consulta del usuario.

#### Scenario: Langfuse no disponible
- **WHEN** Langfuse no responde durante una consulta
- **THEN** la consulta se completa normalmente y la falla de tracing queda solo en el log del servidor

#### Scenario: Langfuse sin configurar
- **WHEN** faltan las variables de Langfuse
- **THEN** el agente funciona sin tracing y el servidor registra un aviso al iniciar
