# Tech Spec: Multi-file Genome with Skills

Status: proposed
Scope: `autoloop/src/generate.ts`, `autoloop/src/loop.ts`, `genome/` layout
Untouched: `judge.ts` (frozen evaluator), `gates.ts`, `render.ts`, `claude.ts`, `holdout.ts` (inherits via `generate()`), `genome/v0` (frozen baseline)

## Motivation

The genome is a single `system.md` that the proposer rewrites wholesale, while PLAN.md defines the genome as "design-guidelines skill + system prompt". The single-file design caps how much design knowledge fits (everything is always in context), lets one aggressive mutation delete the hard harness constraints (then every generation gate-fails), and the code hard-blocks subdirectories anyway: `genomeHash` throws `EISDIR` on any nested dir, and candidate dirs are created with only `system.md`.

pi supports what we need: skill = dir with `SKILL.md` (frontmatter `name`, `description` <= 1024 chars); only descriptions are always in context, bodies and bundled assets load on demand via `read`; `--skill <path>` is repeatable and stays active alongside `--no-skills`, preserving isolation.

## Target genome layout

```
genome/current/
  contract.md                    # NEW, immutable: harness I/O contract + skill-read nudge
  system.md                      # mutable design guidance
  skills/<name>/SKILL.md         # evolvable knowledge, loaded on demand
  skills/<name>/...              # optional reference assets (e.g. examples/hero.html)
genome/history/<iter>-<hash>/    # NEW: snapshot of every accepted genome (git-tracked)
genome/v0/system.md              # untouched, byte-identical forever
```

`contract.md` = the four hard rules from v0 plus: "If any skills are listed, read their SKILL.md files before writing code." Immutability is enforced by byte-equality validation (C4). The read-nudge lives in the immutable file because pi models don't reliably read skills unprompted; if the nudge were mutable, a later mutation could strand all skills as dead weight.

## Changes

### C1. Recursive genome hash (`generate.ts`)

- New exported `genomeFiles(dir)`: recursive listing (`fs.readdirSync(dir, {recursive: true})`, Node >= 20; repo runs 22), posix-normalized relative paths, files only, sorted.
- `genomeHash`: per file, hash `path + "\0" + content + "\0"`. The `\0` separators fix the current concat ambiguity (`"ab"+"c"` hashes like `"a"+"bc"`).
- Consequence: all hashes change, orphaning existing `runs/<hash>` artifacts. Ship between experiments only.

### C2. Generation-time skill injection (`generate.ts`)

- `attemptOnce` takes `genomeDir` instead of `systemFile`.
- Stage into `<tmp>/.genome/`:
  - If `contract.md` exists: write merged file (`contract.md + "\n\n" + system.md`) and pass its path to `--append-system-prompt` (same file-path mechanism as today). Else pass `<genomeDir>/system.md` directly, so the v0 argv is byte-identical to today.
  - If `skills/` exists: `cpSync` into staging; add `--skill <staged>/skills/<name>/SKILL.md` per skill dir (sorted).
- Keep `--no-skills` (explicit `--skill` remains active per pi docs). Staging keeps repo paths out of the generator's context; a genome without `contract.md`/`skills/` produces today's exact command.

### C3. Mutation operator: targeted ops (`loop.ts propose`)

- Contract: `{ rationale: string, ops: GenomeOp[] }` with 1-3 ops; `GenomeOp = { action: "write" | "delete", file: string, content?: string }`. `write` = create-or-replace full file. 3 ops suffice to create a skill and add a `system.md` reference in one focused proposal.
- Proposer prompt: render every genome file (via `genomeFiles`) as `--- <path> ---` blocks; document the action space (edit `system.md`; create/refine `skills/<name>/SKILL.md` with frontmatter `name: <dirname>` + `description:`; add small reference assets; `contract.md` off-limits); show current size vs budget; history entries name files touched.
- Shape validation: ops count 1-3, action enum, `content` required for writes and <= 8 KB per op. Parse failures fall into the existing `iteration_error` path.
- Keep `claudeCall` + `lastJson` unchanged.

### C4. Candidate materialization + validation (`loop.ts main`)

Replace "mkdir + write system.md" with:

```
cpSync(GENOME_CURRENT -> candDir, recursive)
applyOps(candDir, proposal.ops)        // throws on unsafe path
problems = validateGenome(candDir)
if problems: log invalid_proposal; history.push(`INVALID(...)`); continue
```

- `applyOps` path allowlist before any write: `^system\.md$` or `^skills/[a-z0-9-]+(/[A-Za-z0-9._-]+)+$`; reject `..`, absolute paths, and anything else (notably `contract.md`).
- `validateGenome`: `contract.md` byte-identical to incumbent's; `system.md` exists, non-trivial; every `skills/<name>/` contains `SKILL.md` with frontmatter `name` == dirname (`^[a-z0-9-]{1,64}$`) and non-empty `description` <= 1024 chars; <= 3 skills; <= 16 files; <= 24 KB total (v0 is 471 bytes; blocks context-bloat as a win strategy).
- Existing no-op hash check keeps working via C1.

### C5. Failure feedback to the proposer (`loop.ts stage` / `seedHistory`)

- Loss entries in the `results` map carry the reason: `loss(gate_fail: horizontal overflow at mobile width)`, truncated ~60 chars; already flows into the logged `screen`/`confirm` events.
- Rejection history strings include candidate-side failure reasons; `seedHistory` reconstructs the same strings from the log so restarts keep the signal.
- `judge.ts` deliberately untouched: adding a "reason" field would unfreeze the frozen judge.

### C6. Accepted-genome snapshots (`loop.ts promote`)

- Before the swap: `cpSync(candDir -> genome/history/<iteration, zero-padded>-<hash>/)`. `genome/` is git-tracked, so accepted mutations become committable and feed the demo timeline.

## Migration

1. `genome/v0`: untouched.
2. `genome/current`: behavior-preserving split into `contract.md` + `system.md` (concatenation reads as close to v0 as possible); smoke-generate once to confirm.
3. Archive the log: `mv runs/log.jsonl runs/log-exp1.jsonl`. C1 orphans old artifacts anyway, and single-file-era history would misguide the new proposer.
4. Seeding: default is NO seeded skill - the loop introduces skills as ordinary proposals validated by screen+confirm (clean attribution for the pre-registered v0-vs-final claim). Optional fast path: hand-seed `skills/design-guidelines/`, but then report v0-vs-seed separately or run the seed through one screen+confirm cycle before adopting it.

## Verification

- `pi --help` on the loop machine (pi not installed here): confirm `--skill` accepts a `SKILL.md` path (vs dir) and `--append-system-prompt` path semantics.
- Skill-read smoke test: temp genome whose skill body says to include `<!-- skill-loaded -->` in `index.html`; generate once, grep the artifact. Proves K3 actually reads skill bodies given the contract nudge.
- v0 argv byte-identity: factor arg construction into `buildArgs()`, assert unchanged for a skill-less genome.
- `src/selftest.ts` (tsx-run, no framework): recursive-hash fixture; `applyOps` rejects `../escape` and absolute paths; `validateGenome` rejects over-budget and contract-touching proposals.

## Rollout order and size

C1 -> C2 (~50 lines, safe standalone) -> C4 -> C3 (~120 lines) -> C5 -> C6 (~30 each) -> migration -> verification. No new dependencies; no changes to judge/gates/render schemas. Roughly half a day plus the on-machine pi checks.
