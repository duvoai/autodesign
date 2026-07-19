import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutateConfig, type MutationArtifact } from "../src/outer/mutate";
import { BASELINE_CONFIG } from "../src/config/schema";
import type { IterationSummary } from "../src/store/run-store";

function stubPi(dir: string, script: string): string {
  const p = join(dir, "pi-stub.sh");
  writeFileSync(p, `#!/bin/bash\n${script}\n`);
  chmodSync(p, 0o755);
  return p;
}

const SUMMARY: IterationSummary = {
  iteration: 1,
  config_version: 0,
  mean_overall: 52,
  outcomes: [
    {
      prompt_id: "saas-crm",
      status: "ok",
      overall: 52,
      eval: {
        subscores: { hierarchy: 5, typography: 4, spacing: 5, color_contrast: 4, requirement_coverage: 8, polish: 5 },
        overall: 52,
        vs_reference: "behind",
        diff_dimensions: ["typography"],
        critique: "Weak type scale.",
      },
    },
  ],
  dimension_means: { typography: 4 },
};

function baseOpts(workDir: string, artifacts: MutationArtifact[] = []) {
  return {
    mutatorModel: "anthropic/claude-fable-5",
    bestConfig: BASELINE_CONFIG,
    latestSummary: SUMMARY,
    history: [{ iteration: 1, config_version: 0, mean_overall: 52, best_version: 0, best_score: 52 }],
    pastRationales: [{ version: 0, rationale: "baseline", mean_overall: 52 }],
    nextVersion: 5,
    workDir,
    artifacts,
  };
}

test("reads pi-written next-config.json and pins version/parent_version", async () => {
  const base = mkdtempSync(join(tmpdir(), "mut-"));
  const work = join(base, "work");
  mkdirSync(work, { recursive: true });
  const cfg = JSON.stringify({ ...BASELINE_CONFIG, version: 999, parent_version: 42, rationale: "Add a typography skill." });
  process.env.PI_BIN = stubPi(base, `cat > next-config.json <<'CFGEOF'\n${cfg}\nCFGEOF`);

  const next = await mutateConfig(baseOpts(work));
  expect(next.version).toBe(5); // pinned from nextVersion
  expect(next.parent_version).toBe(0); // pinned from bestConfig.version
  expect(next.rationale).toBe("Add a typography skill.");
});

test("retries when the first attempt writes nothing, then succeeds", async () => {
  const base = mkdtempSync(join(tmpdir(), "mut2-"));
  const work = join(base, "work");
  mkdirSync(work, { recursive: true });
  const cfg = JSON.stringify({ ...BASELINE_CONFIG, rationale: "second attempt" });
  // count invocations in the cwd; only write on the 2nd+ call
  process.env.PI_BIN = stubPi(
    base,
    `n=$(cat .n 2>/dev/null || echo 0); n=$((n+1)); echo $n > .n\nif [ "$n" -ge 2 ]; then cat > next-config.json <<'CFGEOF'\n${cfg}\nCFGEOF\nfi`,
  );

  const next = await mutateConfig(baseOpts(work));
  expect(next.rationale).toBe("second attempt");
  expect(next.version).toBe(5);
});

test("throws after retries when pi never writes a valid config", async () => {
  const base = mkdtempSync(join(tmpdir(), "mut3-"));
  const work = join(base, "work");
  mkdirSync(work, { recursive: true });
  process.env.PI_BIN = stubPi(base, `echo "did nothing useful"`);

  await expect(mutateConfig({ ...baseOpts(work), maxRetries: 1 })).rejects.toThrow(/failed after 2 attempts/);
});
