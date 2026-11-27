import "server-only";

/*
 * Límites del agente de market data (Decisión 5 del design).
 *
 * - `MAX_STEPS` cuenta todos los pasos del loop, incluido el de la respuesta
 *   estructurada: con 8 quedan hasta 7 pasos con herramientas más el final.
 *   `ToolLoopAgent` trae 20 por defecto, así que se fija explícitamente.
 * - `MAX_OUTPUT_TOKENS` es el tope por llamada al modelo, no por consulta.
 * - `MAX_QUESTION_CHARS` lo aplica el endpoint antes de invocar al modelo.
 */

export const MAX_STEPS = 8;
export const MAX_OUTPUT_TOKENS = 1024;
export const MAX_QUESTION_CHARS = 500;
