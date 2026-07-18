import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { BASELINE_CONFIG, type HarnessConfig } from "../config/schema";
import { resolveHarness } from "../config/resolver";
import { buildPage } from "../inner/build";
import { screenshotPage } from "../inner/screenshot";
import { pLimit } from "../util/concurrency";
import type { PromptSpec } from "../prompts";

export const REFERENCE_CONFIG: HarnessConfig = {
  ...BASELINE_CONFIG,
  rationale: "Fixed reference harness — not part of the search space.",
  model: { name: "anthropic/claude-opus-4-8", thinking_level: "high" },
  system_instructions: [
    BASELINE_CONFIG.system_instructions,
    "You are the reference standard: produce the best landing page you possibly can.",
    "Invest in typography (real type scale), a cohesive palette, generous consistent spacing,",
    "distinctive hero treatment, and polished components. Take your time; quality over speed.",
  ].join("\n"),
};

export async function buildReferenceSet(opts: {
  prompts: PromptSpec[];
  referenceDir: string;
  concurrency?: number;
  force?: boolean;
}): Promise<{ built: string[]; skipped: string[]; failed: Array<{ id: string; error: string }> }> {
  const { prompts, referenceDir, concurrency = 3, force = false } = opts;
  mkdirSync(referenceDir, { recursive: true });
  const resolved = resolveHarness(REFERENCE_CONFIG, join(referenceDir, ".work", "resolved"));
  const limit = pLimit(concurrency);
  const built: string[] = [], skipped: string[] = [], failed: Array<{ id: string; error: string }> = [];

  await Promise.all(
    prompts.map((prompt) =>
      limit(async () => {
        if (!force && existsSync(join(referenceDir, `${prompt.id}.desktop.0.png`))) {
          skipped.push(prompt.id);
          return;
        }
        const ws = join(referenceDir, ".work", prompt.id, "workspace");
        mkdirSync(ws, { recursive: true });
        const r = await buildPage({ resolved, prompt, workspaceDir: ws });
        if (!r.ok) { failed.push({ id: prompt.id, error: r.error }); return; }
        try {
          await screenshotPage(r.htmlPath, referenceDir, prompt.id);
          copyFileSync(r.htmlPath, join(referenceDir, `${prompt.id}.html`));
          built.push(prompt.id);
        } catch (e) {
          failed.push({ id: prompt.id, error: String(e) });
        }
      }),
    ),
  );
  return { built, skipped, failed };
}

export function assertReferencesExist(prompts: PromptSpec[], referenceDir: string): void {
  const missing = prompts.filter((p) => !existsSync(join(referenceDir, `${p.id}.desktop.0.png`))).map((p) => p.id);
  if (missing.length) throw new Error(`missing reference screenshots: ${missing.join(", ")} — run \`bun run reference\` first`);
}
