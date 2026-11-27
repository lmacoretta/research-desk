## Purpose

Agente que responde preguntas sobre acciones razonando y llamando a las herramientas de market data en un loop acotado, y que entrega una respuesta estructurada donde cada dato cita su fuente; incluye el endpoint de servidor que lo expone.

## ADDED Requirements

### Requirement: Loop de razonamiento y herramientas
El agente SHALL responder una pregunta alternando pasos de razonamiento y llamadas a las herramientas `getQuote`, `getHistoricalPrices` y `getKeyMetrics` hasta tener datos suficientes, y entonces MUST emitir la respuesta final. El agente MUST NOT tener acceso a otras herramientas.

#### Scenario: Pregunta que requiere varias herramientas
- **WHEN** el usuario pregunta "¿Cuál es el P/E de AAPL y cómo cerró ayer?"
- **THEN** el agente llama a `getKeyMetrics` y a `getQuote` para AAPL y después emite la respuesta final

#### Scenario: Pregunta fuera de dominio
- **WHEN** el usuario pregunta algo que no se responde con market data
- **THEN** el agente responde sin llamar herramientas e indica que solo responde sobre datos de mercado

### Requirement: Límite de pasos
Cada consulta MUST ejecutar como máximo un número configurado de pasos (por defecto 8). Al alcanzar el límite, el agente MUST terminar y emitir una respuesta final con los datos obtenidos hasta ese momento, indicando que la respuesta es parcial.

#### Scenario: Se alcanza el límite
- **WHEN** el agente llega al número máximo de pasos sin terminar
- **THEN** la consulta termina con una respuesta final marcada como parcial y no se ejecutan más pasos

### Requirement: Límite de tokens de salida
Cada llamada al modelo MUST tener un tope de tokens de salida configurado.

#### Scenario: Tope aplicado
- **WHEN** el agente invoca al modelo
- **THEN** la invocación lleva el tope de tokens de salida configurado

### Requirement: Recuperación ante errores de herramientas
Cuando una herramienta devuelve un error tipado, el agente MUST recibirlo como resultado, MUST NOT inventar el dato faltante y MUST reflejar en la respuesta final qué dato no se pudo obtener y por qué, en términos generales.

#### Scenario: Ticker inexistente
- **WHEN** el usuario pregunta por "ZZZZZ" y `getQuote` devuelve `NOT_FOUND`
- **THEN** la respuesta final dice que no hay datos para ese ticker y no incluye un precio

#### Scenario: Rate limit durante la consulta
- **WHEN** una herramienta devuelve `RATE_LIMITED`
- **THEN** la respuesta final indica que el proveedor limitó las consultas y presenta solo los datos obtenidos

### Requirement: Respuesta final estructurada
La respuesta final MUST cumplir un esquema validado con: `summary` (texto), `dataPoints` (lista de datos usados, cada uno con etiqueta, valor, unidad o moneda, ticker y fuente), `isPartial` (booleano) y `unavailable` (lista de datos que no se pudieron obtener, con motivo).

#### Scenario: Respuesta completa
- **WHEN** el agente termina una consulta con éxito
- **THEN** el cliente recibe un objeto que valida contra el esquema, con al menos un elemento en `dataPoints`

#### Scenario: Salida del modelo inválida
- **WHEN** el modelo produce una respuesta final que no valida contra el esquema
- **THEN** el cliente recibe un error genérico en lugar de una respuesta mal formada

### Requirement: Fuente verificable de cada dato
Cada elemento de `dataPoints` MUST referenciar una llamada a herramienta realmente ejecutada y exitosa en esa consulta, e incluir su proveedor, endpoint y momento de obtención. El servidor MUST descartar o marcar los datos que no correspondan a una llamada real.

#### Scenario: Dato con fuente válida
- **WHEN** la respuesta incluye el precio de AAPL obtenido con `getQuote`
- **THEN** ese dato referencia esa llamada y muestra `finnhub`, el endpoint de cotización y su `fetchedAt`

#### Scenario: Dato sin respaldo
- **WHEN** el modelo incluye un dato que no referencia ninguna llamada exitosa de la consulta
- **THEN** el servidor lo quita de `dataPoints` o lo marca como no verificado antes de enviarlo

### Requirement: Modelo configurable
El modelo del agente MUST tomarse de la variable de entorno `MODEL_MARKET_DATA` y servirse a través del Neon AI Gateway. Si la variable falta, el servidor MUST rechazar la consulta con un error genérico y registrar la causa solo del lado del servidor.

#### Scenario: Variable ausente
- **WHEN** `MODEL_MARKET_DATA` no está definida y llega una consulta
- **THEN** el cliente recibe un error genérico y el log del servidor indica que falta la configuración del modelo

### Requirement: Validación de la pregunta
El endpoint MUST validar el cuerpo del request contra un esquema estricto: la pregunta MUST ser texto no vacío de hasta 500 caracteres, y los campos desconocidos MUST rechazarse.

#### Scenario: Pregunta demasiado larga
- **WHEN** llega una pregunta de más de 500 caracteres
- **THEN** el endpoint responde 400 con un mensaje genérico y no invoca al modelo

#### Scenario: Cuerpo mal formado
- **WHEN** el cuerpo no es JSON válido o no cumple el esquema
- **THEN** el endpoint responde 400 con un mensaje genérico

### Requirement: Ejecución solo en servidor
El agente, las herramientas, el acceso a Finnhub y al gateway y la lectura de credenciales MUST ejecutarse solo en el servidor. Ninguna credencial MUST llegar al bundle del cliente ni a las respuestas.

#### Scenario: Import desde el cliente
- **WHEN** un componente de cliente intenta importar un módulo de servidor del agente
- **THEN** el build falla

### Requirement: Errores genéricos al cliente
Ante cualquier fallo, el cliente MUST recibir solo un mensaje genérico y un identificador de correlación. Stack traces, mensajes del proveedor, URLs y credenciales MUST quedar solo en el servidor.

#### Scenario: Falla el gateway de modelos
- **WHEN** el Neon AI Gateway devuelve un error durante la consulta
- **THEN** el cliente recibe un mensaje genérico con un identificador de correlación y el detalle queda en el log del servidor

### Requirement: Respuesta en streaming
El endpoint MUST transmitir en streaming los pasos del agente: cada llamada a herramienta con su estado y parámetros, su resultado o error tipado, y la respuesta final estructurada.

#### Scenario: Progreso visible antes de terminar
- **WHEN** el agente ejecuta una herramienta
- **THEN** el cliente recibe la llamada en estado pendiente antes de que termine la consulta
