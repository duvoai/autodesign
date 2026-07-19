import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPiCapped } from "../src/util/pi";

function stub(dir: string, script: string): string {
  const p = join(dir, "stub.sh");
  writeFileSync(p, `#!/bin/bash\n${script}\n`);
  chmodSync(p, 0o755);
  return p;
}

test("returns output and exit code for a normal process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-"));
  const bin = stub(dir, `echo hello; echo oops 1>&2; exit 0`);
  const r = await runPiCapped(bin, [], { cwd: dir, timeoutMs: 5000 });
  expect(r.timedOut).toBe(false);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("hello");
  expect(r.stderr).toContain("oops");
});

test("propagates a non-zero exit code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi2-"));
  const bin = stub(dir, `exit 3`);
  const r = await runPiCapped(bin, [], { cwd: dir, timeoutMs: 5000 });
  expect(r.timedOut).toBe(false);
  expect(r.exitCode).toBe(3);
});

test("times out and does not hang when a grandchild keeps the pipe open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi3-"));
  // spawn a background grandchild that holds stdout open, then the parent 'exits' but the pipe stays
  // open — the classic hang. runPiCapped must still return within the timeout.
  const bin = stub(dir, `sleep 30 & echo started; wait`);
  const start = Date.now();
  const r = await runPiCapped(bin, [], { cwd: dir, timeoutMs: 1000 });
  const elapsed = Date.now() - start;
  expect(r.timedOut).toBe(true);
  expect(elapsed).toBeLessThan(8000); // returned promptly, did not hang on the open pipe
}, 15000);
