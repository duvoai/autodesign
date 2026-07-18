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
