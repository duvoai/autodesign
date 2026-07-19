import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedHarness } from "../config/resolver";
import type { PromptSpec } from "../prompts";
import type { LlmClient } from "../llm";
import type { PromptOutcome } from "../store/run-store";
import { buildPage } from "./build";
import { screenshotPage } from "./screenshot";
import { evaluatePage } from "./evaluate";

export function referenceSegments(referenceDir: string, promptId: string): string[] {
  if (!existsSync(referenceDir)) return [];
  const re = new RegExp(`^${promptId}\\.desktop\\.(\\d+)\\.png$`);
  return readdirSync(referenceDir)
    .map((f) => ({ f, m: f.match(re) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(a.m![1]) - Number(b.m![1]))
    .map((x) => join(referenceDir, x.f));
}

export async function runPromptPipeline(opts: {
  resolved: ResolvedHarness;
  prompt: PromptSpec;
  promptDir: string;
  client: LlmClient;
  evalModel: string;
  referenceDir: string;
}): Promise<PromptOutcome> {
  const { prompt, promptDir } = opts;

  const build = await buildPage({ resolved: opts.resolved, prompt, workspaceDir: join(promptDir, "workspace") });
  if (!build.ok) return { prompt_id: prompt.id, status: "build_failed", overall: 0, error: build.error };

  let shots;
  try {
    shots = await screenshotPage(build.htmlPath, promptDir);
  } catch (e) {
    return { prompt_id: prompt.id, status: "screenshot_failed", overall: 0, error: String(e) };
  }

  try {
    const refs = referenceSegments(opts.referenceDir, prompt.id);
    const evalResult = await evaluatePage({
      client: opts.client,
      model: opts.evalModel,
      prompt,
      candidate: shots,
      referenceDesktopPngs: refs,
    });
    writeFileSync(join(promptDir, "eval.json"), JSON.stringify(evalResult, null, 2));
    return { prompt_id: prompt.id, status: "ok", overall: evalResult.overall, eval: evalResult };
  } catch (e) {
    return { prompt_id: prompt.id, status: "eval_failed", overall: 0, error: String(e) };
  }
}
