export type PiResult = { stdout: string; stderr: string; exitCode: number; timedOut: boolean };

// Run a `pi` subprocess with a hard timeout that never hangs. We drain stdout/stderr concurrently
// (so a chatty child can't deadlock on a full pipe buffer) and race the whole thing against the
// timeout. On timeout we SIGKILL the child and, crucially, stop awaiting the output streams after a
// short grace — a killed `pi` can leave a grandchild holding the pipe open, which would otherwise
// make `new Response(stream).text()` hang forever.
export async function runPiCapped(bin: string, args: string[], opts: { cwd: string; timeoutMs: number }): Promise<PiResult> {
  const proc = Bun.spawn([bin, ...args], { cwd: opts.cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  const drain = Promise.all([
    new Response(proc.stdout).text().catch(() => ""),
    new Response(proc.stderr).text().catch(() => ""),
  ]);

  const completed = Promise.all([drain, proc.exited]).then(
    ([[stdout, stderr], exitCode]) => ({ stdout, stderr, exitCode, timedOut: false }) as PiResult,
  );
  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => {
      try {
        proc.kill(9);
      } catch {
        // already gone
      }
      resolve(null);
    }, opts.timeoutMs),
  );

  const raced = await Promise.race([completed, timeout]);
  if (raced) return raced;

  // Timed out and killed. Grab whatever buffered output is available, but never hang on the streams.
  const grace = new Promise<[string, string]>((r) => setTimeout(() => r(["", ""]), 2000));
  const [stdout, stderr] = await Promise.race([drain, grace]);
  return { stdout, stderr, exitCode: proc.exitCode ?? -1, timedOut: true };
}
