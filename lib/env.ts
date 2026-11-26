import "server-only";
import { z } from "zod";

/*
 * Lectura y validación de variables de entorno (solo servidor).
 *
 * Diseño:
 * - Validación perezosa por sección: cada consumidor pide solo lo que usa y en el
 *   momento de usarlo (por ejemplo, las evals en modo fixtures no necesitan
 *   FINNHUB_API_KEY). Importar este módulo nunca lanza, así que `next build` no
 *   depende de que existan las variables.
 * - Los errores nombran variables, nunca valores: el mensaje se arma a mano a
 *   partir de los nombres, sin reenviar mensajes ni inputs de zod.
 * - Cada getter acepta la fuente de variables como parámetro (por defecto
 *   `process.env`) para poder testearlo sin tocar el entorno global.
 */

export type EnvSource = Readonly<Record<string, string | undefined>>;

export type EnvProblem = {
  variable: string;
  reason: "missing" | "invalid";
};

export class EnvError extends Error {
  readonly problems: readonly EnvProblem[];

  constructor(section: string, problems: readonly EnvProblem[]) {
    const detail = problems
      .map((problem) => `${problem.variable} (${problem.reason})`)
      .join(", ");
    super(`Invalid environment for ${section}: ${detail}`);
    this.name = "EnvError";
    this.problems = problems;
  }
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

// Una variable vacía (`FOO=`) cuenta como faltante, igual que una ausente.
const blankToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const requiredString = z.preprocess(blankToUndefined, z.string().trim());
const httpsUrl = z.preprocess(blankToUndefined, z.url({ protocol: /^https$/ }));

function collectProblems(error: z.ZodError, source: EnvSource): EnvProblem[] {
  const variables = new Set(
    error.issues
      .map((issue) => issue.path[0])
      .filter((key): key is string => typeof key === "string"),
  );
  return [...variables].map((variable) => ({
    variable,
    reason: isBlank(source[variable]) ? "missing" : "invalid",
  }));
}

function parseSection<T>(
  section: string,
  schema: z.ZodType<T>,
  source: EnvSource,
): T {
  const result = schema.safeParse(source);
  if (result.success) {
    return result.data;
  }
  // Sin `cause`: el ZodError no viaja con el error para no arrastrar inputs.
  throw new EnvError(section, collectProblems(result.error, source));
}

// --- Neon AI Gateway ---------------------------------------------------------

const neonGatewaySchema = z.object({
  NEON_AI_GATEWAY_BASE_URL: httpsUrl,
  NEON_AI_GATEWAY_TOKEN: requiredString,
});

export type NeonGatewayEnv = {
  baseURL: string;
  token: string;
};

export function getNeonGatewayEnv(
  source: EnvSource = process.env,
): NeonGatewayEnv {
  const env = parseSection("Neon AI Gateway", neonGatewaySchema, source);
  return {
    baseURL: env.NEON_AI_GATEWAY_BASE_URL,
    token: env.NEON_AI_GATEWAY_TOKEN,
  };
}

// --- Modelo del agente de market data ---------------------------------------

const marketDataModelSchema = z.object({
  MODEL_MARKET_DATA: requiredString,
});

export function getMarketDataModelId(source: EnvSource = process.env): string {
  return parseSection("market data model", marketDataModelSchema, source)
    .MODEL_MARKET_DATA;
}

// --- Fuente de market data ---------------------------------------------------

export const MARKET_DATA_SOURCES = ["live", "fixtures"] as const;
export type MarketDataSourceKind = (typeof MARKET_DATA_SOURCES)[number];

const marketDataSourceSchema = z.object({
  MARKET_DATA_SOURCE: z.preprocess(
    blankToUndefined,
    z.enum(MARKET_DATA_SOURCES).default("live"),
  ),
});

export function getMarketDataSourceKind(
  source: EnvSource = process.env,
): MarketDataSourceKind {
  return parseSection("market data source", marketDataSourceSchema, source)
    .MARKET_DATA_SOURCE;
}

// --- Finnhub -----------------------------------------------------------------

const finnhubSchema = z.object({
  FINNHUB_API_KEY: requiredString,
});

export type FinnhubEnv = {
  apiKey: string;
};

export function getFinnhubEnv(source: EnvSource = process.env): FinnhubEnv {
  return {
    apiKey: parseSection("Finnhub", finnhubSchema, source).FINNHUB_API_KEY,
  };
}

// --- Langfuse (opcional) -----------------------------------------------------

const langfuseSchema = z.object({
  LANGFUSE_PUBLIC_KEY: requiredString,
  LANGFUSE_SECRET_KEY: requiredString,
  LANGFUSE_BASE_URL: httpsUrl,
});

export type LangfuseEnv = {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
};

export type LangfuseEnvResult =
  | { configured: true; env: LangfuseEnv }
  | { configured: false; problems: readonly EnvProblem[] };

/**
 * El tracing es opcional y no debe bloquear: en lugar de lanzar, devuelve qué
 * variables faltan o son inválidas para que el llamador emita un aviso.
 */
export function getLangfuseEnv(
  source: EnvSource = process.env,
): LangfuseEnvResult {
  const result = langfuseSchema.safeParse(source);
  if (!result.success) {
    return {
      configured: false,
      problems: collectProblems(result.error, source),
    };
  }
  return {
    configured: true,
    env: {
      publicKey: result.data.LANGFUSE_PUBLIC_KEY,
      secretKey: result.data.LANGFUSE_SECRET_KEY,
      baseUrl: result.data.LANGFUSE_BASE_URL,
    },
  };
}
