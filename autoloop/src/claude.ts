import { execFile } from "node:child_process";

/**
 * Run a headless Claude Code call on subscription auth.
 * ANTHROPIC_BASE_URL is stripped so the desktop app's env can't redirect the CLI.
 */
export function claudeCall(
  prompt: string,
  opts: { model: string; allowRead?: boolean; timeoutMs?: number },
): Promise<string> {
  const args = ["-p", "--model", opts.model];
  if (opts.allowRead) args.push("--allowedTools", "Read");

  const env = { ...process.env };
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  return new Promise((resolve, reject) => {
    const child = execFile(
      "claude",
      args,
      { env, timeout: opts.timeoutMs ?? 180000, maxBuffer: 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
    );
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

/**
 * Extract a JSON object from a model response. Handles nested braces
 * (e.g. CSS in string fields) by trying progressively wider parses.
 */
export function lastJson<T>(text: string): T {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed) as T;
  } catch { /* not a bare JSON body */ }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1)) as T;
    } catch { /* fall through to flat-object scan */ }
  }

  const matches = trimmed.match(/\{[^{}]*\}/g);
  if (!matches) throw new Error(`No JSON in response: ${trimmed.slice(0, 200)}`);
  return JSON.parse(matches[matches.length - 1]) as T;
}
