import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPage } from "../src/inner/build";
import { resolveHarness } from "../src/config/resolver";
import { BASELINE_CONFIG } from "../src/config/schema";

function stubPi(dir: string, script: string): string {
  const p = join(dir, "pi-stub.sh");
  writeFileSync(p, `#!/bin/bash\n${script}\n`);
  chmodSync(p, 0o755);
  return p;
}
const prompt = { id: "t1", category: "test", split: "train" as const, prompt: "Make a page" };

test("success when stub writes output.html", async () => {
  const base = mkdtempSync(join(tmpdir(), "build-"));
  const ws = join(base, "workspace");
  mkdirSync(ws, { recursive: true });
  const filler = "x".repeat(200);
  process.env.PI_BIN = stubPi(base, `echo '<html><body>hi ${filler}</body></html>' > output.html`);
  const resolved = resolveHarness(BASELINE_CONFIG, join(base, "resolved"));
  const r = await buildPage({ resolved, prompt, workspaceDir: ws });
  expect(r.ok).toBe(true);
});

test("failure when no output.html", async () => {
  const base = mkdtempSync(join(tmpdir(), "build2-"));
  const ws = join(base, "workspace");
  mkdirSync(ws, { recursive: true });
  process.env.PI_BIN = stubPi(base, `echo did nothing`);
  const resolved = resolveHarness(BASELINE_CONFIG, join(base, "resolved"));
  const r = await buildPage({ resolved, prompt, workspaceDir: ws });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("output.html");
});
