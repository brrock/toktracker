import type { TokenBreakdown, UsageMessage } from "@toktracker/shared";

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  inputAbove128k?: number;
  inputAbove200k?: number;
  inputAbove256k?: number;
  inputAbove272k?: number;
  outputAbove128k?: number;
  outputAbove200k?: number;
  outputAbove256k?: number;
  outputAbove272k?: number;
  cacheReadAbove200k?: number;
  cacheReadAbove272k?: number;
  cacheWriteAbove200k?: number;
}
export type PriceCatalog = Record<string, ModelPrice>;

interface ModelsDevCost {
  input?: unknown;
  output?: unknown;
  cache_read?: unknown;
  cache_write?: unknown;
}

const finitePrice = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

const tieredCost = (
  tokens: number,
  base: number,
  tiers: [number, number | undefined][]
): number => {
  let activePrice = base;
  let cost = 0;
  let lowerBound = 0;
  for (const [threshold, tierPrice] of tiers) {
    if (tierPrice === undefined) {
      continue;
    }
    if (tokens <= threshold) {
      return cost + Math.max(0, tokens - lowerBound) * activePrice;
    }
    cost += (threshold - lowerBound) * activePrice;
    lowerBound = threshold;
    activePrice = tierPrice;
  }
  return cost + Math.max(0, tokens - lowerBound) * activePrice;
};

const usesOpenAiFullRequestPricing = (
  modelId: string,
  providerId: string,
  tokens: TokenBreakdown
): boolean => {
  const model = modelId.toLowerCase().split("/").at(-1) ?? "";
  const supported = [
    "gpt-5.4",
    "gpt-5.4-pro",
    "gpt-5.5",
    "gpt-5.5-pro",
    "gpt-5.6",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ].some((name) => model === name || model.startsWith(`${name}-20`));
  const provider = providerId.toLowerCase();
  return (
    (provider === "openai" || provider === "openai-codex") &&
    supported &&
    tokens.input + tokens.cacheRead + tokens.cacheWrite > 272_000
  );
};

/** Prices are USD per million tokens, matching tokscale/LiteLLM semantics. */
export const calculateCost = (
  tokens: TokenBreakdown,
  price: ModelPrice,
  modelId = "",
  providerId = ""
): number => {
  let effective = price;
  if (
    usesOpenAiFullRequestPricing(modelId, providerId, tokens) &&
    price.inputAbove272k !== undefined &&
    price.outputAbove272k !== undefined
  ) {
    const inputMultiplier =
      price.input > 0 ? price.inputAbove272k / price.input : 1;
    effective = {
      ...price,
      cacheRead: price.cacheReadAbove272k ?? price.cacheRead,
      cacheWrite:
        price.cacheWrite === undefined
          ? undefined
          : price.cacheWrite * inputMultiplier,
      input: price.inputAbove272k,
      output: price.outputAbove272k,
      reasoning: price.outputAbove272k,
    };
  }
  const inputCost = tieredCost(tokens.input, effective.input, [
    [128_000, effective.inputAbove128k],
    [200_000, effective.inputAbove200k],
    [256_000, effective.inputAbove256k],
    [272_000, effective.inputAbove272k],
  ]);
  const outputCost = tieredCost(
    tokens.output + tokens.reasoning,
    effective.output,
    [
      [128_000, effective.outputAbove128k],
      [200_000, effective.outputAbove200k],
      [256_000, effective.outputAbove256k],
      [272_000, effective.outputAbove272k],
    ]
  );
  const cacheReadCost = tieredCost(tokens.cacheRead, effective.cacheRead ?? 0, [
    [200_000, effective.cacheReadAbove200k],
    [272_000, effective.cacheReadAbove272k],
  ]);
  const cacheWriteCost = tieredCost(
    tokens.cacheWrite,
    effective.cacheWrite ?? 0,
    [[200_000, effective.cacheWriteAbove200k]]
  );
  return (inputCost + outputCost + cacheReadCost + cacheWriteCost) / 1_000_000;
};

export const parseModelsDevCatalog = (value: unknown): PriceCatalog => {
  if (!value || typeof value !== "object") {
    return {};
  }
  const catalog: PriceCatalog = {};
  for (const [providerId, providerValue] of Object.entries(value)) {
    if (!providerValue || typeof providerValue !== "object") {
      continue;
    }
    const models = Reflect.get(providerValue, "models");
    if (!models || typeof models !== "object") {
      continue;
    }
    for (const [modelKey, modelValue] of Object.entries(models)) {
      if (!modelValue || typeof modelValue !== "object") {
        continue;
      }
      const cost = Reflect.get(modelValue, "cost") as ModelsDevCost | undefined;
      const input = finitePrice(cost?.input);
      const output = finitePrice(cost?.output);
      if (input === undefined || output === undefined) {
        continue;
      }
      const declaredId = Reflect.get(modelValue, "id");
      const modelId = typeof declaredId === "string" ? declaredId : modelKey;
      catalog[`${providerId}/${modelId}`.toLowerCase()] = {
        cacheRead: finitePrice(cost?.cache_read),
        cacheWrite: finitePrice(cost?.cache_write),
        input,
        output,
      };
    }
  }
  return catalog;
};

export const parseLiteLlmCatalog = (value: unknown): PriceCatalog => {
  if (!value || typeof value !== "object") {
    return {};
  }
  const catalog: PriceCatalog = {};
  for (const [modelId, modelValue] of Object.entries(value)) {
    if (!modelValue || typeof modelValue !== "object") {
      continue;
    }
    const inputPerToken = finitePrice(
      Reflect.get(modelValue, "input_cost_per_token")
    );
    const outputPerToken = finitePrice(
      Reflect.get(modelValue, "output_cost_per_token")
    );
    if (inputPerToken === undefined || outputPerToken === undefined) {
      continue;
    }
    const perMillion = (field: string): number | undefined => {
      const fieldValue = finitePrice(Reflect.get(modelValue, field));
      return fieldValue === undefined ? undefined : fieldValue * 1_000_000;
    };
    catalog[modelId.toLowerCase()] = {
      cacheRead: perMillion("cache_read_input_token_cost"),
      cacheReadAbove200k: perMillion(
        "cache_read_input_token_cost_above_200k_tokens"
      ),
      cacheReadAbove272k: perMillion(
        "cache_read_input_token_cost_above_272k_tokens"
      ),
      cacheWrite: perMillion("cache_creation_input_token_cost"),
      cacheWriteAbove200k: perMillion(
        "cache_creation_input_token_cost_above_200k_tokens"
      ),
      input: inputPerToken * 1_000_000,
      inputAbove128k: perMillion("input_cost_per_token_above_128k_tokens"),
      inputAbove200k: perMillion("input_cost_per_token_above_200k_tokens"),
      inputAbove256k: perMillion("input_cost_per_token_above_256k_tokens"),
      inputAbove272k: perMillion("input_cost_per_token_above_272k_tokens"),
      output: outputPerToken * 1_000_000,
      outputAbove128k: perMillion("output_cost_per_token_above_128k_tokens"),
      outputAbove200k: perMillion("output_cost_per_token_above_200k_tokens"),
      outputAbove256k: perMillion("output_cost_per_token_above_256k_tokens"),
      outputAbove272k: perMillion("output_cost_per_token_above_272k_tokens"),
    };
  }
  return catalog;
};

export const findModelPrice = (
  catalog: PriceCatalog,
  modelId: string,
  providerId: string
): ModelPrice | undefined => {
  const rawModel = modelId.toLowerCase();
  const model = rawModel.replace(/-\d{8}$/u, "");
  const modelProvider = model.includes("/") ? model.split("/")[0] : undefined;
  const providerAliases: Record<string, string> = { "openai-codex": "openai" };
  const provider =
    modelProvider ??
    providerAliases[providerId.toLowerCase()] ??
    providerId.toLowerCase();
  const barePrice = catalog[model];
  const providerPrice = catalog[`${provider}/${model}`];
  const usesOpenAiTiers =
    provider === "openai" &&
    [
      "gpt-5.4",
      "gpt-5.4-pro",
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.6",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ].some((name) => model === name || model.startsWith(`${name}-20`));
  const exact = usesOpenAiTiers
    ? (barePrice ?? providerPrice)
    : (providerPrice ?? barePrice);
  if (exact) {
    return exact;
  }

  const terminalModel = model.split("/").at(-1);
  if (!terminalModel) {
    return undefined;
  }
  const providerMatch = Object.entries(catalog).find(
    ([key]) =>
      key.startsWith(`${provider}/`) && key.endsWith(`/${terminalModel}`)
  );
  if (providerMatch) {
    return providerMatch[1];
  }

  const modelMatches = Object.entries(catalog).filter(([key]) =>
    key.endsWith(`/${terminalModel}`)
  );
  return modelMatches.length === 1 ? modelMatches[0]?.[1] : undefined;
};

export const applyEstimatedPricing = (
  messages: UsageMessage[],
  catalog: PriceCatalog
): UsageMessage[] =>
  messages.map((message) => {
    if (message.costSource === "providerReported") {
      return message;
    }
    const price = findModelPrice(catalog, message.modelId, message.providerId);
    if (!price) {
      return message;
    }
    return {
      ...message,
      cost: calculateCost(
        message.tokens,
        price,
        message.modelId,
        message.providerId
      ),
      costSource: "estimated",
    };
  });
