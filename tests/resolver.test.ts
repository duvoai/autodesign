import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHarness } from "../src/config/resolver";
import { BASELINE_CONFIG, type HarnessConfig } from "../src/config/schema";

const cfg: HarnessConfig = {
  ...BASELINE_CONFIG,
  skills: [{ id: "visual-hierarchy", description: "Layout guidance", content: "Use a clear grid." }],
  subagents: [
    { name: "critic", description: "Design critic", system_instructions: "List 3 flaws, then fix them.", tools: ["read"] },
  ],
};

test("materializes system prompt, skills, and pi args", () => {
  const dir = mkdtempSync(join(tmpdir(), "resolve-"));
  const r = resolveHarness(cfg, dir);
  const sys = readFileSync(r.systemPromptPath, "utf8");
  expect(sys).toContain("self-contained HTML");
  expect(sys).toContain("## Internal pass: critic");
  expect(sys).toContain("List 3 flaws");
  const skill = readFileSync(join(dir, "skills", "visual-hierarchy", "SKILL.md"), "utf8");
  expect(skill).toContain("name: visual-hierarchy");
  expect(skill).toContain("Use a clear grid.");
  expect(r.piArgs).toContain("--print");
  expect(r.piArgs).toContain("anthropic/claude-sonnet-4-6");
  expect(r.piArgs.join(" ")).toContain("--skill");
});

test("deterministic: same config twice → identical bytes", () => {
  const a = mkdtempSync(join(tmpdir(), "ra-"));
  const b = mkdtempSync(join(tmpdir(), "rb-"));
  resolveHarness(cfg, a);
  resolveHarness(cfg, b);
  expect(readFileSync(join(a, "system-prompt.md"), "utf8")).toBe(readFileSync(join(b, "system-prompt.md"), "utf8"));
  expect(readdirSync(join(a, "skills")).sort()).toEqual(readdirSync(join(b, "skills")).sort());
});
