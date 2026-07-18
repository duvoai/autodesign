import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReferenceSet, assertReferencesExist } from "../src/reference/build-reference";

const PAGE = `<html><body><h1>Ref</h1>${"<p>content</p>".repeat(30)}</body></html>`;

test("builds and caches reference pages, skips existing", async () => {
  const base = mkdtempSync(join(tmpdir(), "ref-"));
  const stub = join(base, "pi.sh");
  writeFileSync(stub, `#!/bin/bash\nprintf '%s' '${PAGE}' > output.html\n`);
  chmodSync(stub, 0o755);
  process.env.PI_BIN = stub;
  const refDir = join(base, "reference");
  const prompts = [{ id: "r1", category: "c", split: "train" as const, prompt: "x" }];

  const first = await buildReferenceSet({ prompts, referenceDir: refDir });
  expect(first.built).toEqual(["r1"]);
  expect(existsSync(join(refDir, "r1.desktop.0.png"))).toBe(true);
  expect(existsSync(join(refDir, "r1.html"))).toBe(true);

  const second = await buildReferenceSet({ prompts, referenceDir: refDir });
  expect(second.skipped).toEqual(["r1"]);

  expect(() => assertReferencesExist(prompts, refDir)).not.toThrow();
  expect(() => assertReferencesExist([{ id: "missing", category: "c", split: "train", prompt: "x" }], refDir)).toThrow("missing");
}, 120000);
