import { expect, test } from "bun:test";
import { aggregate } from "../src/outer/aggregate";
import type { PromptOutcome } from "../src/store/run-store";

const ok = (id: string, overall: number, hierarchy: number): PromptOutcome => ({
  prompt_id: id, status: "ok", overall,
  eval: {
    subscores: { hierarchy, typography: 5, spacing: 5, color_contrast: 5, requirement_coverage: 5, polish: 5 },
    overall, vs_reference: "on_par", diff_dimensions: [], critique: "c",
  },
});

test("means: failures are 0, eval_failed excluded", () => {
  const s = aggregate(3, 7, [
    ok("a", 80, 8),
    ok("b", 60, 6),
    { prompt_id: "c", status: "build_failed", overall: 0, error: "no html" },
    { prompt_id: "d", status: "eval_failed", overall: 0, error: "api" },
  ]);
  expect(s.iteration).toBe(3);
  expect(s.config_version).toBe(7);
  expect(s.mean_overall).toBeCloseTo((80 + 60 + 0) / 3);
  expect(s.dimension_means.hierarchy).toBeCloseTo(7);
});
