import fs from "node:fs";
import path from "node:path";
import { generate, genomeHash, loadPrompts } from "./generate.js";
import { render } from "./render.js";
import { mechanicalGates, semanticGate } from "./gates.js";
import { judgePair } from "./judge.js";
import { claudeCall, lastJson } from "./claude.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

/** Experiment namespace: override via env to run parallel experiments (e.g. a different generator model) */
const GENOME_CURRENT = process.env.GENOME_DIR ? path.resolve(process.env.GENOME_DIR) : path.join(ROOT, "genome", "current");
const RUNS = process.env.RUNS_DIR ? path.resolve(process.env.RUNS_DIR) : path.join(ROOT, "runs");
const LOG = path.join(RUNS, "log.jsonl");
const MODEL = process.env.GEN_MODEL ?? "kimi-k3";

const SCREEN_SIZE = 5;
const CONFIRM_SIZE = 5;
const WIN_THRESHOLD = 4;
const MIN_DECISIVE = 3;
const GEN_CONCURRENCY = Number(process.env.GEN_CONCURRENCY ?? 2);

interface PromptEntry { id: string; prompt: string }

type PageOutcome =
  | { status: "ok"; shot: string }
  | { status: "gen_fail" | "render_fail" | "gate_fail"; detail: string };

/** Run fn over items with at most `limit` in flight */
async function pooled<T>(items: T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) await fn(queue.shift()!);
    }),
  );
}

function log(entry: Record<string, unknown>): void {
  fs.mkdirSync(RUNS, { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

function readLog(): Record<string, any>[] {
  if (!fs.existsSync(LOG)) return [];
  const events: Record<string, any>[] = [];

  // Tolerate a truncated final line from a killed process
  for (const line of fs.readFileSync(LOG, "utf8").trim().split("\n")) {
    try {
      events.push(JSON.parse(line));
    } catch {
      console.error(`skipping unparseable log line: ${line.slice(0, 80)}`);
    }
  }
  return events;
}

/**
 * Generate + render + gate one page. Mechanical gates always run against the
 * current render; only the semantic verdict is cached with the artifact.
 */
async function preparePage(p: PromptEntry, genomeDir: string, runsBase: string): Promise<PageOutcome> {
  const gen = await generate(p.id, p.prompt, genomeDir, runsBase, MODEL);
  if (!gen.ok || !gen.htmlPath) return { status: "gen_fail", detail: gen.error ?? "?" };

  const renderRes = await render(gen.htmlPath, gen.outDir);
  if (!renderRes.ok) return { status: "render_fail", detail: renderRes.error ?? "?" };

  const failures = mechanicalGates(renderRes);
  if (failures.length === 0) {
    const semPath = path.join(gen.outDir, "semantic.json");
    let verdict;
    if (fs.existsSync(semPath)) {
      verdict = JSON.parse(fs.readFileSync(semPath, "utf8"));
    } else {
      verdict = await semanticGate(renderRes.visibleText, p.prompt);
      fs.writeFileSync(semPath, JSON.stringify(verdict));
    }
    if (!verdict.on_topic) failures.push("content not about the prompted product");
    if (!verdict.sections_present) failures.push(`missing sections: ${verdict.missing || "?"}`);
  }

  if (failures.length > 0) {
    log({ event: "gate_fail", prompt: p.id, genome: path.basename(path.dirname(gen.outDir)), failures });
    return { status: "gate_fail", detail: failures.join("; ") };
  }
  return { status: "ok", shot: renderRes.desktopShot };
}

interface StageOutcome {
  wins: number;
  decisive: number;
  candidateFailures: number;
  results: Record<string, string>;
}

/**
 * One judged stage: candidate vs incumbent on the given prompts.
 * `runsBase` controls artifact identity: confirm passes a per-proposal dir so
 * BOTH genomes generate fresh pages (symmetric generation luck).
 */
async function stage(
  name: string,
  prompts: PromptEntry[],
  candDir: string,
  incDir: string,
  runsBase = RUNS,
): Promise<StageOutcome> {
  let wins = 0;
  let decisive = 0;
  let candidateFailures = 0;
  const results: Record<string, string> = {};

  await pooled(prompts, GEN_CONCURRENCY, (p) => generate(p.id, p.prompt, candDir, runsBase, MODEL));
  await pooled(prompts, GEN_CONCURRENCY, (p) => generate(p.id, p.prompt, incDir, runsBase, MODEL));

  for (const p of prompts) {
    const cand = await preparePage(p, candDir, runsBase);
    if (cand.status !== "ok") {
      results[p.id] = `loss(${cand.status})`;
      candidateFailures++;
      decisive++;
      continue;
    }
    const inc = await preparePage(p, incDir, runsBase);
    if (inc.status !== "ok") {
      results[p.id] = `win(incumbent-${inc.status})`;
      wins++;
      decisive++;
      continue;
    }
    const { verdict, raw, errored } = await judgePair(p.prompt, cand.shot, inc.shot);
    results[p.id] = errored ? `${verdict}(judge-error)` : verdict;
    log({ event: "judged", stage: name, prompt: p.id, verdict, raw, errored });
    if (verdict !== "tie") decisive++;
    if (verdict === "candidate") wins++;
  }

  log({
    event: name,
    candidate: genomeHash(candDir),
    incumbent: genomeHash(incDir),
    wins,
    decisive,
    candidateFailures,
    results,
  });
  return { wins, decisive, candidateFailures, results };
}

/** Ask the proposer for one mutation to system.md; returns the new full file content */
async function propose(history: string[]): Promise<{ rationale: string; system_md: string }> {
  const current = fs.readFileSync(path.join(GENOME_CURRENT, "system.md"), "utf8");
  const prompt = [
    "You are evolving the system prompt of a landing-page-generating coding agent (the 'genome').",
    "Propose ONE focused mutation: add, sharpen, replace, or remove a small number of design rules.",
    "Good mutations are concrete and visual (typography scale, spacing system, color strategy, contrast rules, hero composition, section rhythm). Avoid vague advice.",
    `The generator model is ${MODEL} producing a single self-contained index.html; keep all existing hard constraints (self-contained, no external assets, include required sections).`,
    "The pages are screened on mobile too: rules that prevent horizontal overflow at 390px width have historically converted directly into wins.",
    "",
    "CURRENT GENOME (system.md):",
    "---",
    current,
    "---",
    "",
    "ACCEPT/REJECT HISTORY (most recent last):",
    history.length ? history.join("\n") : "(none yet)",
    "",
    "Respond with ONLY one JSON object:",
    '{"rationale": "one sentence", "system_md": "the complete new system.md content"}',
  ].join("\n");

  const out = await claudeCall(prompt, { model: "claude-fable-5", timeoutMs: 300000 });
  const v = lastJson<Record<string, unknown>>(out);

  if (typeof v.rationale !== "string" || typeof v.system_md !== "string" || v.system_md.length < 100) {
    throw new Error(`proposer returned invalid shape: ${JSON.stringify(v).slice(0, 200)}`);
  }
  return { rationale: v.rationale, system_md: v.system_md };
}

/** Rebuild proposer history from the persistent log so new runs learn from prior verdicts */
function seedHistory(events: Record<string, any>[]): string[] {
  const rationales = new Map(
    events.filter((e) => e.event === "propose").map((e) => [e.candidate, e.rationale]),
  );
  const invalidated = new Set(events.filter((e) => e.event === "invalidate").map((e) => e.candidate));
  const history: string[] = [];

  for (const e of events) {
    if (invalidated.has(e.candidate)) continue;
    if (e.event === "screen" && e.wins < WIN_THRESHOLD) {
      history.push(`REJECTED(screen ${e.wins}/${SCREEN_SIZE}): ${rationales.get(e.candidate) ?? "?"}`);
    } else if (e.event === "confirm" && e.wins < WIN_THRESHOLD) {
      history.push(`REJECTED(confirm ${e.wins}/${CONFIRM_SIZE}): ${rationales.get(e.candidate) ?? "?"}`);
    } else if (e.event === "accept") {
      history.push(`ACCEPTED(${e.genome}): ${e.rationale}`);
    }
  }
  return history;
}

/** Split train prompts into disjoint screen/confirm sets, rotated by global iteration count */
function pickPrompts(iteration: number): { screen: PromptEntry[]; confirm: PromptEntry[] } {
  const train = loadPrompts("train");
  const offset = iteration % train.length;
  const rotated = [...train.slice(offset), ...train.slice(0, offset)];
  return { screen: rotated.slice(0, SCREEN_SIZE), confirm: rotated.slice(SCREEN_SIZE, SCREEN_SIZE + CONFIRM_SIZE) };
}

/** Accept-record first, then swap directories with the smallest possible failure window */
function promote(candDir: string, iteration: number, rationale: string): string {
  const promotedHash = genomeHash(candDir);
  log({ event: "accept", iteration, genome: promotedHash, rationale });

  const next = GENOME_CURRENT + ".next";
  fs.rmSync(next, { recursive: true, force: true });
  fs.cpSync(candDir, next, { recursive: true });
  fs.rmSync(GENOME_CURRENT, { recursive: true, force: true });
  fs.renameSync(next, GENOME_CURRENT);
  fs.rmSync(candDir, { recursive: true, force: true });
  return promotedHash;
}

async function main(): Promise<void> {
  const maxIterations = Number(process.argv[2] ?? 10);
  const priorEvents = readLog();
  const history = seedHistory(priorEvents);
  // Global iteration counter survives restarts so prompt rotation keeps advancing
  const iterationOffset = priorEvents.filter((e) => e.event === "propose").length;
  if (history.length) console.log(`seeded ${history.length} history entries, iteration offset ${iterationOffset}`);

  for (let i = 0; i < maxIterations; i++) {
    const globalIter = iterationOffset + i;
    console.log(`\n=== iteration ${globalIter} (incumbent ${genomeHash(GENOME_CURRENT)}, model ${MODEL}) ===`);
    const candDir = path.join(path.dirname(GENOME_CURRENT), `candidate-${Date.now()}`);

    try {
      const proposal = await propose(history);
      fs.mkdirSync(candDir, { recursive: true });
      fs.writeFileSync(path.join(candDir, "system.md"), proposal.system_md);

      if (genomeHash(candDir) === genomeHash(GENOME_CURRENT)) {
        log({ event: "noop_proposal", iteration: globalIter, rationale: proposal.rationale });
        history.push(`INVALID(no-op, genome unchanged): ${proposal.rationale}`);
        continue;
      }
      log({ event: "propose", iteration: globalIter, candidate: genomeHash(candDir), rationale: proposal.rationale });
      console.log(`proposal: ${proposal.rationale}`);

      const { screen, confirm } = pickPrompts(globalIter);

      const s = await stage("screen", screen, candDir, GENOME_CURRENT);
      console.log(`screen: ${s.wins}/${SCREEN_SIZE} wins, ${s.decisive} decisive`, s.results);
      if (s.wins < WIN_THRESHOLD || s.decisive < MIN_DECISIVE) {
        history.push(`REJECTED(screen ${s.wins}/${SCREEN_SIZE}): ${proposal.rationale}`);
        continue;
      }

      // Confirm: fresh generations for BOTH genomes under a per-proposal artifact namespace
      const confirmBase = path.join(RUNS, `confirm-${genomeHash(candDir)}`);
      const c = await stage("confirm", confirm, candDir, GENOME_CURRENT, confirmBase);
      console.log(`confirm: ${c.wins}/${CONFIRM_SIZE} wins, ${c.decisive} decisive, ${c.candidateFailures} cand failures`, c.results);
      if (c.wins < WIN_THRESHOLD || c.decisive < MIN_DECISIVE || c.candidateFailures > 0) {
        history.push(`REJECTED(confirm ${c.wins}/${CONFIRM_SIZE}, ${c.candidateFailures} gate regressions): ${proposal.rationale}`);
        continue;
      }

      const promotedHash = promote(candDir, globalIter, proposal.rationale);
      history.push(`ACCEPTED(${promotedHash}): ${proposal.rationale}`);
      console.log(`ACCEPTED -> incumbent is now ${promotedHash}`);
    } catch (e) {
      // Infrastructure failure must not kill an hours-long run or masquerade as a design verdict
      log({ event: "iteration_error", iteration: globalIter, error: String(e).slice(0, 400) });
      console.error(`iteration ${globalIter} errored: ${e}`);
    } finally {
      fs.rmSync(candDir, { recursive: true, force: true });
    }
  }

  console.log("\nDone. History:");
  for (const h of history) console.log(`  ${h}`);
}

await main();
