# autodesign

Automated research loop that evolves a Pi harness config for better UI/UX output.
See `docs/superpowers/specs/2026-07-18-ui-harness-autoresearch-design.md`.

## Commands

- `bun run reference` — build the fixed reference pages (one-time, needs ANTHROPIC_API_KEY + pi).
- `bun run loop --iterations N [--run-id X] [--concurrency 5]` — run the research loop.
- `bun run holdout --run-id X [--version V]` — score a config on holdout prompts (report only).
- `bun run resume --run-id X` — continue an interrupted run.
