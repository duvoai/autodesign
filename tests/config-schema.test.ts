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

test("normalizes model object missing thinking_level", () => {
  const partial = { ...BASELINE_CONFIG, model: { name: "anthropic/claude-opus-4-8" } };
  const parsed = HarnessConfigSchema.parse(partial);
  expect(parsed.model).toEqual({ name: "anthropic/claude-opus-4-8", thinking_level: "medium" });
});

test("preserves an explicit thinking_level", () => {
  const explicit = { ...BASELINE_CONFIG, model: { name: "x", thinking_level: "high" } };
  expect(HarnessConfigSchema.parse(explicit).model).toEqual({ name: "x", thinking_level: "high" });
});

test("still rejects a model with an invalid thinking_level", () => {
  const bad = { ...BASELINE_CONFIG, model: { name: "x", thinking_level: "ultra" } };
  expect(() => HarnessConfigSchema.parse(bad)).toThrow();
});
