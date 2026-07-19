import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { forcedToolCall, imageBlock, type LlmClient } from "../llm";
import type { PromptSpec } from "../prompts";
import type { Screenshots } from "./screenshot";

const sub = z.number().min(0).max(10);
export const EvalResultSchema = z.object({
  subscores: z.object({
    hierarchy: sub, typography: sub, spacing: sub,
    color_contrast: sub, requirement_coverage: sub, polish: sub,
  }),
  overall: z.number().min(0).max(100),
  vs_reference: z.enum(["behind", "on_par", "ahead"]).optional(),
  diff_dimensions: z.array(z.string()).optional(),
  critique: z.string().min(1),
});
export type EvalResult = z.infer<typeof EvalResultSchema>;

const RUBRIC = readFileSync(join(import.meta.dir, "../eval/rubric.md"), "utf8");

const MAX_MOBILE = 3;
const MAX_REFERENCE = 4;

export async function evaluatePage(opts: {
  client: LlmClient;
  model: string;
  prompt: PromptSpec;
  candidate: Screenshots;
  referenceDesktopPngs?: string[];
}): Promise<EvalResult> {
  const refs = (opts.referenceDesktopPngs ?? []).slice(0, MAX_REFERENCE);
  const content: unknown[] = [
    { type: "text", text: `You are a strict design reviewer.\n\n${RUBRIC}\n\n## Brief\n${opts.prompt.prompt}` },
    { type: "text", text: "Screenshots are scrolled viewport segments in top-to-bottom order." },
  ];
  const desktop = opts.candidate.desktop;
  desktop.forEach((p, i) => {
    content.push({ type: "text", text: `Candidate desktop — screen ${i + 1}/${desktop.length}:` }, imageBlock(p));
  });
  const mobile = opts.candidate.mobile.slice(0, MAX_MOBILE);
  mobile.forEach((p, i) => {
    content.push({ type: "text", text: `Candidate mobile — screen ${i + 1}/${mobile.length}:` }, imageBlock(p));
  });
  if (refs.length > 0) {
    refs.forEach((p, i) => {
      content.push({ type: "text", text: `Reference page for the same brief, desktop — screen ${i + 1}/${refs.length}:` }, imageBlock(p));
    });
    content.push({ type: "text", text: "Compare the candidate against the reference page above. Score vs_reference (behind/on_par/ahead) and list diff_dimensions where they differ, in addition to the rubric subscores." });
  } else {
    content.push({ type: "text", text: "No reference page is provided for this brief. Score the candidate on the rubric alone; vs_reference and diff_dimensions may be omitted." });
  }
  content.push({ type: "text", text: "Evaluate the candidate per the rubric and call submit_evaluation." });

  return forcedToolCall(opts.client, {
    model: opts.model,
    toolName: "submit_evaluation",
    description: "Submit the structured rubric evaluation of the candidate landing page.",
    zodSchema: EvalResultSchema,
    content,
  });
}
