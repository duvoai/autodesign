import { parseArgs } from "node:util";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { loadPrompts, trainPrompts, holdoutPrompts } from "./prompts";
import { ALLOWED_MODELS, HarnessConfigSchema } from "./config/schema";
import { RunStore } from "./store/run-store";
import { realClient } from "./llm";
import { runLoop, runHoldout } from "./orchestrator";
import { buildReferenceSet } from "./reference/build-reference";

const RUNS_DIR = "runs";
const REFERENCE_DIR = join(RUNS_DIR, "reference");
const EVAL_MODEL = process.env.EVAL_MODEL ?? "claude-opus-4-8";
// Fable (anthropic/claude-fable-5) is gated behind workspace data-retention; default to Opus, which
// is accessible. Set MUTATOR_MODEL=anthropic/claude-fable-5 once data retention is enabled to use Fable.
const MUTATOR_MODEL = process.env.MUTATOR_MODEL ?? "anthropic/claude-opus-4-8";

const [command] = Bun.argv.slice(2);
const { values } = parseArgs({
  args: Bun.argv.slice(3),
  options: {
    iterations: { type: "string", default: "5" },
    "run-id": { type: "string" },
    concurrency: { type: "string", default: "5" },
    version: { type: "string" },
    force: { type: "boolean", default: false },
    limit: { type: "string" },
    model: { type: "string" },
    prompts: { type: "string" },
    "seed-config": { type: "string" },
  },
});

const all = loadPrompts(values.prompts);
const concurrency = Number(values.concurrency);
const limit = values.limit ? Number(values.limit) : undefined;
const builderModel = values.model;
if (builderModel && !(ALLOWED_MODELS as readonly string[]).includes(builderModel)) {
  console.error(`--model must be one of: ${ALLOWED_MODELS.join(", ")}`);
  process.exit(1);
}
const seedConfig = values["seed-config"]
  ? HarnessConfigSchema.parse(JSON.parse(readFileSync(values["seed-config"], "utf8")))
  : undefined;

async function main() {
  switch (command) {
    case "reference": {
      // Reference building remains wired up so it can be run later, but it is no longer
      // a prerequisite for loop/resume/holdout — those tolerate an empty reference dir
      // and score rubric-only (reference comparison is deferred).
      const r = await buildReferenceSet({ prompts: all, referenceDir: REFERENCE_DIR, concurrency, force: values.force });
      console.log(`built: ${r.built.length}, skipped: ${r.skipped.length}, failed: ${r.failed.length}`);
      for (const f of r.failed) console.error(`  FAILED ${f.id}: ${f.error}`);
      if (r.failed.length) process.exit(1);
      break;
    }
    case "loop":
    case "resume": {
      const runId = values["run-id"] ?? `run-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`;
      if (command === "resume" && !values["run-id"]) throw new Error("resume requires --run-id");
      const train = limit ? trainPrompts(all).slice(0, limit) : trainPrompts(all);
      const store = new RunStore(RUNS_DIR, runId);
      store.initRun({ eval_model: EVAL_MODEL, mutator_model: MUTATOR_MODEL, concurrency, prompt_count: train.length, builder_model: builderModel ?? "(baseline default)" });
      console.log(`run: ${runId} — ${train.length} train prompt(s): ${train.map((p) => p.id).join(", ")}${builderModel ? ` — builder: ${builderModel}` : ""} — mutator: ${MUTATOR_MODEL}`);
      await runLoop({
        store, prompts: train, iterations: Number(values.iterations), concurrency,
        client: realClient(), evalModel: EVAL_MODEL, referenceDir: REFERENCE_DIR,
        builderModel, mutatorModel: MUTATOR_MODEL, seedConfig,
      });
      const best = store.bestVersion();
      console.log(`done. best config: v${best.version} (mean ${best.score.toFixed(1)})`);
      break;
    }
    case "holdout": {
      if (!values["run-id"]) throw new Error("holdout requires --run-id");
      const store = new RunStore(RUNS_DIR, values["run-id"]);
      const holdout = holdoutPrompts(all);
      const version = values.version ? Number(values.version) : store.bestVersion().version;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const summary = await runHoldout({
        store, prompts: holdout, configVersion: version, concurrency,
        client: realClient(), evalModel: EVAL_MODEL, referenceDir: REFERENCE_DIR,
        outDir: join(store.root, "holdout", stamp),
      });
      console.log(`holdout mean for v${version}: ${summary.mean_overall.toFixed(1)}`);
      break;
    }
    default:
      console.error("usage: bun src/cli.ts <reference|loop|resume|holdout> [--iterations N] [--limit N] [--concurrency N] [--run-id X] [--version V]");
      process.exit(1);
  }
}
main();
