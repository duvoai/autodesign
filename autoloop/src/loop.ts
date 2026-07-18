import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { generate, genomeHash, loadPrompts } from "./generate.js";
import { render } from "./render.js";
import { gates } from "./gates.js";
import { judgePair } from "./judge.js";
import { claudeCall, lastJson } from "./claude.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const GENOME_CURRENT = path.join(ROOT, "genome", "current");
const LOG = path.join(ROOT, "runs", "log.jsonl");

const SCREEN_SIZE = 5;
const CONFIRM_SIZE = 5;
const WIN_THRESHOLD = 4;
const MIN_DECISIVE = 3;

interface PromptEntry { id: string; prompt: string }

function log(entry: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

/** Generate (content-addressed, cached) + render + gate one page; returns null on any failure */
async function preparePage(p: PromptEntry, genomeDir: string) {
  const gen = await generate(p.id, p.prompt, genomeDir);
  if (!gen.ok || !gen.htmlPath) return null;

  const shotExists = fs.existsSync(path.join(gen.outDir, "desktop.png"));
  const renderRes = await render(gen.htmlPath, gen.outDir);
  if (!renderRes.ok) return null;

  // Gate verdicts are cached alongside artifacts
  const gatePath = path.join(gen.outDir, "gates.json");
  let gateRes;
  if (shotExists && fs.existsSync(gatePath)) {
    gateRes = JSON.parse(fs.readFileSync(gatePath, "utf8"));
  } else {
    gateRes = await gates(renderRes, p.prompt);
    fs.writeFileSync(gatePath, JSON.stringify(gateRes));
  }
  if (!gateRes.pass) {
    log({ event: "gate_fail", prompt: p.id, genome: genomeHash(genomeDir), failures: gateRes.failures });
    return null;
  }
  return { shot: renderRes.desktopShot };
}

/**
 * One judged stage: candidate vs incumbent on the given prompts.
 * A candidate page that fails generation or gates counts as a loss.
 */
async function stage(
  name: string,
  prompts: PromptEntry[],
  candDir: string,
  incDir: string,
): Promise<{ wins: number; decisive: number; results: Record<string, string> }> {
  let wins = 0;
  let decisive = 0;
  const results: Record<string, string> = {};

  // Generations are the latency bottleneck: run them in parallel first
  await Promise.all(prompts.map((p) => generate(p.id, p.prompt, candDir)));
  await Promise.all(prompts.map((p) => generate(p.id, p.prompt, incDir)));

  for (const p of prompts) {
    const cand = await preparePage(p, candDir);
    if (!cand) {
      results[p.id] = "loss(gate/gen)";
      decisive++;
      continue;
    }
    const inc = await preparePage(p, incDir);
    if (!inc) {
      results[p.id] = "win(incumbent-failed)";
      wins++;
      decisive++;
      continue;
    }
    const { verdict } = await judgePair(p.prompt, cand.shot, inc.shot);
    results[p.id] = verdict;
    if (verdict !== "tie") decisive++;
    if (verdict === "candidate") wins++;
  }

  log({ event: name, candidate: genomeHash(candDir), incumbent: genomeHash(incDir), wins, decisive, results });
  return { wins, decisive, results };
}

/** Ask the proposer for one mutation to system.md; returns the new full file content */
async function propose(history: string[]): Promise<{ rationale: string; system_md: string }> {
  const current = fs.readFileSync(path.join(GENOME_CURRENT, "system.md"), "utf8");
  const prompt = [
    "You are evolving the system prompt of a landing-page-generating coding agent (the 'genome').",
    "Propose ONE focused mutation: add, sharpen, or replace a small number of design rules.",
    "Good mutations are concrete and visual (typography scale, spacing system, color strategy, hero composition, section rhythm). Avoid vague advice.",
    "The generator model is Kimi K3 producing a single self-contained index.html; keep all existing hard constraints (self-contained, no external assets, include required sections).",
    "",
    "CURRENT GENOME (system.md):",
    "---",
    current,
    "---",
    "",
    "ACCEPT/REJECT HISTORY (most recent last):",
    history.length ? history.join("\n") : "(none yet)",
    "",
    "Respond with ONLY one JSON object on one line:",
    '{"rationale": "one sentence", "system_md": "the complete new system.md content"}',
  ].join("\n");

  const out = await claudeCall(prompt, { model: "claude-fable-5", timeoutMs: 300000 });
  return lastJson<{ rationale: string; system_md: string }>(out);
}

/** Split train prompts into disjoint screen/confirm sets, rotated by iteration */
function pickPrompts(iteration: number): { screen: PromptEntry[]; confirm: PromptEntry[] } {
  const train = loadPrompts("train");
  const rotated = [...train.slice(iteration % train.length), ...train.slice(0, iteration % train.length)];
  return { screen: rotated.slice(0, SCREEN_SIZE), confirm: rotated.slice(SCREEN_SIZE, SCREEN_SIZE + CONFIRM_SIZE) };
}

async function main(): Promise<void> {
  const maxIterations = Number(process.argv[2] ?? 10);
  const history: string[] = [];

  for (let i = 0; i < maxIterations; i++) {
    console.log(`\n=== iteration ${i} (incumbent ${genomeHash(GENOME_CURRENT)}) ===`);

    const proposal = await propose(history);
    const candDir = path.join(ROOT, "genome", `candidate-${Date.now()}`);
    fs.mkdirSync(candDir, { recursive: true });
    fs.writeFileSync(path.join(candDir, "system.md"), proposal.system_md);
    log({ event: "propose", iteration: i, candidate: genomeHash(candDir), rationale: proposal.rationale });
    console.log(`proposal: ${proposal.rationale}`);

    const { screen, confirm } = pickPrompts(i);

    const s = await stage("screen", screen, candDir, GENOME_CURRENT);
    console.log(`screen: ${s.wins}/${SCREEN_SIZE} wins, ${s.decisive} decisive`, s.results);
    if (s.wins < WIN_THRESHOLD || s.decisive < MIN_DECISIVE) {
      history.push(`REJECTED(screen ${s.wins}/${SCREEN_SIZE}): ${proposal.rationale}`);
      fs.rmSync(candDir, { recursive: true, force: true });
      continue;
    }

    const c = await stage("confirm", confirm, candDir, GENOME_CURRENT);
    console.log(`confirm: ${c.wins}/${CONFIRM_SIZE} wins, ${c.decisive} decisive`, c.results);
    if (c.wins < WIN_THRESHOLD || c.decisive < MIN_DECISIVE) {
      history.push(`REJECTED(confirm ${c.wins}/${CONFIRM_SIZE}): ${proposal.rationale}`);
      fs.rmSync(candDir, { recursive: true, force: true });
      continue;
    }

    // Promote atomically: candidate becomes the incumbent genome
    const promotedHash = genomeHash(candDir);
    fs.rmSync(GENOME_CURRENT, { recursive: true, force: true });
    fs.cpSync(candDir, GENOME_CURRENT, { recursive: true });
    fs.rmSync(candDir, { recursive: true, force: true });
    history.push(`ACCEPTED(${promotedHash}): ${proposal.rationale}`);
    log({ event: "accept", iteration: i, genome: promotedHash, rationale: proposal.rationale });
    console.log(`ACCEPTED -> incumbent is now ${promotedHash}`);
  }

  console.log("\nDone. History:");
  for (const h of history) console.log(`  ${h}`);
}

await main();
