import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspect } from "node:util";

import {
  EnvError,
  getFinnhubEnv,
  getLangfuseEnv,
  getMarketDataModelId,
  getMarketDataSourceKind,
  getNeonGatewayEnv,
  type EnvSource,
} from "@/lib/env";

// Valores centinela: si alguno aparece en un mensaje de error, el test falla.
const SECRETS = {
  NEON_AI_GATEWAY_TOKEN: "nt_live_SENTINEL_NEON_TOKEN",
  FINNHUB_API_KEY: "SENTINEL_FINNHUB_KEY",
  LANGFUSE_PUBLIC_KEY: "pk-lf-SENTINEL_PUBLIC",
  LANGFUSE_SECRET_KEY: "sk-lf-SENTINEL_SECRET",
} as const;

const VALID: EnvSource = {
  ...SECRETS,
  NEON_AI_GATEWAY_BASE_URL: "https://br-example-api.ai.us-east-2.aws.neon.tech",
  LANGFUSE_BASE_URL: "https://us.cloud.langfuse.com",
  MODEL_MARKET_DATA: "gpt-5-4-nano",
};

function without(source: EnvSource, ...keys: string[]): EnvSource {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !keys.includes(key)),
  );
}

function captureEnvError(fn: () => unknown): EnvError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof EnvError, "expected an EnvError");
    return error;
  }
  assert.fail("expected the call to throw");
}

function assertNoSecrets(text: string, extra: readonly string[] = []): void {
  for (const value of [...Object.values(SECRETS), ...extra]) {
    assert.ok(!text.includes(value), `leaked value: ${value.slice(0, 6)}…`);
  }
}

describe("getNeonGatewayEnv", () => {
  it("returns the gateway config when both variables are valid", () => {
    assert.deepEqual(getNeonGatewayEnv(VALID), {
      baseURL: VALID.NEON_AI_GATEWAY_BASE_URL,
      token: SECRETS.NEON_AI_GATEWAY_TOKEN,
    });
  });

  it("throws naming the missing token without leaking other values", () => {
    const error = captureEnvError(() =>
      getNeonGatewayEnv(without(VALID, "NEON_AI_GATEWAY_TOKEN")),
    );
    assert.deepEqual(error.problems, [
      { variable: "NEON_AI_GATEWAY_TOKEN", reason: "missing" },
    ]);
    assert.match(error.message, /NEON_AI_GATEWAY_TOKEN \(missing\)/);
    assertNoSecrets(inspect(error));
  });

  it("treats an empty value as missing", () => {
    const error = captureEnvError(() =>
      getNeonGatewayEnv({ ...VALID, NEON_AI_GATEWAY_TOKEN: "   " }),
    );
    assert.equal(error.problems[0]?.reason, "missing");
  });

  it("rejects a non-https base URL without echoing it", () => {
    const badUrl = "http://SENTINEL_BAD_URL.example";
    const error = captureEnvError(() =>
      getNeonGatewayEnv({ ...VALID, NEON_AI_GATEWAY_BASE_URL: badUrl }),
    );
    assert.deepEqual(error.problems, [
      { variable: "NEON_AI_GATEWAY_BASE_URL", reason: "invalid" },
    ]);
    assertNoSecrets(inspect(error), [badUrl, "SENTINEL_BAD_URL"]);
  });
});

describe("getMarketDataModelId", () => {
  it("returns the configured model id", () => {
    assert.equal(getMarketDataModelId(VALID), "gpt-5-4-nano");
  });

  it("throws naming MODEL_MARKET_DATA when it is missing", () => {
    const error = captureEnvError(() =>
      getMarketDataModelId(without(VALID, "MODEL_MARKET_DATA")),
    );
    assert.match(error.message, /MODEL_MARKET_DATA \(missing\)/);
    assertNoSecrets(inspect(error));
  });
});

describe("getMarketDataSourceKind", () => {
  it("defaults to live when unset or empty", () => {
    assert.equal(getMarketDataSourceKind({}), "live");
    assert.equal(getMarketDataSourceKind({ MARKET_DATA_SOURCE: "" }), "live");
  });

  it("accepts fixtures", () => {
    assert.equal(
      getMarketDataSourceKind({ MARKET_DATA_SOURCE: "fixtures" }),
      "fixtures",
    );
  });

  it("rejects unknown values without echoing them", () => {
    const error = captureEnvError(() =>
      getMarketDataSourceKind({ MARKET_DATA_SOURCE: "SENTINEL_SOURCE" }),
    );
    assert.deepEqual(error.problems, [
      { variable: "MARKET_DATA_SOURCE", reason: "invalid" },
    ]);
    assertNoSecrets(inspect(error), ["SENTINEL_SOURCE"]);
  });
});

describe("getFinnhubEnv", () => {
  it("returns the api key", () => {
    assert.deepEqual(getFinnhubEnv(VALID), { apiKey: SECRETS.FINNHUB_API_KEY });
  });

  it("throws naming FINNHUB_API_KEY when it is missing", () => {
    const error = captureEnvError(() => getFinnhubEnv({ ...VALID, FINNHUB_API_KEY: "" }));
    assert.match(error.message, /FINNHUB_API_KEY \(missing\)/);
    assertNoSecrets(inspect(error));
  });
});

describe("getLangfuseEnv", () => {
  it("is configured when all three variables are valid", () => {
    assert.deepEqual(getLangfuseEnv(VALID), {
      configured: true,
      env: {
        publicKey: SECRETS.LANGFUSE_PUBLIC_KEY,
        secretKey: SECRETS.LANGFUSE_SECRET_KEY,
        baseUrl: VALID.LANGFUSE_BASE_URL,
      },
    });
  });

  it("does not throw when variables are missing and reports their names only", () => {
    const result = getLangfuseEnv(without(VALID, "LANGFUSE_SECRET_KEY"));
    assert.deepEqual(result, {
      configured: false,
      problems: [{ variable: "LANGFUSE_SECRET_KEY", reason: "missing" }],
    });
    assertNoSecrets(inspect(result));
  });

  it("reports all three variables when none is set", () => {
    const result = getLangfuseEnv({});
    assert.equal(result.configured, false);
    if (!result.configured) {
      assert.deepEqual(
        result.problems.map((problem) => problem.variable).sort(),
        ["LANGFUSE_BASE_URL", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"],
      );
    }
  });
});
