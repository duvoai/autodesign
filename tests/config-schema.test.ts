import { expect, test } from "bun:test";
import { HarnessConfigSchema, BASELINE_CONFIG } from "../src/config/schema";

test("baseline config validates", () => {
  expect(() => HarnessConfigSchema.parse(BASELINE_CONFIG)).not.toThrow();
  expect(BASELINE_CONFIG.version).toBe(0);
  expect(BASELINE_CONFIG.parent_version).toBeNull();
});

test("rejects unknown tools and bad skill ids", () => {
  const bad = { ...BASELINE_CONFIG, tools: ["read", "browser"] };
  expect(() => HarnessConfigSchema.parse(bad)).toThrow();
  const badSkill = { ...BASELINE_CONFIG, skills: [{ id: "Bad Id!", description: "x", content: "x" }] };
  expect(() => HarnessConfigSchema.parse(badSkill)).toThrow();
});

test("round-trips through JSON", () => {
  const parsed = HarnessConfigSchema.parse(JSON.parse(JSON.stringify(BASELINE_CONFIG)));
  expect(parsed).toEqual(BASELINE_CONFIG);
});

test("normalizes model given as a bare string (mutator flattening)", () => {
  const flattened = { ...BASELINE_CONFIG, model: "anthropic/claude-sonnet-4-6" };
  const parsed = HarnessConfigSchema.parse(flattened);
  expect(parsed.model).toEqual({ name: "anthropic/claude-sonnet-4-6", thinking_level: "medium" });
});

test("defaults a missing thinking_level to medium", () => {
  const partial = { ...BASELINE_CONFIG, model: { name: "anthropic/claude-sonnet-4-6" } };
  const parsed = HarnessConfigSchema.parse(partial);
  expect(parsed.model).toEqual({ name: "anthropic/claude-sonnet-4-6", thinking_level: "medium" });
});

test("preserves an explicit thinking_level", () => {
  const explicit = { ...BASELINE_CONFIG, model: { name: "anthropic/claude-sonnet-4-6", thinking_level: "high" } };
  expect(HarnessConfigSchema.parse(explicit).model).toEqual({ name: "anthropic/claude-sonnet-4-6", thinking_level: "high" });
});

test("recovers the real model name from leaked tool-call markup", () => {
  // Exact corruption observed from the mutator that broke every build in a run.
  const corrupted = { ...BASELINE_CONFIG, model: { name: '\n<parameter name="name">anthropic/claude-sonnet-4-6', thinking_level: "medium" } };
  const parsed = HarnessConfigSchema.parse(corrupted);
  expect(parsed.model.name).toBe("anthropic/claude-sonnet-4-6");
});

test("coerces an unknown/unrunnable model name to the default", () => {
  const unknown = { ...BASELINE_CONFIG, model: { name: "gpt-4o-mega", thinking_level: "medium" } };
  expect(HarnessConfigSchema.parse(unknown).model.name).toBe("anthropic/claude-sonnet-4-6");
});

test("still rejects a model with an invalid thinking_level", () => {
  const bad = { ...BASELINE_CONFIG, model: { name: "anthropic/claude-sonnet-4-6", thinking_level: "ultra" } };
  expect(() => HarnessConfigSchema.parse(bad)).toThrow();
});
