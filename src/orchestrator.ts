import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASELINE_CONFIG } from "./config/schema";
import { resolveHarness } from "./config/resolver";
import { runPromptPipeline } from "./inner/pipeline";
import { aggregate } from "./outer/aggregate";
import { mutateConfig } from "./outer/mutate";
import { pLimit } from "./util/concurrency";
import type { LlmClient } from "./llm";
import type { PromptSpec } from "./prompts";
import type { RunStore, IterationSummary } from "./store/run-store";

export async function runLoop(opts: {
  store: RunStore;
  prompts: PromptSpec[];
  iterations: number;
  concurrency: number;
  client: LlmClient;
  evalModel: string;
  referenceDir: string;
  startIteration?: number;
}): Promise<void> {
  const { store, prompts, client, evalModel, referenceDir, concurrency } = opts;
  if (prompts.some((p) => p.split !== "train")) throw new Error("runLoop accepts train prompts only");

  if (store.listConfigVersions().length === 0) store.saveConfig(BASELINE_CONFIG);
  const completed = store.completedIterations();
  const start = opts.startIteration ?? (completed.length ? Math.max(...completed) + 1 : 1);

  for (let iter = start; iter < start + opts.iterations; iter++) {
    // The config to evaluate this iteration: the newest saved config (last mutation's proposal, or baseline).
    const versions = store.listConfigVersions();
    const configVersion = Math.max(...versions);
    const config = store.loadConfig(configVersion);

    const iterDir = store.iterationDir(iter);
    writeFileSync(join(iterDir, "config-version.txt"), String(configVersion));
    const resolved = resolveHarness(config, join(iterDir, "resolved"));

    console.log(`[iter ${iter}] config v${configVersion} — building ${prompts.length} prompts…`);
    const limit = pLimit(concurrency);
    const outcomes = await Promise.all(
      prompts.map((prompt) =>
        limit(() =>
          runPromptPipeline({
            resolved, prompt, promptDir: store.promptDir(iter, prompt.id),
            client, evalModel, referenceDir,
          }).then((o) => { console.log(`[iter ${iter}] ${prompt.id}: ${o.status} ${o.overall}`); return o; }),
        ),
      ),
    );

    const summary = aggregate(iter, configVersion, outcomes);
    const prevBest = store.bestVersion();
    store.appendHistory({
      iteration: iter,
      config_version: configVersion,
      mean_overall: summary.mean_overall,
      best_version: summary.mean_overall > prevBest.score ? configVersion : prevBest.version,
      best_score: Math.max(summary.mean_overall, prevBest.score),
    });

    const best = store.bestVersion();
    const bestConfig = store.loadConfig(best.version);
    const historyEntries = store.readHistory();
    const pastRationales = store.listConfigVersions().map((v) => {
      const c = store.loadConfig(v);
      const scored = historyEntries.find((h) => h.config_version === v);
      return { version: v, rationale: c.rationale, mean_overall: scored ? scored.mean_overall : null };
    });

    console.log(`[iter ${iter}] mean ${summary.mean_overall.toFixed(1)} (best v${best.version}=${best.score.toFixed(1)}) — mutating…`);
    const next = await mutateConfig({
      client, model: evalModel, bestConfig, latestSummary: summary,
      history: historyEntries, pastRationales, nextVersion: store.nextConfigVersion(),
    });
    store.saveConfig(next);
    summary.mutator_rationale = next.rationale;
    store.saveSummary(summary);
  }
}

export async function runHoldout(opts: {
  store: RunStore;
  prompts: PromptSpec[];
  configVersion: number;
  concurrency: number;
  client: LlmClient;
  evalModel: string;
  referenceDir: string;
  outDir: string;
}): Promise<IterationSummary> {
  const config = opts.store.loadConfig(opts.configVersion);
  mkdirSync(opts.outDir, { recursive: true });
  const resolved = resolveHarness(config, join(opts.outDir, "resolved"));
  const limit = pLimit(opts.concurrency);
  const outcomes = await Promise.all(
    opts.prompts.map((prompt) =>
      limit(() => {
        const promptDir = join(opts.outDir, "prompts", prompt.id);
        mkdirSync(join(promptDir, "workspace"), { recursive: true });
        return runPromptPipeline({
          resolved, prompt, promptDir,
          client: opts.client, evalModel: opts.evalModel, referenceDir: opts.referenceDir,
        });
      }),
    ),
  );
  const summary = aggregate(0, opts.configVersion, outcomes);
  writeFileSync(join(opts.outDir, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}
