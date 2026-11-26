## Purpose

Herramientas de market data de solo lectura, reutilizables por cualquier agente, que devuelven datos de acciones validados, con procedencia y errores tipados, desde Finnhub o desde fixtures locales.

## ADDED Requirements

### Requirement: Cotización actual
El sistema SHALL ofrecer una herramienta `getQuote` que, dado un ticker, MUST devolver el precio actual, la variación absoluta y porcentual del día, apertura, máximo, mínimo, cierre anterior y el timestamp de la cotización.

#### Scenario: Ticker válido con datos
- **WHEN** se invoca `getQuote` con `{ ticker: "AAPL" }` y la fuente tiene datos
- **THEN** devuelve un resultado exitoso con precio, variación, apertura, máximo, mínimo, cierre anterior y timestamp numéricos

#### Scenario: Ticker sin datos
- **WHEN** se invoca `getQuote` con un ticker bien formado para el que la fuente no tiene cotización (precio 0 y timestamp 0)
- **THEN** devuelve un error tipado `NOT_FOUND`, no una cotización en cero

### Requirement: Precios históricos por rango de fechas
El sistema SHALL ofrecer una herramienta `getHistoricalPrices` que, dado un ticker y un rango `from`/`to` en formato `YYYY-MM-DD`, MUST devolver las velas diarias (fecha, apertura, máximo, mínimo, cierre, volumen) ordenadas por fecha ascendente.

#### Scenario: Rango válido
- **WHEN** se invoca con `{ ticker: "MSFT", from: "2025-01-02", to: "2025-01-31" }`
- **THEN** devuelve las velas diarias de ese rango en orden ascendente de fecha

#### Scenario: Rango invertido
- **WHEN** `from` es posterior a `to`
- **THEN** devuelve un error tipado `INVALID_INPUT` sin consultar la fuente

#### Scenario: Rango demasiado largo o en el futuro
- **WHEN** el rango supera 366 días o `to` es posterior a la fecha actual
- **THEN** devuelve un error tipado `INVALID_INPUT` sin consultar la fuente

### Requirement: Métricas clave
El sistema SHALL ofrecer una herramienta `getKeyMetrics` que, dado un ticker, MUST devolver P/E, margen bruto, margen operativo, margen neto, crecimiento de ingresos y crecimiento de EPS, indicando para cada métrica su período (TTM, anual o trimestral) y usando `null` cuando la fuente no la informa.

#### Scenario: Métricas disponibles
- **WHEN** se invoca `getKeyMetrics` con `{ ticker: "NVDA" }`
- **THEN** devuelve cada métrica como número o `null`, con su período

#### Scenario: Métrica faltante
- **WHEN** la fuente no informa una de las métricas
- **THEN** esa métrica es `null` y el resto del resultado sigue siendo exitoso

### Requirement: Validación estricta de parámetros
Cada herramienta MUST validar sus parámetros antes de acceder a la fuente. El ticker MUST cumplir un formato estricto: 1 a 5 letras mayúsculas, opcionalmente seguidas de un punto y 1 a 2 letras mayúsculas (por ejemplo `BRK.B`). Los parámetros desconocidos MUST rechazarse.

#### Scenario: Ticker con formato inválido
- **WHEN** se invoca una herramienta con `{ ticker: "aapl; DROP" }` o `{ ticker: "../quote" }`
- **THEN** devuelve un error tipado `INVALID_TICKER` y no se hace ninguna llamada a la fuente

#### Scenario: Parámetro desconocido
- **WHEN** se invoca una herramienta con un campo que no está en su esquema
- **THEN** devuelve un error tipado `INVALID_INPUT`

### Requirement: Errores tipados
Las herramientas MUST devolver los fallos como resultado tipado, no como excepción, con un código de un conjunto cerrado (`INVALID_TICKER`, `INVALID_INPUT`, `NOT_FOUND`, `RATE_LIMITED`, `ACCESS_DENIED`, `UPSTREAM_UNAVAILABLE`) y un mensaje breve sin detalles internos, URLs ni credenciales.

#### Scenario: Rate limit de la fuente
- **WHEN** Finnhub responde HTTP 429
- **THEN** la herramienta devuelve `RATE_LIMITED`

#### Scenario: Fuente caída o lenta
- **WHEN** Finnhub responde 5xx, falla la red o no responde dentro del timeout
- **THEN** la herramienta devuelve `UPSTREAM_UNAVAILABLE`

#### Scenario: Endpoint no incluido en el plan
- **WHEN** Finnhub responde 401 o 403 para un endpoint
- **THEN** la herramienta devuelve `ACCESS_DENIED`

#### Scenario: Respuesta con forma inesperada
- **WHEN** el cuerpo de la respuesta no cumple el esquema esperado
- **THEN** la herramienta devuelve `UPSTREAM_UNAVAILABLE` y no propaga datos sin validar

### Requirement: Procedencia de cada resultado
Todo resultado exitoso MUST incluir su procedencia: proveedor (`finnhub` o `fixture`), endpoint lógico consultado, ticker y momento de obtención, para que quien lo use pueda citar la fuente de cada dato.

#### Scenario: Resultado en vivo
- **WHEN** una herramienta obtiene datos de Finnhub
- **THEN** el resultado incluye `provider: "finnhub"`, el endpoint lógico y `fetchedAt`

#### Scenario: Resultado desde fixtures
- **WHEN** una herramienta obtiene datos en modo eval
- **THEN** el resultado incluye `provider: "fixture"`

### Requirement: Solo lectura y destino único
Las herramientas MUST ser de solo lectura y MUST comunicarse únicamente con la API de Finnhub (o con los fixtures locales en modo eval). Ningún parámetro MUST poder alterar el host ni la ruta del endpoint.

#### Scenario: Intento de redirigir la llamada
- **WHEN** un parámetro contiene una URL, una ruta o caracteres de query
- **THEN** la validación lo rechaza antes de construir cualquier request

### Requirement: Fuente de datos intercambiable
El sistema MUST permitir elegir por variable de entorno entre Finnhub en vivo y fixtures JSON locales. En modo fixtures, las herramientas MUST NOT hacer requests de red y MUST devolver la misma forma de resultado que en vivo.

#### Scenario: Modo fixtures
- **WHEN** la fuente configurada es fixtures y se invoca `getQuote` con un ticker que tiene fixture
- **THEN** devuelve los datos del fixture sin acceder a la red

#### Scenario: Fixture faltante
- **WHEN** la fuente configurada es fixtures y no existe fixture para el ticker pedido
- **THEN** devuelve `NOT_FOUND`

### Requirement: Herramientas desacopladas del agente
Las herramientas MUST poder usarse desde cualquier agente o script sin depender del agente de market data, de la UI ni del endpoint HTTP.

#### Scenario: Uso directo desde otro módulo de servidor
- **WHEN** otro agente o el script de evals importa las herramientas
- **THEN** puede usarlas sin cargar código del agente de market data
