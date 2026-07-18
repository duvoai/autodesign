import { expect, test } from "bun:test";
import { loadPrompts, trainPrompts, holdoutPrompts } from "../src/prompts";

test("loads real prompts.json with valid splits", () => {
  const all = loadPrompts();
  expect(all.length).toBeGreaterThan(10);
  const train = trainPrompts(all);
  const holdout = holdoutPrompts(all);
  expect(train.length + holdout.length).toBe(all.length);
  expect(holdout.every((p) => p.split === "holdout")).toBe(true);
  expect(new Set(all.map((p) => p.id)).size).toBe(all.length);
});
