import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspect } from "node:util";

import { EnvError, type EnvSource } from "@/lib/env";
import { getMarketDataModel } from "@/lib/llm/models";

const TOKEN = "nt_live_SENTINEL_NEON_TOKEN";

const VALID: EnvSource = {
  NEON_AI_GATEWAY_BASE_URL: "https://br-example-api.ai.us-east-2.aws.neon.tech",
  NEON_AI_GATEWAY_TOKEN: TOKEN,
  MODEL_MARKET_DATA: "gpt-5-4-nano",
};

describe("getMarketDataModel", () => {
  it("resolves the model id from MODEL_MARKET_DATA without network calls", () => {
    const model = getMarketDataModel(VALID);
    assert.ok(typeof model !== "string");
    assert.equal(model.modelId, "gpt-5-4-nano");
  });

  it("fails with an EnvError naming MODEL_MARKET_DATA when it is missing", () => {
    const source: EnvSource = { ...VALID, MODEL_MARKET_DATA: undefined };
    assert.throws(
      () => getMarketDataModel(source),
      (error: unknown) => {
        assert.ok(error instanceof EnvError);
        assert.deepEqual(error.problems, [
          { variable: "MODEL_MARKET_DATA", reason: "missing" },
        ]);
        assert.ok(!inspect(error).includes(TOKEN));
        return true;
      },
    );
  });

  it("fails with an EnvError when the gateway token is missing", () => {
    const source: EnvSource = { ...VALID, NEON_AI_GATEWAY_TOKEN: "" };
    assert.throws(() => getMarketDataModel(source), EnvError);
  });
});
