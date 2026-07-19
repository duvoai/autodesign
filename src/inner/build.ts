import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ResolvedHarness } from "../config/resolver";
import type { PromptSpec } from "../prompts";
import { runPiCapped } from "../util/pi";

export type BuildResult =
  | { ok: true; htmlPath: string; logPath: string }
  | { ok: false; error: string; logPath: string };

const BUILD_INSTRUCTION =
  "Build the landing page described below. Write exactly one self-contained file named output.html " +
  "in the current directory (inline CSS/JS, no external requests). Brief:\n\n";

export async function buildPage(opts: {
  resolved: ResolvedHarness;
  prompt: PromptSpec;
  workspaceDir: string;
  timeoutMs?: number;
}): Promise<BuildResult> {
  const { resolved, prompt, workspaceDir, timeoutMs = 10 * 60 * 1000 } = opts;
  const logPath = join(dirname(workspaceDir), "build.log");
  const bin = process.env.PI_BIN ?? "pi";

  const { stdout, stderr, exitCode, timedOut } = await runPiCapped(bin, [...resolved.piArgs, BUILD_INSTRUCTION + prompt.prompt], {
    cwd: workspaceDir,
    timeoutMs,
  });
  writeFileSync(logPath, `# exit ${exitCode}${timedOut ? " (timed out)" : ""}\n## stdout\n${stdout}\n## stderr\n${stderr}\n`);

  const htmlPath = join(workspaceDir, "output.html");
  if (timedOut) return { ok: false, error: "pi build timed out", logPath };
  if (exitCode !== 0) return { ok: false, error: `pi exited ${exitCode}`, logPath };
  if (!existsSync(htmlPath)) return { ok: false, error: "no output.html produced", logPath };
  const html = readFileSync(htmlPath, "utf8");
  if (html.length < 100 || !/<html/i.test(html)) {
    return { ok: false, error: "output.html invalid or too small", logPath };
  }
  return { ok: true, htmlPath, logPath };
}
