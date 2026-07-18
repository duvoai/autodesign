import path from "node:path";
import { claudeCall, lastJson } from "./claude.js";
import type { RenderResult } from "./render.js";

export interface GateResult {
  pass: boolean;
  failures: string[];
}

/**
 * Mechanical gates over render artifacts. Semantic checks run on rendered
 * VISIBLE text (innerText), so hidden off-screen content cannot satisfy them.
 */
export async function gates(renderRes: RenderResult, promptText: string): Promise<GateResult> {
  const failures: string[] = [];

  if (!renderRes.ok) failures.push(`render failed: ${renderRes.error}`);
  if (renderRes.pageErrors.length > 0) failures.push(`page errors: ${renderRes.pageErrors[0]}`);
  if (renderRes.mobileOverflow) failures.push("horizontal overflow at mobile width");
  if (renderRes.visibleText.length < 200) failures.push("almost no visible text");

  if (failures.length > 0) return { pass: false, failures };

  const verdict = await semanticGate(renderRes.visibleText, promptText);
  if (!verdict.on_topic) failures.push("content not about the prompted product");
  if (!verdict.sections_present) failures.push(`missing sections: ${verdict.missing ?? "?"}`);

  return { pass: failures.length === 0, failures };
}

interface SemanticVerdict {
  on_topic: boolean;
  sections_present: boolean;
  missing?: string;
}

async function semanticGate(visibleText: string, promptText: string): Promise<SemanticVerdict> {
  const prompt = [
    "You are a strict checker. Below is a landing page brief, then the VISIBLE text of a rendered page.",
    "Answer with ONLY one line of JSON:",
    '{"on_topic": true|false, "sections_present": true|false, "missing": "comma-separated missing required sections, or empty"}',
    "sections_present is true only if every section the brief explicitly requires has corresponding visible text.",
    "",
    `BRIEF: ${promptText}`,
    "",
    `VISIBLE PAGE TEXT:\n${visibleText.slice(0, 6000)}`,
  ].join("\n");

  const out = await claudeCall(prompt, { model: "claude-haiku-4-5", timeoutMs: 120000 });
  return lastJson<SemanticVerdict>(out);
}

// CLI: tsx src/gates.ts <path/to/index.html> <promptId>
if (process.argv[1]?.endsWith("gates.ts")) {
  const { render } = await import("./render.js");
  const { loadPrompts } = await import("./generate.js");
  const htmlPath = path.resolve(process.argv[2]);
  const prompt = loadPrompts().find((p) => p.id === process.argv[3]);

  if (!prompt) throw new Error(`Unknown prompt id: ${process.argv[3]}`);
  const renderRes = await render(htmlPath, path.dirname(htmlPath));
  console.log(JSON.stringify(await gates(renderRes, prompt.prompt)));
}
