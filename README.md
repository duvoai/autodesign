# autodesign

Automated research loop that evolves a Pi harness config for better UI/UX output.
See `docs/superpowers/specs/2026-07-18-ui-harness-autoresearch-design.md`.

Each iteration builds one self-contained landing page per train prompt (via the
`pi` CLI), screenshots it in scrolled viewport segments (Playwright), and scores
it with an Opus vision call against a fixed rubric. The best-scoring harness
config is then mutated (schema-constrained) into the next candidate. All state
lives under `runs/`.

## Status

- **Reference comparison is deferred (TBD).** The evaluator currently scores on
  the rubric alone. The reference-page generator (`src/reference/build-reference.ts`,
  `bun run reference`) is implemented and tested but not wired into the loop; when
  a reference exists for a prompt the evaluator will use it, but none are required.

## Setup

```bash
bun install
bunx playwright install chromium
export ANTHROPIC_API_KEY=sk-ant-...    # needed for evaluate + mutate (and reference, if used)
# `pi` must be on PATH (the builder shells out to it). Override with PI_BIN=/path/to/pi.
```

## Commands

- `bun run loop --iterations N [--run-id X] [--concurrency 5]` — run the research loop over the train prompts.
- `bun run holdout --run-id X [--version V]` — score a config on holdout prompts (report only; never mutates or touches history).
- `bun run resume --run-id X` — continue an interrupted run from the last completed iteration.
- `bun run reference [--force] [--concurrency 3]` — (optional, TBD) build cached reference pages for every prompt with a fixed high-effort Opus harness.

Environment overrides: `EVAL_MODEL` (default `claude-opus-4-8`) for the evaluator/mutator model; `PI_BIN` for the builder CLI.

## Tests

```bash
bun test          # full suite (uses stubbed pi + fake LLM clients + real Playwright)
bunx tsc --noEmit # type-check
```
