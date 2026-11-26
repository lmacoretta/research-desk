## Purpose

Arnés de evaluación offline que corre el agente contra fixtures locales con preguntas de respuesta conocida, para detectar regresiones de forma reproducible sin depender de Finnhub.

## ADDED Requirements

### Requirement: Ejecución con npm run eval
El sistema SHALL ofrecer el comando `npm run eval`, que MUST ejecutar el agente en modo fixtures sobre el conjunto de preguntas de evaluación, sin hacer requests a Finnhub.

#### Scenario: Corrida de evals
- **WHEN** se ejecuta `npm run eval`
- **THEN** se corren todas las preguntas con la fuente de fixtures y no hay requests de red a Finnhub

### Requirement: Diez preguntas con respuesta conocida
El conjunto de evaluación MUST tener 10 preguntas cuya respuesta se puede derivar de los fixtures. Cada una MUST declarar sus checks esperados: valores numéricos con tolerancia, herramientas que deben haberse llamado y, cuando corresponda, el error esperado. Entre las 10 MUST haber al menos una de ticker inexistente y una que requiera combinar dos herramientas.

#### Scenario: Pregunta de ticker inexistente
- **WHEN** se evalúa la pregunta sobre un ticker sin fixture
- **THEN** pasa solo si la respuesta no inventa datos y reporta el dato como no disponible

#### Scenario: Pregunta numérica
- **WHEN** se evalúa "¿Cuál fue el cierre de AAPL el último día del fixture?"
- **THEN** pasa solo si `dataPoints` contiene ese valor dentro de la tolerancia y con fuente `fixture`

### Requirement: Checks deterministas
La evaluación de cada pregunta MUST basarse en checks deterministas sobre la respuesta estructurada y las llamadas a herramientas, no en el juicio de otro modelo.

#### Scenario: Mismo resultado, mismo veredicto
- **WHEN** se evalúa dos veces la misma respuesta estructurada
- **THEN** el veredicto es idéntico

### Requirement: Reporte y código de salida
Al terminar, el comando MUST imprimir por pregunta si pasó o falló y por qué, el total de aprobadas sobre 10 y los tokens consumidos. MUST terminar con código distinto de cero si alguna pregunta falla.

#### Scenario: Una pregunta falla
- **WHEN** 9 de 10 preguntas pasan
- **THEN** el reporte muestra `9/10`, el motivo de la falla, y el proceso sale con código distinto de cero
