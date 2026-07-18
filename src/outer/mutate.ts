import { forcedToolCall, type LlmClient } from "../llm";
import { HarnessConfigSchema, type HarnessConfig } from "../config/schema";
import type { HistoryEntry, IterationSummary } from "../store/run-store";

const MUTATOR_SYSTEM = `You are a harness engineer optimizing an AI coding agent's configuration so it produces
better-designed landing pages. You may change: system_instructions, skills (add/edit/remove markdown skill
documents), subagents (internal review passes), tools, model thinking_level. Make ONE focused, well-motivated
change per proposal — a targeted hypothesis, not a rewrite. Ground it in the evaluation critiques and the
weakest rubric dimensions. Avoid repeating past changes that did not improve the score.`;

export async function mutateConfig(opts: {
  client: LlmClient;
  model: string;
  bestConfig: HarnessConfig;
  latestSummary: IterationSummary;
  history: HistoryEntry[];
  pastRationales: Array<{ version: number; rationale: string; mean_overall: number | null }>;
  nextVersion: number;
}): Promise<HarnessConfig> {
  const critiques = opts.latestSummary.outcomes
    .filter((o) => o.eval)
    .map((o) => `- ${o.prompt_id} (${o.overall}, ${o.eval!.vs_reference}): ${o.eval!.critique}`)
    .join("\n");
  const failures = opts.latestSummary.outcomes
    .filter((o) => o.status !== "ok")
    .map((o) => `- ${o.prompt_id}: ${o.status} ${o.error ?? ""}`)
    .join("\n");

  const proposal = await forcedToolCall(opts.client, {
    model: opts.model,
    system: MUTATOR_SYSTEM,
    toolName: "propose_config",
    description: "Propose the complete next harness configuration.",
    zodSchema: HarnessConfigSchema,
    maxTokens: 16384,
    content: [
      {
        type: "text",
        text: [
          `## Current best config (version ${opts.bestConfig.version}, derive your proposal from this)`,
          JSON.stringify(opts.bestConfig, null, 2),
          `## Latest iteration summary (config v${opts.latestSummary.config_version}, mean ${opts.latestSummary.mean_overall.toFixed(1)})`,
          `Dimension means: ${JSON.stringify(opts.latestSummary.dimension_means)}`,
          `Per-prompt critiques:\n${critiques || "(none)"}`,
          failures ? `Failures:\n${failures}` : "",
          `## Score history`,
          opts.history.map((h) => `iter ${h.iteration}: v${h.config_version} → ${h.mean_overall.toFixed(1)} (best v${h.best_version}=${h.best_score.toFixed(1)})`).join("\n"),
          `## Past change rationales`,
          opts.pastRationales.map((r) => `v${r.version} (${r.mean_overall ?? "unscored"}): ${r.rationale}`).join("\n"),
          `Propose the next config now. Include a specific rationale explaining the hypothesis.`,
        ].filter(Boolean).join("\n\n"),
      },
    ],
  });

  return HarnessConfigSchema.parse({
    ...proposal,
    version: opts.nextVersion,
    parent_version: opts.bestConfig.version,
  });
}
