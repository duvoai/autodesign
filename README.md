# autodesign

Autoresearch loop for AI-generated landing pages: propose a page, render it, score it against a frozen verifier, keep it if it beats the best so far, revert if not.

Built at the AGI House [autoresearch hackathon](https://blog.agihouse.org/posts/autoresearch-research-brief).

## Prompts

[prompts.json](prompts.json) holds the landing page generation tasks the loop runs against.

- Each prompt has an `id`, `category`, `split`, and the generation `prompt` itself.
- Prompts span 15+ categories (SaaS, dev tools, fintech, ecommerce, nonprofit, gaming, local business, ...) so the loop can't overfit to one page archetype.
- Every prompt lists required sections (hero, pricing, CTA, ...) so a degenerate output (blank page, single centered div) fails on content grounds, not just aesthetics.

### Train / holdout split

- `split: "train"` (15 prompts): the only prompts the optimization loop may score against.
- `split: "holdout"` (5 prompts): reserved for final validation. Never used during optimization, so improvements that transfer to them are evidence of genuine gains rather than verifier overfitting.
