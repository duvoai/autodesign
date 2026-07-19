import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoop, runHoldout } from "../src/orchestrator";
import { RunStore } from "../src/store/run-store";
import { BASELINE_CONFIG } from "../src/config/schema";
import type { LlmClient } from "../src/llm";

const PAGE = `<html><body><h1>P</h1>${"<p>c</p>".repeat(40)}</body></html>`;
const EVAL = {
  subscores: { hierarchy: 6, typography: 6, spacing: 6, color_contrast: 6, requirement_coverage: 8, polish: 5 },
  overall: 62, vs_reference: "behind", diff_dimensions: [], critique: "ok",
};

function fakeClient(): LlmClient {
  return {
    messages: {
      create: async (params: any) => {
        const isMutate = JSON.stringify(params.tools).includes("propose_config");
        if (isMutate) {
          return { content: [{ type: "tool_use", name: "propose_config", input: { ...BASELINE_CONFIG, rationale: "tweak", version: 0, parent_version: null } }] };
        }
        return { content: [{ type: "tool_use", name: "submit_evaluation", input: EVAL }] };
      },
    },
  };
}

// References are optional / deferred — no reference PNGs are written in setup.
// The loop must work reference-free: the pipeline tolerates an empty reference dir
// and scores rubric-only, so outcomes are still `ok` with the fake eval's overall score.
function setup() {
  const base = mkdtempSync(join(tmpdir(), "orch-"));
  const stub = join(base, "pi.sh");
  writeFileSync(stub, `#!/bin/bash\nprintf '%s' '${PAGE}' > output.html\n`);
  chmodSync(stub, 0o755);
  process.env.PI_BIN = stub;
  const refDir = join(base, "reference"); // exists but empty — reference-free
  mkdirSync(refDir, { recursive: true });
  const store = new RunStore(join(base, "runs"), "test-run");
  store.initRun({});
  return { base, refDir, store };
}
const P = (id: string, split: "train" | "holdout") => ({ id, category: "c", split, prompt: "make page " + id });

test("two iterations: configs, summaries, history, best tracking", async () => {
  const { refDir, store } = setup();
  await runLoop({
    store, prompts: [P("a", "train"), P("b", "train")], iterations: 2, concurrency: 2,
    client: fakeClient(), evalModel: "m", referenceDir: refDir,
  });
  expect(store.completedIterations()).toEqual([1, 2]);
  expect(store.readHistory().length).toBe(2);
  expect(store.listConfigVersions()).toEqual([0, 1, 2]);   // baseline + 2 proposals
  expect(store.bestVersion().score).toBeCloseTo(62);
  const s = store.loadSummaries()[0];
  expect(s.mutator_rationale).toBe("tweak");
  expect(existsSync(join(store.root, "iterations", "1", "config-version.txt"))).toBe(true);
}, 120000);

test("resume after mid-iteration crash does not duplicate history or re-pick config", async () => {
  const { refDir, store } = setup();
  await runLoop({
    store, prompts: [P("a", "train"), P("b", "train")], iterations: 1, concurrency: 2,
    client: fakeClient(), evalModel: "m", referenceDir: refDir,
  });

  expect(store.readHistory().length).toBe(1);
  expect(store.completedIterations()).toEqual([1]);
  const configVersionFile = join(store.root, "iterations", "1", "config-version.txt");
  const pinnedVersionBefore = readFileSync(configVersionFile, "utf8");
  expect(store.listConfigVersions()).toEqual([0, 1]);

  // Simulate a crash that happened after appendHistory/saveConfig but before saveSummary:
  // delete iteration 1's summary.json so completedIterations() no longer counts it, while
  // leaving its history row and config-version.txt in place.
  rmSync(join(store.root, "iterations", "1", "summary.json"));
  expect(store.completedIterations()).toEqual([]);

  // Resume: startIteration defaults to last-completed+1 == 1 again.
  await runLoop({
    store, prompts: [P("a", "train"), P("b", "train")], iterations: 1, concurrency: 2,
    client: fakeClient(), evalModel: "m", referenceDir: refDir,
  });

  const history = store.readHistory();
  expect(history.filter((h) => h.iteration === 1).length).toBe(1); // no duplicate row
  const pinnedVersionAfter = readFileSync(configVersionFile, "utf8");
  expect(pinnedVersionAfter).toBe(pinnedVersionBefore); // pinned to the same config version
  expect(store.completedIterations()).toEqual([1]);
}, 120000);

test("builderModel pins the model across seed and mutations", async () => {
  const { refDir, store } = setup();
  await runLoop({
    store, prompts: [P("a", "train")], iterations: 2, concurrency: 1,
    client: fakeClient(), evalModel: "m", referenceDir: refDir,
    builderModel: "anthropic/claude-haiku-4-5",
  });
  // seeded baseline (v0) and every mutated config must carry the pinned model, even though the
  // fake mutator proposes a config with the default sonnet model.
  for (const v of store.listConfigVersions()) {
    expect(store.loadConfig(v).model.name).toBe("anthropic/claude-haiku-4-5");
  }
}, 120000);

test("holdout writes report without touching history", async () => {
  const { refDir, store, base } = setup();
  await runLoop({
    store, prompts: [P("a", "train")], iterations: 1, concurrency: 1,
    client: fakeClient(), evalModel: "m", referenceDir: refDir,
  });
  const before = store.readHistory().length;
  const summary = await runHoldout({
    store, prompts: [P("h1", "holdout")], configVersion: 0, concurrency: 1,
    client: fakeClient(), evalModel: "m", referenceDir: refDir, outDir: join(base, "runs", "test-run", "holdout", "t1"),
  });
  expect(summary.mean_overall).toBeCloseTo(62);
  expect(store.readHistory().length).toBe(before);          // unchanged
}, 120000);
