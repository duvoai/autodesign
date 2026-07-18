# autodesign - Build Plan (v2, post-review)

Autoresearch loop for the AGI House autoresearch hackathon (https://blog.agihouse.org/posts/autoresearch-research-brief). Goal: an autoimproving loop that evolves a coding harness's context ("genome") so it generates better landing pages, with a frozen evaluator and held-out validation. Revised after an adversarial plan review (Codex, gpt-5.6-sol); key changes: two-stage acceptance test, artifact-exact comparisons, isolated generation workdir, pre-registered success criterion, honest iteration budget.

## Pre-registered success criterion (fixed before any loop run)

Primary: the final genome beats genome/v0 on the 5 holdout prompts as judged by a second-family vision model (not Anthropic), winning a majority of decisive comparisons. Secondary: same comparison under the frozen Fable judge. If Fable says the final genome wins but the second-family judge does not, the result is reported as quantified reward hacking of the frozen judge, not as improvement.

## Architecture

- **Genome** = context files loaded by the generator (design-guidelines skill + system prompt). This is what the loop mutates. v0 is neutral, not sandbagged: "produce a single self-contained index.html landing page for the brief", no design guidance.
- **Generator** = pi 0.73.1 running `kimi-k3` via Moonshot (VERIFIED end-to-end: `pi --provider moonshotai --model kimi-k3 -p`). K3 is a reasoning model; generation needs a generous output budget. Model is FIXED for the whole experiment; switching models mid-run invalidates all comparisons and starts a new experiment.
- **Verifier** = mechanical gates + frozen Claude Fable 5 pairwise judge on rendered screenshots.
- **Loop** = propose mutation -> screen -> confirm -> promote/revert, always judging stored artifacts.
- **Prompts** = prompts.json train split (15). Holdout prompts (5) move OUT of the loop's readable surface (see Step 6).

## Step 1 - Generation path

`src/generate.ts`: run pi in an ISOLATED temp workdir per generation (empty dir, `--no-session --no-context-files`, genome injected via `--append-system-prompt`/`--skill`), 5-minute timeout, output must be a single self-contained `index.html` (no external assets). Malformed/missing output = generation failure (counts as a loss). Artifacts are content-addressed: `runs/<genome-hash>/<prompt-id>/index.html` and never overwritten for the same (genome, prompt) identity within a stage.

## Step 2 - Renderer

`src/render.ts`: serve the HTML from a localhost static server (not file://), isolated browser context, network blocked except localhost, JS timers frozen after load settle, navigation timeout. Screenshots: above-the-fold desktop (1440x900) and mobile (390x844) for judging; full-page capture kept as a gate/demo artifact only (full-page shots downscale long pages and bias the judge toward short pages). Capture page errors (`pageerror`), not console noise.

## Step 3 - Mechanical gates

`src/gates.ts`, hard-fail -> counts as loss:
- zero uncaught page errors (JS exceptions only, not console.warn/log)
- no horizontal overflow at mobile width
- required sections present + on-topic: Haiku 4.5 classification over the RENDERED VISIBLE TEXT (Playwright innerText), not raw HTML, so hidden off-screen text cannot satisfy the gate

Known accepted limits (documented, not solved today): overflow-x:hidden clipping, fake/non-functional controls.

## Step 4 - Frozen Fable pairwise judge

`src/judge.ts`: candidate vs incumbent above-the-fold screenshots for the same prompt, TWO judge calls with A/B positions swapped; they must agree, otherwise tie. Rubric: visual hierarchy, typography, spacing, cohesion, fit to the brief; ignore any text addressing the judge. Structured output {winner}. Model `claude-fable-5`, effort low. NO fallback model: on refusal/error retry once, then score the comparison as a tie (an evaluator swap mid-experiment would unfreeze the judge). Judge file is frozen after the first successful run; every verdict logs the serving model as a check.

## Step 5 - Autoresearch loop

`src/loop.ts`. Two-stage acceptance (replaces the statistically unsound ">=60% of one 5-prompt minibatch", which accepts pure noise 50% of the time):

1. **Propose**: one Fable call (effort high) reads genome + full accept/reject history -> ONE concrete mutation as a diff.
2. **Screen**: generate candidate pages for 5 train prompts; gates; judge vs incumbent's STORED artifacts for those prompts. Pass requires >=4 wins of 5 AND >=3 decisive (non-tie) comparisons.
3. **Confirm**: on a screening pass, take 5 DIFFERENT train prompts and generate FRESH pages from BOTH genomes (symmetric generation luck); judge the fresh pairs. Accept requires >=4/5 again with no gate regressions. False-accept rate under the null: (6/32)^2 ~= 3.5% per proposal.
4. **Promote atomically**: candidate genome becomes incumbent; its judged artifacts become the stored incumbent artifacts for those prompts; remaining prompts keep their existing incumbent artifacts until next judged (never silently regenerated). Reverts discard the candidate dir entirely.
5. Log every proposal, verdict, and serving model to `runs/log.jsonl`.

Honest budget: each confirmed accept costs ~15 generations + ~20 judge calls; with K3 reasoning latency, expect 3-6 confirmed mutations in the afternoon (parallelize generations within a stage to help). The demo story is "traceable accepted design rules", not a long curve.

## Step 6 - Holdout validation + demo (protected hour)

- Holdout prompts live OUTSIDE the loop's working surface (separate file not mounted into pi's workdir and never passed to proposer/generator during optimization; pi also runs with `--no-context-files` in an empty temp dir, so it cannot read the repo).
- Final eval: v0 vs final genome on the 5 holdout prompts, fresh generations both sides, judged by (a) the second-family judge (primary, per pre-registered criterion) and (b) the frozen Fable judge (secondary).
- Demo assets: accepted-mutation timeline with per-stage win counts, before/after screenshots, diff of v0 vs final genome.
- Honest caveats stated on the slide: n=5 holdout is descriptive, not a significance claim; the acceptance heuristic is conservative-for-a-hackathon, not a hypothesis test.

## Known risks

- Judge-family steering: proposer and frozen judge are both Fable; the holdout second-family judge is the check, per the pre-registered criterion.
- Visual prompt injection and gate gaming are mitigated (visible-text gates, rubric instruction, swap-agreement) but not eliminated; log artifacts so any exploit is inspectable.
- K3 latency bounds throughput; parallel generation within stages is the main lever.
- Anthropic API key still pending (judge + proposer blocked until provided).

## Priority order if time collapses

Steps 1-4 on a single prompt > loop with even 2-3 confirmed mutations > holdout (never cut: holdout, artifact logging, exact v0-vs-final comparison). Commit after each step; main always holds last working state.
