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
