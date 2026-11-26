## Purpose

Interfaz de chat que muestra en tiempo real lo que hace un agente: cada llamada a herramienta como tarjeta con su estado, parámetros y resultado, y la respuesta final estructurada con sus fuentes, renderizada de forma segura.

## ADDED Requirements

### Requirement: Envío de preguntas
La UI SHALL permitir escribir y enviar una pregunta, MUST limitar la entrada a 500 caracteres mostrando el conteo, y MUST deshabilitar el envío mientras una consulta está en curso.

#### Scenario: Pregunta en curso
- **WHEN** el usuario envía una pregunta
- **THEN** el botón de envío queda deshabilitado hasta que la consulta termina o falla

#### Scenario: Límite de caracteres
- **WHEN** el usuario escribe más de 500 caracteres
- **THEN** la UI no permite enviar y muestra el conteo excedido

### Requirement: Tarjeta por llamada a herramienta
Cada llamada a herramienta MUST mostrarse como una tarjeta con el nombre de la herramienta, sus parámetros y un estado: `pendiente` mientras se ejecuta, `ok` con el resultado cuando termina bien y `error` con el código y un mensaje genérico cuando falla.

#### Scenario: Ejecución exitosa
- **WHEN** llega una llamada a `getQuote` y luego su resultado
- **THEN** la tarjeta pasa de `pendiente` a `ok` y muestra los parámetros y el resultado

#### Scenario: Herramienta con error
- **WHEN** una herramienta devuelve `RATE_LIMITED`
- **THEN** la tarjeta muestra estado `error` con ese código y un mensaje legible

### Requirement: Respuesta final con fuentes
La UI MUST mostrar la respuesta final con el resumen, la lista de datos usados con su fuente (proveedor, endpoint y momento) y, si corresponde, un aviso de respuesta parcial y la lista de datos no disponibles.

#### Scenario: Respuesta parcial
- **WHEN** la respuesta final tiene `isPartial: true`
- **THEN** la UI muestra un aviso visible de respuesta parcial junto con los datos no disponibles

### Requirement: Render seguro
Todo el contenido proveniente del modelo o de las herramientas MUST renderizarse como texto. La UI MUST NOT interpretar HTML, ejecutar scripts ni generar links o imágenes a partir de ese contenido.

#### Scenario: Contenido con HTML
- **WHEN** el resumen del modelo contiene `<img src=x onerror=alert(1)>`
- **THEN** la UI lo muestra como texto literal y no se ejecuta nada

### Requirement: Error de consulta
Si la consulta falla, la UI MUST mostrar un mensaje genérico con el identificador de correlación y MUST permitir enviar una nueva pregunta.

#### Scenario: Falla del servidor
- **WHEN** el endpoint devuelve un error
- **THEN** la UI muestra el mensaje genérico y el identificador, y vuelve a habilitar el envío
