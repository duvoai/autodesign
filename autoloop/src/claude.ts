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

/** Extract the last JSON object from a model response */
export function lastJson<T>(text: string): T {
  const matches = text.match(/\{[^{}]*\}/g);
  if (!matches) throw new Error(`No JSON in response: ${text.slice(0, 200)}`);
  return JSON.parse(matches[matches.length - 1]) as T;
}
