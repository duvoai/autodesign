import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessConfigSchema, type HarnessConfig } from "../config/schema";
import type { EvalResult } from "../inner/evaluate";

export type HistoryEntry = {
  iteration: number; config_version: number; mean_overall: number; best_version: number; best_score: number;
};
export type PromptOutcome = {
  prompt_id: string;
  status: "ok" | "build_failed" | "screenshot_failed" | "eval_failed";
  overall: number;
  eval?: EvalResult;
  error?: string;
};
export type IterationSummary = {
  iteration: number; config_version: number; mean_overall: number;
  outcomes: PromptOutcome[]; dimension_means: Record<string, number>; mutator_rationale?: string;
};

export class RunStore {
  readonly root: string;
  constructor(runsDir: string, runId: string) {
    this.root = join(runsDir, runId);
  }
  initRun(meta: Record<string, unknown>): void {
    mkdirSync(join(this.root, "configs"), { recursive: true });
    mkdirSync(join(this.root, "iterations"), { recursive: true });
    if (!existsSync(join(this.root, "run.json"))) {
      writeFileSync(join(this.root, "run.json"), JSON.stringify({ started_at: new Date().toISOString(), ...meta }, null, 2));
    }
  }
  saveConfig(cfg: HarnessConfig): void {
    writeFileSync(join(this.root, "configs", `v${cfg.version}.json`), JSON.stringify(cfg, null, 2));
  }
  loadConfig(version: number): HarnessConfig {
    return HarnessConfigSchema.parse(JSON.parse(readFileSync(join(this.root, "configs", `v${version}.json`), "utf8")));
  }
  listConfigVersions(): number[] {
    return readdirSync(join(this.root, "configs"))
      .map((f) => Number(f.match(/^v(\d+)\.json$/)?.[1]))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
  }
  nextConfigVersion(): number {
    const vs = this.listConfigVersions();
    return vs.length ? Math.max(...vs) + 1 : 0;
  }
  iterationDir(n: number): string {
    const d = join(this.root, "iterations", String(n));
    mkdirSync(d, { recursive: true });
    return d;
  }
  promptDir(n: number, promptId: string): string {
    const d = join(this.iterationDir(n), "prompts", promptId);
    mkdirSync(join(d, "workspace"), { recursive: true });
    return d;
  }
  saveSummary(s: IterationSummary): void {
    writeFileSync(join(this.iterationDir(s.iteration), "summary.json"), JSON.stringify(s, null, 2));
  }
  loadSummaries(): IterationSummary[] {
    return this.completedIterations().map((n) =>
      JSON.parse(readFileSync(join(this.root, "iterations", String(n), "summary.json"), "utf8")),
    );
  }
  appendHistory(e: HistoryEntry): void {
    appendFileSync(join(this.root, "history.jsonl"), JSON.stringify(e) + "\n");
  }
  readHistory(): HistoryEntry[] {
    const p = join(this.root, "history.jsonl");
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  bestVersion(): { version: number; score: number } {
    const h = this.readHistory();
    if (!h.length) return { version: 0, score: -1 };
    const best = h.reduce((a, b) => (b.mean_overall > a.mean_overall ? b : a));
    return { version: best.config_version, score: best.mean_overall };
  }
  completedIterations(): number[] {
    const dir = join(this.root, "iterations");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map(Number)
      .filter((n) => Number.isFinite(n) && existsSync(join(dir, String(n), "summary.json")))
      .sort((a, b) => a - b);
  }
}
