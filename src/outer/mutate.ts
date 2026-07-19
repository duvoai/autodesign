import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { HarnessConfigSchema, type HarnessConfig } from "../config/schema";
import type { HistoryEntry, IterationSummary } from "../store/run-store";

// Per-prompt artifacts the agentic mutator can inspect for the latest iteration.
export type MutationArtifact = {
  promptId: string;
  overall: number;
  status: string;
  critique?: string;
  vsReference?: string;
  htmlPath?: string;
  candidateScreens: string[];
  referenceScreens: string[];
};

const MUTATOR_SYSTEM = `You are a harness engineer optimizing an AI coding agent ("the builder") that generates
marketing landing pages as a single self-contained output.html. Your goal: propose the NEXT builder configuration
("genome") that will score higher on the design rubric.

You may change any of: system_instructions (the builder's design guidance), skills (add / edit / remove markdown
SKILL.md documents — each has id, description, content), subagents (internal review passes the builder performs
before finishing — each has name, description, system_instructions, tools), tools, and model.thinking_level.
You may NOT change model.name (it is fixed for the run).

Make ONE focused, well-motivated change per proposal — a targeted hypothesis, not a rewrite. Prefer concrete,
teachable guidance (e.g. author a skill capturing a specific technique the pages are missing) over vague
exhortations. Ground every change in what you actually SEE in the screenshots plus the evaluator critiques and the
weakest rubric dimensions. Do not repeat past changes that did not improve the score.

Workflow:
1. Use your read tool to open the candidate screenshots and the reference screenshots (real, high-quality pages),
   and the generated output.html files, to root-cause why the pages lost points.
2. Decide on one improvement.
3. WRITE the complete next configuration as JSON to a file named exactly "next-config.json" in your current working
   directory (use your write tool). Copy every unchanged field from the current best config verbatim; include ALL
   fields required by the schema; set a specific "rationale" explaining your hypothesis. Do not print the config to
   stdout — only write the file. Do not create any other files.`;

function mutationPrompt(opts: {
  bestConfig: HarnessConfig;
  latestSummary: IterationSummary;
  history: HistoryEntry[];
  pastRationales: Array<{ version: number; rationale: string; mean_overall: number | null }>;
  artifacts: MutationArtifact[];
}): string {
  const schema = JSON.stringify(z.toJSONSchema(HarnessConfigSchema));
  const perPrompt = opts.artifacts
    .map((a) => {
      const lines = [
        `- ${a.promptId} — overall ${a.overall}, status ${a.status}${a.vsReference ? `, vs_reference ${a.vsReference}` : ""}`,
        a.critique ? `  critique: ${a.critique}` : "",
        a.htmlPath ? `  generated html: ${a.htmlPath}` : "",
        a.candidateScreens.length ? `  candidate screenshots: ${a.candidateScreens.join(", ")}` : "",
        a.referenceScreens.length ? `  reference screenshots: ${a.referenceScreens.join(", ")}` : "",
      ];
      return lines.filter(Boolean).join("\n");
    })
    .join("\n");

  return [
    `## Task`,
    `Derive the next builder config from the current best config (version ${opts.bestConfig.version}) and make ONE improvement grounded in the artifacts below. Write the result to next-config.json in your current directory.`,
    `## JSON schema for next-config.json`,
    schema,
    `## Current best config (copy unchanged fields verbatim)`,
    JSON.stringify(opts.bestConfig, null, 2),
    `## Latest iteration (config v${opts.latestSummary.config_version}, mean ${opts.latestSummary.mean_overall.toFixed(1)})`,
    `Dimension means (0-10): ${JSON.stringify(opts.latestSummary.dimension_means)}`,
    `Per-prompt results and artifact paths (open these with your read tool):\n${perPrompt || "(none)"}`,
    `## Score history`,
    opts.history
      .map((h) => `iter ${h.iteration}: v${h.config_version} → ${h.mean_overall.toFixed(1)} (best v${h.best_version}=${h.best_score.toFixed(1)})`)
      .join("\n") || "(none)",
    `## Past change rationales (do not repeat what did not help)`,
    opts.pastRationales.map((r) => `v${r.version} (${r.mean_overall ?? "unscored"}): ${r.rationale}`).join("\n") || "(none)",
    `## Now`,
    `Inspect the screenshots and HTML, then write the complete next-config.json (all fields) to your current directory. version and parent_version will be overwritten for you, so their values do not matter.`,
  ].join("\n\n");
}

export async function mutateConfig(opts: {
  mutatorModel: string;
  bestConfig: HarnessConfig;
  latestSummary: IterationSummary;
  history: HistoryEntry[];
  pastRationales: Array<{ version: number; rationale: string; mean_overall: number | null }>;
  nextVersion: number;
  workDir: string;
  artifacts: MutationArtifact[];
  timeoutMs?: number;
  maxRetries?: number;
}): Promise<HarnessConfig> {
  const { workDir, timeoutMs = 10 * 60 * 1000, maxRetries = 2 } = opts;
  const bin = process.env.PI_BIN ?? "pi";
  const outPath = join(workDir, "next-config.json");
  const sysPath = join(workDir, "mutator-system.md");
  const logPath = join(workDir, "mutate.log");
  writeFileSync(sysPath, MUTATOR_SYSTEM + "\n");
  const basePrompt = mutationPrompt(opts);

  let lastError = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (existsSync(outPath)) rmSync(outPath);
    const instruction =
      attempt === 0
        ? basePrompt
        : `${basePrompt}\n\n## Previous attempt was invalid\n${lastError}\nWrite a corrected next-config.json now.`;

    const piArgs = [
      "--print",
      "--no-session",
      "--no-extensions",
      "--no-context-files",
      "--no-prompt-templates",
      "--model", opts.mutatorModel,
      "--thinking", "high",
      "--tools", "read,write,bash",
      "--append-system-prompt", sysPath,
      instruction,
    ];
    const proc = Bun.spawn([bin, ...piArgs], { cwd: workDir, stdout: "pipe", stderr: "pipe", env: { ...process.env } });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    writeFileSync(logPath, `# attempt ${attempt} exit ${exitCode}\n## stdout\n${stdout}\n## stderr\n${stderr}\n`);

    if (!existsSync(outPath)) { lastError = "no next-config.json was written"; continue; }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(outPath, "utf8"));
    } catch (e) {
      lastError = `next-config.json is not valid JSON: ${String(e)}`;
      continue;
    }
    const parsed = HarnessConfigSchema.safeParse({
      ...(raw as Record<string, unknown>),
      version: opts.nextVersion,
      parent_version: opts.bestConfig.version,
    });
    if (parsed.success) return parsed.data;
    lastError = parsed.error.message;
  }
  throw new Error(`agentic mutateConfig failed after ${maxRetries + 1} attempts: ${lastError}`);
}
