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

// Builder model must be a string `pi` actually accepts. Only allowlisted names are permitted; the
// mutator cannot invent model ids. Extend this list once other `pi` model strings are verified to build.
export const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";
// Verified against `pi --list-models` — these exact strings resolve for the builder subprocess.
export const ALLOWED_MODELS = [
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-haiku-4-5",
  "anthropic/claude-opus-4-8",
] as const;

export const ModelSchema = z.object({
  name: z.enum(ALLOWED_MODELS),
  thinking_level: z.enum(THINKING_LEVELS),
});

// The mutator LLM misbehaves in two observed ways: (1) it flattens `model` to a bare string or omits
// thinking_level; (2) it leaks tool-call markup into the value, e.g. `\n<parameter name="name">anthropic/...`,
// which `pi` then rejects as an unknown model and every build fails. Normalize before validation: strip any
// embedded markup/whitespace, keep the name only if it is allowlisted, otherwise fall back to DEFAULT_MODEL,
// and default a missing thinking_level to medium. This keeps one stray shape from crashing or wedging a run.
const cleanModelName = (n: unknown): (typeof ALLOWED_MODELS)[number] => {
  const s = typeof n === "string" ? n.replace(/<[^>]*>/g, "").trim() : "";
  return (ALLOWED_MODELS as readonly string[]).includes(s) ? (s as (typeof ALLOWED_MODELS)[number]) : DEFAULT_MODEL;
};

const ModelField = z.preprocess((v) => {
  const obj =
    typeof v === "string"
      ? { name: v }
      : v && typeof v === "object" && !Array.isArray(v)
        ? { ...(v as Record<string, unknown>) }
        : {};
  return {
    name: cleanModelName((obj as Record<string, unknown>).name),
    thinking_level: "thinking_level" in obj ? (obj as Record<string, unknown>).thinking_level : "medium",
  };
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
