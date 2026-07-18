import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePage, EvalResultSchema } from "../src/inner/evaluate";
import type { LlmClient } from "../src/llm";

const png = (dir: string, name: string) => {
  const p = join(dir, name);
  // 1x1 png
  writeFileSync(p, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  return p;
};

const valid = {
  subscores: { hierarchy: 7, typography: 6, spacing: 7, color_contrast: 8, requirement_coverage: 9, polish: 6 },
  overall: 68, vs_reference: "behind", diff_dimensions: ["typography"], critique: "Weak type scale.",
};

test("returns parsed eval and sends capped image segments + rubric", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eval-"));
  let captured: any;
  const client: LlmClient = {
    messages: { create: async (params) => { captured = params; return { content: [{ type: "tool_use", name: "submit_evaluation", input: valid }] }; } },
  };
  const r = await evaluatePage({
    client, model: "test-model",
    prompt: { id: "p", category: "c", split: "train", prompt: "Landing page for X. Must include: hero." },
    candidate: {
      desktop: [png(dir, "d0.png"), png(dir, "d1.png")],
      mobile: [png(dir, "m0.png"), png(dir, "m1.png"), png(dir, "m2.png"), png(dir, "m3.png")], // 4 → capped to 3
    },
    referenceDesktopPngs: [png(dir, "r0.png"), png(dir, "r1.png"), png(dir, "r2.png"), png(dir, "r3.png"), png(dir, "r4.png")], // 5 → capped to 4
  });
  expect(r.overall).toBe(68);
  expect(EvalResultSchema.parse(r)).toEqual(valid as any);
  const text = JSON.stringify(captured.messages);
  expect(text).toContain("requirement_coverage");           // rubric included
  expect(text).toContain("screen 1/2");                     // segment labeling
  const images = captured.messages[0].content.filter((b: any) => b.type === "image");
  expect(images.length).toBe(2 + 3 + 4);                     // desktop + capped mobile + capped reference
});
