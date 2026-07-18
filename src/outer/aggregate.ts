import type { IterationSummary, PromptOutcome } from "../store/run-store";

export function aggregate(iteration: number, configVersion: number, outcomes: PromptOutcome[]): IterationSummary {
  const scored = outcomes.filter((o) => o.status !== "eval_failed");
  const mean_overall = scored.length ? scored.reduce((s, o) => s + o.overall, 0) / scored.length : 0;

  const oks = outcomes.filter((o) => o.status === "ok" && o.eval);
  const dimension_means: Record<string, number> = {};
  if (oks.length) {
    const keys = Object.keys(oks[0]!.eval!.subscores) as Array<keyof PromptOutcome["eval"] extends never ? never : any>;
    for (const k of keys) {
      dimension_means[k] = oks.reduce((s, o) => s + (o.eval!.subscores as any)[k], 0) / oks.length;
    }
  }
  return { iteration, config_version: configVersion, mean_overall, outcomes, dimension_means };
}
