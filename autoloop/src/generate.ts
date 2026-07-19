import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Repo root (autoloop/src -> autodesign) */
const ROOT = path.resolve(import.meta.dirname, "..", "..");

const PI_TIMEOUT_MS = 9 * 60 * 1000;
const MIN_HTML_BYTES = 500;

/** Load KEY=VALUE pairs from the repo .env without overriding existing env */
function loadEnv(): void {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

/** Content hash of every file in the genome dir, order-independent of FS listing */
export function genomeHash(genomeDir: string): string {
  const hash = createHash("sha256");

  for (const f of fs.readdirSync(genomeDir).sort()) {
    hash.update(f);
    hash.update(fs.readFileSync(path.join(genomeDir, f)));
  }
  return hash.digest("hex").slice(0, 12);
}

export interface GenResult {
  ok: boolean;
  outDir: string;
  htmlPath?: string;
  error?: string;
  durationMs: number;
}

/** Generate one page: run pi with kimi-k3 in an isolated temp dir, collect index.html */
export async function generate(
  promptId: string,
  promptText: string,
  genomeDir: string,
  runsBase = path.join(ROOT, "runs"),
): Promise<GenResult> {
  loadEnv();
  const hash = genomeHash(genomeDir);
  const outDir = path.join(runsBase, hash, promptId);
  const htmlOut = path.join(outDir, "index.html");

  // Artifacts are content-addressed: never regenerate an existing (genome, prompt) identity
  if (fs.existsSync(htmlOut)) {
    return { ok: true, outDir, htmlPath: htmlOut, durationMs: 0 };
  }

  const systemFile = path.join(genomeDir, "system.md");
  const task = `${promptText}\n\nDeliverable: write the complete page to index.html in the current working directory, then stop.`;
  const started = Date.now();
  const backoffsMs = [0, 20000, 45000];
  let lastError = "unknown";

  for (let attempt = 0; attempt < backoffsMs.length; attempt++) {
    if (backoffsMs[attempt]) await new Promise((r) => setTimeout(r, backoffsMs[attempt]));

    const outcome = await attemptOnce(promptId, systemFile, task);
    if (outcome.htmlSrc) {
      const durationMs = Date.now() - started;
      fs.mkdirSync(outDir, { recursive: true });
      // Atomic publish: a killed process must never leave a truncated index.html behind
      fs.copyFileSync(outcome.htmlSrc, htmlOut + ".tmp");
      fs.renameSync(htmlOut + ".tmp", htmlOut);
      fs.writeFileSync(
        path.join(outDir, "meta.json"),
        JSON.stringify({ promptId, genome: hash, model: "kimi-k3", durationMs, attempt }, null, 2),
      );
      fs.rmSync(path.dirname(outcome.htmlSrc), { recursive: true, force: true });
      return { ok: true, outDir, htmlPath: htmlOut, durationMs };
    }
    lastError = outcome.error;
    console.error(`[${promptId}] attempt ${attempt} failed: ${lastError}`);
  }
  return { ok: false, outDir, error: lastError, durationMs: Date.now() - started };
}

async function attemptOnce(
  promptId: string,
  systemFile: string,
  task: string,
): Promise<{ htmlSrc?: string; error: string }> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autoloop-gen-"));

  const result = await new Promise<{ code: number | null; timedOut: boolean; tail: string }>((resolve) => {
    const child = spawn(
      "pi",
      [
        "--provider", "moonshotai",
        "--model", "kimi-k3",
        "-p",
        "--no-session",
        "--no-context-files",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--append-system-prompt", systemFile,
        task,
      ],
      { cwd: tmp, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );

    // Moonshot API errors surface on stdout in -p mode; keep the tail of both streams
    let tail = "";
    const keep = (d: Buffer) => (tail = (tail + d.toString()).slice(-600));
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, timedOut: true, tail });
    }, PI_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut: false, tail });
    });
  });

  const produced = path.join(tmp, "index.html");
  const fail = (error: string) => {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { error };
  };

  if (result.timedOut) return fail("timeout");
  if (!fs.existsSync(produced)) {
    return fail(`no index.html (exit ${result.code}): ${result.tail.replace(/\s+/g, " ").trim()}`);
  }
  if (fs.statSync(produced).size < MIN_HTML_BYTES) return fail("index.html too small");

  return { htmlSrc: produced, error: "" };
}

export function loadPrompts(split?: "train" | "holdout") {
  const all = JSON.parse(fs.readFileSync(path.join(ROOT, "prompts.json"), "utf8")).prompts as {
    id: string;
    split: string;
    prompt: string;
  }[];
  return split ? all.filter((p) => p.split === split) : all;
}

// CLI: tsx src/generate.ts <promptId> [genomeDir]
if (process.argv[1]?.endsWith("generate.ts")) {
  const [promptId, genomeArg] = process.argv.slice(2);
  const genomeDir = path.resolve(genomeArg ?? path.join(ROOT, "genome", "current"));
  const prompt = loadPrompts().find((p) => p.id === promptId);

  if (!prompt) {
    console.error(`Unknown prompt id: ${promptId}`);
    process.exit(1);
  }
  const res = await generate(prompt.id, prompt.prompt, genomeDir);
  console.log(JSON.stringify(res));
  process.exit(res.ok ? 0 : 1);
}
