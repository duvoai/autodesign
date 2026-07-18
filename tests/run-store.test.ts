import { expect, test } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../src/store/run-store";
import { BASELINE_CONFIG } from "../src/config/schema";

test("full store lifecycle", () => {
  const dir = mkdtempSync(join(tmpdir(), "store-"));
  const s = new RunStore(dir, "run1");
  s.initRun({ note: "test" });
  expect(existsSync(join(dir, "run1", "run.json"))).toBe(true);

  s.saveConfig(BASELINE_CONFIG);
  expect(s.loadConfig(0)).toEqual(BASELINE_CONFIG);
  expect(s.nextConfigVersion()).toBe(1);

  const pd = s.promptDir(1, "saas-crm");
  expect(existsSync(join(pd, "workspace"))).toBe(true);

  s.saveSummary({ iteration: 1, config_version: 0, mean_overall: 55, outcomes: [], dimension_means: {} });
  s.appendHistory({ iteration: 1, config_version: 0, mean_overall: 55, best_version: 0, best_score: 55 });
  s.appendHistory({ iteration: 2, config_version: 1, mean_overall: 61, best_version: 1, best_score: 61 });
  expect(s.bestVersion()).toEqual({ version: 1, score: 61 });
  expect(s.completedIterations()).toEqual([1]);
  expect(s.readHistory().length).toBe(2);
});

test("completedIterations excludes partial iterations and sorts numerically", () => {
  const dir = mkdtempSync(join(tmpdir(), "store-"));
  const s = new RunStore(dir, "run1");
  s.initRun({ note: "test" });

  // Iteration 1: directory created but no summary.json written (partial).
  s.iterationDir(1);

  // Iterations 10 and 2 (out of lexicographic order) get summaries saved.
  s.saveSummary({ iteration: 10, config_version: 0, mean_overall: 50, outcomes: [], dimension_means: {} });
  s.saveSummary({ iteration: 2, config_version: 0, mean_overall: 60, outcomes: [], dimension_means: {} });

  expect(s.completedIterations()).toEqual([2, 10]);
});

test("bestVersion keeps the first-appended entry on ties, and falls back on empty history", () => {
  const dir = mkdtempSync(join(tmpdir(), "store-"));
  const s = new RunStore(dir, "run1");
  s.initRun({ note: "test" });

  expect(s.bestVersion()).toEqual({ version: 0, score: -1 });

  s.appendHistory({ iteration: 1, config_version: 0, mean_overall: 70, best_version: 0, best_score: 70 });
  s.appendHistory({ iteration: 2, config_version: 1, mean_overall: 70, best_version: 0, best_score: 70 });

  expect(s.bestVersion()).toEqual({ version: 0, score: 70 });
});

test("nextConfigVersion returns 0 before any config is saved", () => {
  const dir = mkdtempSync(join(tmpdir(), "store-"));
  const s = new RunStore(dir, "run1");
  s.initRun({ note: "test" });

  expect(s.nextConfigVersion()).toBe(0);

  s.saveConfig(BASELINE_CONFIG);
  expect(s.nextConfigVersion()).toBe(1);
});
