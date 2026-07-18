import { z } from "zod";
import { readFileSync } from "node:fs";

const PromptSpecSchema = z.object({
  id: z.string().min(1),
  category: z.string().min(1),
  split: z.enum(["train", "holdout"]),
  prompt: z.string().min(1),
});
const PromptFileSchema = z.object({
  version: z.number(),
  description: z.string(),
  prompts: z.array(PromptSpecSchema).min(1),
});

export type PromptSpec = z.infer<typeof PromptSpecSchema>;

export function loadPrompts(path = "prompts.json"): PromptSpec[] {
  const file = PromptFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const ids = new Set<string>();
  for (const p of file.prompts) {
    if (ids.has(p.id)) throw new Error(`duplicate prompt id: ${p.id}`);
    ids.add(p.id);
  }
  return file.prompts;
}

export const trainPrompts = (all: PromptSpec[]) => all.filter((p) => p.split === "train");
export const holdoutPrompts = (all: PromptSpec[]) => all.filter((p) => p.split === "holdout");
