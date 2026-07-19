import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPromptPipeline, referenceSegments } from "../src/inner/pipeline";
import { pLimit } from "../src/util/concurrency";
import { resolveHarness } from "../src/config/resolver";
import { BASELINE_CONFIG } from "../src/config/schema";
import type { LlmClient } from "../src/llm";

const PAGE = `<html><body><h1>Test page</h1>${"<p>content</p>".repeat(30)}</body></html>`;
const EVAL = {
  subscores: { hierarchy: 6, typography: 6, spacing: 6, color_contrast: 6, requirement_coverage: 8, polish: 5 },
  overall: 62, vs_reference: "behind", diff_dimensions: [], critique: "fine",
};

function setup() {
  const base = mkdtempSync(join(tmpdir(), "pipe-"));
  const stub = join(base, "pi.sh");
  writeFileSync(stub, `#!/bin/bash\ncat > /dev/null <<'EOF'\nEOF\nprintf '%s' '${PAGE}' > output.html\n`);
  chmodSync(stub, 0o755);
  process.env.PI_BIN = stub;
  const refDir = join(base, "reference");
  mkdirSync(refDir, { recursive: true });
  const png1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  writeFileSync(join(refDir, "t1.desktop.0.png"), png1);
  writeFileSync(join(refDir, "t1.desktop.1.png"), png1);
  const promptDir = join(base, "p", "t1");
  mkdirSync(join(promptDir, "workspace"), { recursive: true });
  const client: LlmClient = { messages: { create: async () => ({ content: [{ type: "tool_use", name: "submit_evaluation", input: EVAL }] }) } };
  return { base, refDir, promptDir, client };
}

test("happy path produces ok outcome with eval.json", async () => {
  const { refDir, promptDir, client } = setup();
  const resolved = resolveHarness(BASELINE_CONFIG, join(promptDir, "resolved"));
  const out = await runPromptPipeline({
    resolved, prompt: { id: "t1", category: "c", split: "train", prompt: "x" },
    promptDir, client, evalModel: "m", referenceDir: refDir,
  });
  expect(out.status).toBe("ok");
  expect(out.overall).toBe(62);
}, 60000);

test("reference-free path: no reference segments still produces ok outcome", async () => {
  const { refDir, promptDir, client } = setup();
  const resolved = resolveHarness(BASELINE_CONFIG, join(promptDir, "resolved"));
  const out = await runPromptPipeline({
    resolved, prompt: { id: "no-such-prompt", category: "c", split: "train", prompt: "x" },
    promptDir, client, evalModel: "m", referenceDir: refDir,
  });
  expect(out.status).toBe("ok");
  expect(out.overall).toBe(62);
  expect(existsSync(join(promptDir, "eval.json"))).toBe(true);
}, 60000);

test("missing reference dir: referenceSegments returns [] without throwing", () => {
  const { base } = setup();
  expect(referenceSegments(join(base, "nope"), "x")).toEqual([]);
});

test("missing reference dir: runPromptPipeline still produces ok outcome", async () => {
  const { base, promptDir, client } = setup();
  const resolved = resolveHarness(BASELINE_CONFIG, join(promptDir, "resolved"));
  const missingRefDir = join(base, "does-not-exist");
  expect(existsSync(missingRefDir)).toBe(false);
  const out = await runPromptPipeline({
    resolved, prompt: { id: "t1", category: "c", split: "train", prompt: "x" },
    promptDir, client, evalModel: "m", referenceDir: missingRefDir,
  });
  expect(out.status).toBe("ok");
  expect(out.overall).toBe(62);
  expect(existsSync(join(promptDir, "eval.json"))).toBe(true);
}, 60000);

test("pLimit caps concurrency", async () => {
  const limit = pLimit(2);
  let active = 0, peak = 0;
  await Promise.all(
    Array.from({ length: 6 }, () =>
      limit(async () => {
        active++; peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
      }),
    ),
  );
  expect(peak).toBeLessThanOrEqual(2);
});
