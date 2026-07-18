# UI/UX Harness Auto-Research Loop — Design

**Date:** 2026-07-18
**Status:** Approved

## Purpose

An automated research loop that iteratively improves a Pi coding-harness configuration for building better-looking webapp UIs. Each iteration builds a batch of landing pages from a fixed prompt set, screenshots them, scores them with a vision evaluator, and mutates the harness config to raise the score. The end product is a harness config (system instructions, skills, tools, subagents, model settings) that demonstrably produces better UI/UX than the baseline.

## Non-goals

- No server, no dashboard, no client app. Pure scripts. A visualization layer may come later; this design does not include it.
- No optimization of the reference set, the rubric, or the evaluator itself — those are fixed inputs.
- No multi-page apps or interactivity testing. Single self-contained HTML landing pages, judged visually from static screenshots.

## Repo reset

The existing repo contents (bhvr monorepo, introspection recipe) are deleted. Only `.git/` and `prompts.json` are kept. The new codebase is Bun + TypeScript scripts built from scratch.

## Architecture overview

Two nested loops, driven entirely by scripts and files on disk:

```
reference (one-time):
  for each prompt (train + holdout):
    build with Opus, fixed high-effort harness → output.html → screenshot
    cache at runs/reference/<prompt-id>.{html,png}

outer loop (per iteration):
  config = current harness version (JSON)
  resolve(config) → generated Pi agent/extension + skill files   [deterministic]
  inner loop, bounded concurrency, train prompts only:
    build:      pi --print in isolated scratch dir → output.html
    screenshot: headless Chromium → candidate.png
    evaluate:   one Opus vision call — rubric + candidate.png + reference.png
                → structured subscores + relative verdict vs reference
  aggregate scores → iteration summary
  mutate: one Opus text call, schema-constrained → next config version + rationale
  persist everything under runs/<run-id>/iterations/<N>/
  track best_version by mean train score (elitist anchor)

periodically / at end:
  evaluate best_version against holdout prompts — report only, never fed to mutation
```

## Components

### 1. Harness config ("genome") — `src/config/schema.ts`

A single JSON document is the entire mutable search space. Nothing else is hand- or model-edited.

```json
{
  "version": 7,
  "parent_version": 6,
  "rationale": "why the mutator made this change",
  "model": { "name": "anthropic/claude-sonnet-4-6", "thinking_level": "medium" },
  "tools": ["read", "write", "bash"],
  "system_instructions": "design guidance text given to the builder agent",
  "skills": [{ "id": "visual-hierarchy", "content": "<markdown SKILL.md body>" }],
  "subagents": [
    {
      "name": "critic",
      "description": "reviews the page before finalizing",
      "system_instructions": "…",
      "tools": ["read"]
    }
  ]
}
```

- Validated with a zod schema. The mutator's output is forced through the same schema via a tool-call (structured output); freeform file edits are impossible by construction.
- Config versions are content-addressable by `version` integer and stored as flat JSON files, so the whole search trajectory is diffable in git.

### 2. Resolver — `src/config/resolver.ts`

Pure deterministic function: config JSON → materialized Pi harness on disk (generated agent/extension file, skill directories with `SKILL.md`, subagent definitions). Byte-identical output for identical input. Output goes into a per-iteration `resolved/` directory; nothing is installed globally (no `recipes install`, no `~/.pi` mutation), so parallel runs and iterations cannot collide.

### 3. Builder — `src/inner/build.ts`

Per prompt:

- Create an isolated scratch dir `runs/<run-id>/iterations/<N>/prompts/<prompt-id>/workspace/`.
- Invoke `pi --print --mode json --no-session` with the resolved harness (`-e` extension/agent file, `--skill` dirs, `--model`, `--thinking`, `--tools` from config), cwd set to the scratch dir.
- Contract with the builder agent: write exactly one self-contained `output.html` (inline CSS/JS, no external network dependencies beyond what renders offline).
- Missing/invalid `output.html` after the run → recorded as a build failure with the captured Pi transcript; scored as 0, never silently dropped.

### 4. Screenshotter — `src/inner/screenshot.ts`

Playwright headless Chromium loads `output.html` via `file://` and captures **scrolled viewport segments**, not a single full-page shot (full-page PNGs of long pages get downscaled into illegibility by the vision model):

- Desktop viewport 1440×900: scroll from the top one viewport height at a time, one PNG per screen (`<base>.desktop.<i>.png`), capped at 8 segments.
- Mobile viewport 390×844: same procedure (`<base>.mobile.<i>.png`), capped at 8 segments.
- The final segment aligns to the bottom of the page (no blank overshoot); trivially short pages produce a single segment per viewport.

Render errors (blank page, JS exception preventing paint) are recorded as failures.

### 5. Evaluator — `src/inner/evaluate.ts`

One Opus vision call per prompt per iteration. Inputs:

- The original prompt text and its must-include requirements.
- The fixed rubric.
- The candidate screenshot segments: all desktop segments (≤8) in scroll order, plus the first 3 mobile segments.
- The cached reference desktop segments (≤4) for the same prompt, clearly labeled as the reference.

Output (forced tool-call schema):

- Rubric subscores 0–10: visual hierarchy, typography, spacing/layout, color/contrast, requirement coverage, overall polish.
- `overall` score 0–100 (weighted; requirement coverage acts as a gate — a page missing required sections cannot score high on polish alone).
- Relative verdict vs reference: `behind | on_par | ahead`, with the dimensions where it differs.
- Short critique text (feeds the mutator).

The rubric text lives in `src/eval/rubric.md` and is fixed for the lifetime of a run.

### 6. Reference generator — `src/reference/build-reference.ts`

One-time, pre-loop script. For every prompt (train and holdout), builds the page with Opus at high thinking effort using a fixed, hand-written "best effort" harness (not part of the search space), screenshots it identically to candidates, and caches `runs/reference/<prompt-id>.{html,png}`. The loop refuses to start if reference images are missing. References are never regenerated mid-run.

### 7. Mutator — `src/outer/mutate.ts`

After a full train batch:

- Input: current `best_version` config, this iteration's aggregate summary (mean/percentile scores, per-dimension breakdown, worst prompts, evaluator critiques), and a compact history of prior versions with their scores and rationales.
- One Opus text call, schema-constrained to emit a complete new config object plus a `rationale` string.
- Selection strategy: **hill-climbing with an elitist anchor.** The challenger is always derived from `best_version` (the highest mean-train-score version so far), not necessarily the latest — a bad mutation cannot compound.

### 8. Orchestrator — `src/run.ts`

CLI entry points (invoked via `bun run`):

- `bun run reference` — build the reference set.
- `bun run loop --iterations N [--run-id X] [--concurrency 5]` — run the outer loop.
- `bun run holdout [--version V]` — evaluate a config (default `best_version`) against holdout prompts; report only.
- `bun run resume --run-id X` — continue an interrupted run from the last completed iteration.

Bounded concurrency (default 5) across the inner-loop prompt pipeline. Each prompt's build→screenshot→evaluate chain runs independently (pipeline, not barriers).

## Data layout

```
prompts.json                          # kept as-is; train/holdout split is authoritative
runs/
  reference/
    <prompt-id>.html
    <prompt-id>.desktop.<i>.png       # scrolled segments, i = 0..N-1
    <prompt-id>.mobile.<i>.png
  <run-id>/
    run.json                          # run metadata: models, concurrency, started_at
    history.jsonl                     # one line per iteration: version, mean score, best_version
    configs/
      v<N>.json                       # every config version ever proposed
    iterations/
      <N>/
        config-version.txt            # which config this iteration ran
        resolved/                     # materialized harness (agent, skills)
        prompts/
          <prompt-id>/
            workspace/output.html
            candidate.desktop.<i>.png   # scrolled segments
            candidate.mobile.<i>.png
            eval.json
            build.log
        summary.json                  # aggregates + mutator rationale
    holdout/
      <timestamp>/…                   # same shape as an iteration, holdout prompts
```

`runs/` is gitignored except `configs/` and `history.jsonl` snapshots the user chooses to commit.

## Train/holdout discipline

The loop optimizes exclusively against `split=train` prompts. Holdout prompts are used only by the explicit `holdout` command and their results are never included in mutator inputs. This is enforced structurally: the mutator's input assembly reads from iteration summaries, which only ever contain train results.

## Failure handling

- Build failure (no/invalid HTML): score 0, transcript saved, iteration continues.
- Screenshot failure: score 0, error saved.
- Evaluator API error: retry ×2 with backoff; then mark the prompt `eval_failed` and exclude it from the mean (recorded in summary so the mutator knows coverage was partial).
- Mutator schema-validation failure: retry ×2; then re-run the iteration's mutation with the error appended; if still failing, the run halts with state fully persisted (resumable).
- Interrupt/crash: `resume` picks up from the last fully persisted iteration.

## Tech stack

- **Runtime/scripts:** Bun + TypeScript, no framework.
- **Screenshots:** Playwright (chromium).
- **LLM calls:** `@anthropic-ai/sdk` — Opus for reference generation, evaluation, and mutation; builder model is part of the config genome (starts at Sonnet).
- **Builder harness:** `pi` CLI invoked as a subprocess, ephemeral per-prompt sessions, project-local resolved extensions only.
- **Validation:** zod for config schema and evaluator/mutator structured outputs.

## Cost/scale envelope

Per iteration: 15 train prompts × (1 Pi build + 1 Opus eval call). Mutation adds 1 Opus call. A 20-iteration run ≈ 300 builds + 300 eval calls + 20 mutation calls, plus one-time 20 reference builds. Concurrency 5 keeps wall-clock per iteration roughly at 3–4× a single build+eval chain.

## Testing

- Unit: config schema validation round-trips; resolver determinism (same config → identical bytes); mutator output validation and retry path.
- Integration (mocked LLM/pi): one full iteration over 2 fake prompts with a stub builder that writes canned HTML and a stub evaluator returning fixed scores — asserts directory layout, history.jsonl, best_version tracking, and holdout isolation.
- Smoke (real, manual): `bun run loop --iterations 1` against 2 train prompts with real Pi + API before any long run.
