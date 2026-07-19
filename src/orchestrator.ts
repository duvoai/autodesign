import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASELINE_CONFIG, HarnessConfigSchema } from "./config/schema";
import { resolveHarness } from "./config/resolver";
import { runPromptPipeline, referenceSegments } from "./inner/pipeline";
import { aggregate } from "./outer/aggregate";
import { mutateConfig, type MutationArtifact } from "./outer/mutate";
import { pLimit } from "./util/concurrency";
import type { LlmClient } from "./llm";
import type { PromptSpec } from "./prompts";
import type { RunStore, IterationSummary } from "./store/run-store";

// Collect the artifact paths the agentic mutator inspects for one iteration.
function collectArtifacts(store: RunStore, iter: number, referenceDir: string, summary: IterationSummary): MutationArtifact[] {
  return summary.outcomes.map((o) => {
    const promptDir = store.promptDir(iter, o.prompt_id);
    // Keep the mutator's read load bounded: at most the first 4 desktop candidate segments and the
    // first 3 reference segments. Too many large PNGs slows the agentic mutation and inflates tokens.
    const candidateScreens = existsSync(promptDir)
      ? readdirSync(promptDir)
          .filter((f) => /^candidate\.desktop\.\d+\.png$/.test(f))
          .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
          .map((f) => join(promptDir, f))
          .slice(0, 4)
      : [];
    const htmlPath = join(promptDir, "workspace", "output.html");
    return {
      promptId: o.prompt_id,
      overall: o.overall,
      status: o.status,
      critique: o.eval?.critique,
      vsReference: o.eval?.vs_reference,
      htmlPath: existsSync(htmlPath) ? htmlPath : undefined,
      candidateScreens,
      referenceScreens: referenceSegments(referenceDir, o.prompt_id).slice(0, 3),
    };
  });
}

export async function runLoop(opts: {
  store: RunStore;
  prompts: PromptSpec[];
  iterations: number;
  concurrency: number;
  client: LlmClient;
  evalModel: string;
  referenceDir: string;
  startIteration?: number;
  builderModel?: string;
  mutatorModel: string;
}): Promise<void> {
  const { store, prompts, client, evalModel, referenceDir, concurrency, builderModel, mutatorModel } = opts;
  if (prompts.some((p) => p.split !== "train")) throw new Error("runLoop accepts train prompts only");

  // Optionally pin the builder model for the whole run (an experiment parameter, not something the
  // mutator controls) so the run stays on the chosen model regardless of what the mutator proposes.
  const pinModel = (c: typeof BASELINE_CONFIG) =>
    builderModel ? HarnessConfigSchema.parse({ ...c, model: { ...c.model, name: builderModel } }) : c;

  if (store.listConfigVersions().length === 0) store.saveConfig(pinModel(BASELINE_CONFIG));
  const completed = store.completedIterations();
  const start = opts.startIteration ?? (completed.length ? Math.max(...completed) + 1 : 1);

  for (let iter = start; iter < start + opts.iterations; iter++) {
    // The config to evaluate this iteration: normally the newest saved config (last mutation's
    // proposal, or baseline). But if a prior attempt at this iteration already wrote
    // config-version.txt (crashed before saveSummary), pin to that same version so a resume
    // re-evaluates the identical config rather than a newer one saved by the partial attempt.
    const iterDir = store.iterationDir(iter);
    const configVersionFile = join(iterDir, "config-version.txt");
    let configVersion: number;
    if (existsSync(configVersionFile)) {
      configVersion = Number(readFileSync(configVersionFile, "utf8"));
    } else {
      const versions = store.listConfigVersions();
      configVersion = Math.max(...versions);
      writeFileSync(configVersionFile, String(configVersion));
    }
    const config = store.loadConfig(configVersion);
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
    const alreadyRecorded = store.readHistory().some((h) => h.iteration === iter);
    if (!alreadyRecorded) {
      store.appendHistory({
        iteration: iter,
        config_version: configVersion,
        mean_overall: summary.mean_overall,
        best_version: summary.mean_overall > prevBest.score ? configVersion : prevBest.version,
        best_score: Math.max(summary.mean_overall, prevBest.score),
      });
    }

    const best = store.bestVersion();
    const bestConfig = store.loadConfig(best.version);
    const historyEntries = store.readHistory();
    const pastRationales = store.listConfigVersions().map((v) => {
      const c = store.loadConfig(v);
      const scored = historyEntries.find((h) => h.config_version === v);
      return { version: v, rationale: c.rationale, mean_overall: scored ? scored.mean_overall : null };
    });

    console.log(`[iter ${iter}] mean ${summary.mean_overall.toFixed(1)} (best v${best.version}=${best.score.toFixed(1)}) — mutating (Pi ${mutatorModel})…`);
    const next = await mutateConfig({
      mutatorModel, bestConfig, latestSummary: summary,
      history: historyEntries, pastRationales, nextVersion: store.nextConfigVersion(),
      workDir: iterDir, artifacts: collectArtifacts(store, iter, referenceDir, summary),
    });
    store.saveConfig(pinModel(next));
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
