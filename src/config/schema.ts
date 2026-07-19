import { z } from "zod";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const ALLOWED_TOOLS = ["read", "write", "edit", "bash"] as const;

export const SkillSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().min(1),
  content: z.string().min(1),
});

export const SubagentSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().min(1),
  system_instructions: z.string().min(1),
  tools: z.array(z.enum(ALLOWED_TOOLS)),
});

export const ModelSchema = z.object({
  name: z.string().min(1),
  thinking_level: z.enum(THINKING_LEVELS),
});

// The mutator LLM sometimes flattens `model` to a bare string (e.g. "anthropic/claude-sonnet-4-6")
// or omits thinking_level. Normalize those into the canonical object before validation so a single
// stray shape doesn't crash a whole run. z.toJSONSchema still emits the strict object, so the tool
// schema keeps guiding the model toward the correct shape.
const ModelField = z.preprocess((v) => {
  if (typeof v === "string") return { name: v, thinking_level: "medium" };
  if (v && typeof v === "object" && !Array.isArray(v) && !("thinking_level" in (v as Record<string, unknown>))) {
    return { thinking_level: "medium", ...(v as Record<string, unknown>) };
  }
  return v;
}, ModelSchema);

export const HarnessConfigSchema = z.object({
  version: z.number().int().nonnegative(),
  parent_version: z.number().int().nonnegative().nullable(),
  rationale: z.string(),
  model: ModelField,
  tools: z.array(z.enum(ALLOWED_TOOLS)).min(1),
  system_instructions: z.string().min(1),
  skills: z.array(SkillSchema).max(8),
  subagents: z.array(SubagentSchema).max(4),
});

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

export const BASELINE_CONFIG: HarnessConfig = {
  version: 0,
  parent_version: null,
  rationale: "Hand-written baseline.",
  model: { name: "anthropic/claude-sonnet-4-6", thinking_level: "medium" },
  tools: ["read", "write", "bash"],
  system_instructions: [
    "You are building a single marketing landing page as one self-contained HTML file.",
    "Write exactly one file named output.html in the current directory.",
    "All CSS and JS must be inline; no external network requests. Use system font stacks or embedded styles.",
    "Cover every requirement in the brief. Aim for a clean, modern, visually polished design.",
  ].join("\n"),
  skills: [],
  subagents: [],
};
