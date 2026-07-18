# UI/UX Harness Auto-Research Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Script-driven research loop that iteratively mutates a Pi harness config (system instructions, skills, tools, model, subagent roles) to maximize a vision-model rubric score on generated landing pages.

**Architecture:** An inner loop builds one self-contained `output.html` per train prompt via the `pi` CLI, screenshots it with Playwright, and scores it with one Opus vision call against a fixed rubric plus a cached reference screenshot. An outer loop aggregates the batch and asks Opus (schema-constrained) for the next config version, hill-climbing from the best-scoring version so far. Everything persists as files under `runs/`.

**Tech Stack:** Bun + TypeScript, zod (v4, for schemas + `z.toJSONSchema`), `@anthropic-ai/sdk`, Playwright (chromium), `pi` CLI as subprocess.

**Spec:** `docs/superpowers/specs/2026-07-18-ui-harness-autoresearch-design.md` — read it before starting.

## Global Constraints

- Repo is wiped first: everything deleted except `.git/`, `prompts.json`, `docs/`.
- Optimization uses ONLY prompts with `"split": "train"` from `prompts.json`. Holdout results must never reach the mutator.
- The mutator and evaluator outputs are forced through zod schemas via tool-calls — no freeform edits to harness files, ever.
- Resolver must be deterministic: identical config → byte-identical files.
- Default models: evaluator/mutator/reference = `claude-opus-4-8` (env `EVAL_MODEL` overrides); builder model lives inside the config genome (baseline `anthropic/claude-sonnet-4-6`).
- No global installs or `~/.pi` mutation: `pi` runs with `--no-session --no-extensions --no-context-files --no-prompt-templates` and explicit `--skill`/`--append-system-prompt` paths, cwd = isolated scratch dir.
- Failures score 0 and are recorded, never silently dropped; `eval_failed` prompts are excluded from means but recorded in the summary.
- Tests use `bun test`. LLM client is injected via a minimal interface; `pi` is stubbed via env `PI_BIN`.
- All commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Repo wipe + project scaffold

**Files:**
- Delete: `client/`, `server/`, `shared/`, `introspection/`, `.introspection/`, `.turbo/`, `BHVR.md`, `CONTRIBUTING.md`, `LICENSE`, `README.md`, `bun.lock`, `package.json`, `tsconfig.json`, `turbo.json`, `.github/`, `node_modules/`
- Keep: `.git/`, `prompts.json`, `docs/`
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `README.md`

**Interfaces:**
- Produces: a Bun workspace where `bun test` runs and `zod`, `@anthropic-ai/sdk`, `playwright` are importable.

- [ ] **Step 1: Wipe old contents**

```bash
cd /Users/bukacdan/projects/agi_house_autoresearch
git rm -rq client server shared introspection .introspection BHVR.md CONTRIBUTING.md LICENSE README.md bun.lock package.json tsconfig.json turbo.json .github .gitignore
rm -rf node_modules .turbo client server shared introspection
git status --short   # expect only deletions + untracked docs/ if not yet tracked
```

- [ ] **Step 2: Write new root files**

`package.json`:
```json
{
  "name": "autodesign",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "reference": "bun src/cli.ts reference",
    "loop": "bun src/cli.ts loop",
    "holdout": "bun src/cli.ts holdout",
    "resume": "bun src/cli.ts resume",
    "test": "bun test"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.60.0",
    "playwright": "^1.54.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.8.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "types": ["bun"],
    "noEmit": true
  },
  "include": ["src", "tests"]
}
```

`.gitignore`:
```
node_modules/
runs/
!runs/reference/.gitkeep
*.log
.env
```

`README.md`:
```markdown
# autodesign

Automated research loop that evolves a Pi harness config for better UI/UX output.
See `docs/superpowers/specs/2026-07-18-ui-harness-autoresearch-design.md`.

## Commands

- `bun run reference` — build the fixed reference pages (one-time, needs ANTHROPIC_API_KEY + pi).
- `bun run loop --iterations N [--run-id X] [--concurrency 5]` — run the research loop.
- `bun run holdout --run-id X [--version V]` — score a config on holdout prompts (report only).
- `bun run resume --run-id X` — continue an interrupted run.
```

- [ ] **Step 3: Install and verify**

```bash
bun install
bunx playwright install chromium
echo 'import { expect, test } from "bun:test"; test("smoke", () => expect(1).toBe(1));' > tests/smoke.test.ts
mkdir -p src tests && bun test
```
Expected: 1 pass. Delete `tests/smoke.test.ts` afterwards.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Wipe starter repo; scaffold autodesign Bun project"
```

---

### Task 2: Config schema (the genome)

**Files:**
- Create: `src/config/schema.ts`
- Test: `tests/config-schema.test.ts`

**Interfaces:**
- Produces: `HarnessConfigSchema` (zod), `type HarnessConfig`, `BASELINE_CONFIG: HarnessConfig` (version 0), `THINKING_LEVELS` tuple.

- [ ] **Step 1: Write the failing test**

`tests/config-schema.test.ts`:
```ts
import { expect, test } from "bun:test";
import { HarnessConfigSchema, BASELINE_CONFIG } from "../src/config/schema";

test("baseline config validates", () => {
  expect(() => HarnessConfigSchema.parse(BASELINE_CONFIG)).not.toThrow();
  expect(BASELINE_CONFIG.version).toBe(0);
  expect(BASELINE_CONFIG.parent_version).toBeNull();
});

test("rejects unknown tools and bad skill ids", () => {
  const bad = { ...BASELINE_CONFIG, tools: ["read", "browser"] };
  expect(() => HarnessConfigSchema.parse(bad)).toThrow();
  const badSkill = { ...BASELINE_CONFIG, skills: [{ id: "Bad Id!", description: "x", content: "x" }] };
  expect(() => HarnessConfigSchema.parse(badSkill)).toThrow();
});

test("round-trips through JSON", () => {
  const parsed = HarnessConfigSchema.parse(JSON.parse(JSON.stringify(BASELINE_CONFIG)));
  expect(parsed).toEqual(BASELINE_CONFIG);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/config-schema.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/config/schema.ts`:
```ts
import { z } from "zod";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const ALLOWED_TOOLS = ["read", "write", "edit", "bash"] as const;

export const SkillSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().min(1),
  content: z.string().min(1),
});

export const SubagentSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().min(1),
  system_instructions: z.string().min(1),
  tools: z.array(z.enum(ALLOWED_TOOLS)),
});

export const HarnessConfigSchema = z.object({
  version: z.number().int().nonnegative(),
  parent_version: z.number().int().nonnegative().nullable(),
  rationale: z.string(),
  model: z.object({
    name: z.string().min(1),
    thinking_level: z.enum(THINKING_LEVELS),
  }),
  tools: z.array(z.enum(ALLOWED_TOOLS)).min(1),
  system_instructions: z.string().min(1),
  skills: z.array(SkillSchema).max(8),
  subagents: z.array(SubagentSchema).max(4),
});

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

export const BASELINE_CONFIG: HarnessConfig = {
  version: 0,
  parent_version: null,
  rationale: "Hand-written baseline.",
  model: { name: "anthropic/claude-sonnet-4-6", thinking_level: "medium" },
  tools: ["read", "write", "bash"],
  system_instructions: [
    "You are building a single marketing landing page as one self-contained HTML file.",
    "Write exactly one file named output.html in the current directory.",
    "All CSS and JS must be inline; no external network requests. Use system font stacks or embedded styles.",
    "Cover every requirement in the brief. Aim for a clean, modern, visually polished design.",
  ].join("\n"),
  skills: [],
  subagents: [],
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/config-schema.test.ts` — Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts tests/config-schema.test.ts
git commit -m "feat: harness config schema and baseline genome"
```

---

### Task 3: Prompts loader

**Files:**
- Create: `src/prompts.ts`
- Test: `tests/prompts.test.ts`

**Interfaces:**
- Produces: `type PromptSpec = { id: string; category: string; split: "train" | "holdout"; prompt: string }`, `loadPrompts(path?: string): PromptSpec[]`, `trainPrompts(all): PromptSpec[]`, `holdoutPrompts(all): PromptSpec[]`.

- [ ] **Step 1: Write the failing test**

`tests/prompts.test.ts`:
```ts
import { expect, test } from "bun:test";
import { loadPrompts, trainPrompts, holdoutPrompts } from "../src/prompts";

test("loads real prompts.json with valid splits", () => {
  const all = loadPrompts();
  expect(all.length).toBeGreaterThan(10);
  const train = trainPrompts(all);
  const holdout = holdoutPrompts(all);
  expect(train.length + holdout.length).toBe(all.length);
  expect(holdout.every((p) => p.split === "holdout")).toBe(true);
  expect(new Set(all.map((p) => p.id)).size).toBe(all.length);
});
```

- [ ] **Step 2: Run to verify FAIL** — `bun test tests/prompts.test.ts`

- [ ] **Step 3: Implement**

`src/prompts.ts`:
```ts
import { z } from "zod";
import { readFileSync } from "node:fs";

const PromptSpecSchema = z.object({
  id: z.string().min(1),
  category: z.string().min(1),
  split: z.enum(["train", "holdout"]),
  prompt: z.string().min(1),
});
const PromptFileSchema = z.object({
  version: z.number(),
  description: z.string(),
  prompts: z.array(PromptSpecSchema).min(1),
});

export type PromptSpec = z.infer<typeof PromptSpecSchema>;

export function loadPrompts(path = "prompts.json"): PromptSpec[] {
  const file = PromptFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const ids = new Set<string>();
  for (const p of file.prompts) {
    if (ids.has(p.id)) throw new Error(`duplicate prompt id: ${p.id}`);
    ids.add(p.id);
  }
  return file.prompts;
}

export const trainPrompts = (all: PromptSpec[]) => all.filter((p) => p.split === "train");
export const holdoutPrompts = (all: PromptSpec[]) => all.filter((p) => p.split === "holdout");
```

- [ ] **Step 4: Run to verify PASS** — `bun test tests/prompts.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/prompts.ts tests/prompts.test.ts
git commit -m "feat: prompts loader with train/holdout split"
```

---

### Task 4: Resolver (config → materialized Pi harness)

**Files:**
- Create: `src/config/resolver.ts`
- Test: `tests/resolver.test.ts`

**Interfaces:**
- Consumes: `HarnessConfig` from Task 2.
- Produces:
  ```ts
  type ResolvedHarness = { dir: string; systemPromptPath: string; skillDirs: string[]; piArgs: string[] };
  function resolveHarness(config: HarnessConfig, outDir: string): ResolvedHarness;
  ```
  `piArgs` contains every flag except the user prompt itself: `--print --no-session --no-extensions --no-context-files --no-prompt-templates --model <name> --thinking <level> --tools <csv> --append-system-prompt <systemPromptPath>` plus one `--skill <dir>` per skill.

Design note (locked in spec): **subagents are rendered into the system prompt as mandatory internal passes** (e.g. a `critic` pass the builder must perform before finishing). Plain `pi` has no native subagent spawning without the recipes extension; this keeps runs hermetic while still letting the mutator experiment with multi-role workflows.

- [ ] **Step 1: Write the failing test**

`tests/resolver.test.ts`:
```ts
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHarness } from "../src/config/resolver";
import { BASELINE_CONFIG, type HarnessConfig } from "../src/config/schema";

const cfg: HarnessConfig = {
  ...BASELINE_CONFIG,
  skills: [{ id: "visual-hierarchy", description: "Layout guidance", content: "Use a clear grid." }],
  subagents: [
    { name: "critic", description: "Design critic", system_instructions: "List 3 flaws, then fix them.", tools: ["read"] },
  ],
};

test("materializes system prompt, skills, and pi args", () => {
  const dir = mkdtempSync(join(tmpdir(), "resolve-"));
  const r = resolveHarness(cfg, dir);
  const sys = readFileSync(r.systemPromptPath, "utf8");
  expect(sys).toContain("self-contained HTML");
  expect(sys).toContain("## Internal pass: critic");
  expect(sys).toContain("List 3 flaws");
  const skill = readFileSync(join(dir, "skills", "visual-hierarchy", "SKILL.md"), "utf8");
  expect(skill).toContain("name: visual-hierarchy");
  expect(skill).toContain("Use a clear grid.");
  expect(r.piArgs).toContain("--print");
  expect(r.piArgs).toContain("anthropic/claude-sonnet-4-6");
  expect(r.piArgs.join(" ")).toContain("--skill");
});

test("deterministic: same config twice → identical bytes", () => {
  const a = mkdtempSync(join(tmpdir(), "ra-"));
  const b = mkdtempSync(join(tmpdir(), "rb-"));
  resolveHarness(cfg, a);
  resolveHarness(cfg, b);
  expect(readFileSync(join(a, "system-prompt.md"), "utf8")).toBe(readFileSync(join(b, "system-prompt.md"), "utf8"));
  expect(readdirSync(join(a, "skills")).sort()).toEqual(readdirSync(join(b, "skills")).sort());
});
```

- [ ] **Step 2: Run to verify FAIL** — `bun test tests/resolver.test.ts`

- [ ] **Step 3: Implement**

`src/config/resolver.ts`:
```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessConfig } from "./schema";

export type ResolvedHarness = {
  dir: string;
  systemPromptPath: string;
  skillDirs: string[];
  piArgs: string[];
};

export function resolveHarness(config: HarnessConfig, outDir: string): ResolvedHarness {
  mkdirSync(outDir, { recursive: true });

  const parts: string[] = [config.system_instructions];
  for (const sub of config.subagents) {
    parts.push(
      [
        `## Internal pass: ${sub.name}`,
        `Before finishing, perform this pass as "${sub.name}" (${sub.description}):`,
        sub.system_instructions,
      ].join("\n"),
    );
  }
  const systemPromptPath = join(outDir, "system-prompt.md");
  writeFileSync(systemPromptPath, parts.join("\n\n") + "\n");

  const skillDirs: string[] = [];
  const sortedSkills = [...config.skills].sort((a, b) => a.id.localeCompare(b.id));
  for (const skill of sortedSkills) {
    const dir = join(outDir, "skills", skill.id);
    mkdirSync(dir, { recursive: true });
    const frontmatter = `---\nname: ${skill.id}\ndescription: ${skill.description.replaceAll("\n", " ")}\n---\n\n`;
    writeFileSync(join(dir, "SKILL.md"), frontmatter + skill.content + "\n");
    skillDirs.push(dir);
  }

  const piArgs = [
    "--print",
    "--no-session",
    "--no-extensions",
    "--no-context-files",
    "--no-prompt-templates",
    "--model", config.model.name,
    "--thinking", config.model.thinking_level,
    "--tools", config.tools.join(","),
    "--append-system-prompt", systemPromptPath,
    ...skillDirs.flatMap((d) => ["--skill", d]),
  ];

  return { dir: outDir, systemPromptPath, skillDirs, piArgs };
}
```

- [ ] **Step 4: Run to verify PASS** — `bun test tests/resolver.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/config/resolver.ts tests/resolver.test.ts
git commit -m "feat: deterministic resolver from config genome to pi harness"
```

---

### Task 5: Builder (pi subprocess)

**Files:**
- Create: `src/inner/build.ts`
- Test: `tests/build.test.ts` (uses a stub `pi` shell script via env `PI_BIN`)

**Interfaces:**
- Consumes: `ResolvedHarness` from Task 4, `PromptSpec` from Task 3.
- Produces:
  ```ts
  type BuildResult =
    | { ok: true; htmlPath: string; logPath: string }
    | { ok: false; error: string; logPath: string };
  function buildPage(opts: {
    resolved: ResolvedHarness; prompt: PromptSpec; workspaceDir: string; timeoutMs?: number;
  }): Promise<BuildResult>;
  ```
  Uses `process.env.PI_BIN ?? "pi"`. Stdout+stderr are written to `<workspaceDir>/../build.log`. Success = exit 0 AND `output.html` exists, non-empty, contains `<html` (case-insensitive).

- [ ] **Step 1: Write the failing test**

`tests/build.test.ts`:
```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPage } from "../src/inner/build";
import { resolveHarness } from "../src/config/resolver";
import { BASELINE_CONFIG } from "../src/config/schema";

function stubPi(dir: string, script: string): string {
  const p = join(dir, "pi-stub.sh");
  writeFileSync(p, `#!/bin/bash\n${script}\n`);
  chmodSync(p, 0o755);
  return p;
}
const prompt = { id: "t1", category: "test", split: "train" as const, prompt: "Make a page" };

test("success when stub writes output.html", async () => {
  const base = mkdtempSync(join(tmpdir(), "build-"));
  const ws = join(base, "workspace");
  mkdirSync(ws, { recursive: true });
  process.env.PI_BIN = stubPi(base, `echo '<html><body>hi</body></html>' > output.html`);
  const resolved = resolveHarness(BASELINE_CONFIG, join(base, "resolved"));
  const r = await buildPage({ resolved, prompt, workspaceDir: ws });
  expect(r.ok).toBe(true);
});

test("failure when no output.html", async () => {
  const base = mkdtempSync(join(tmpdir(), "build2-"));
  const ws = join(base, "workspace");
  mkdirSync(ws, { recursive: true });
  process.env.PI_BIN = stubPi(base, `echo did nothing`);
  const resolved = resolveHarness(BASELINE_CONFIG, join(base, "resolved"));
  const r = await buildPage({ resolved, prompt, workspaceDir: ws });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("output.html");
});
```

- [ ] **Step 2: Run to verify FAIL** — `bun test tests/build.test.ts`

- [ ] **Step 3: Implement**

`src/inner/build.ts`:
```ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ResolvedHarness } from "../config/resolver";
import type { PromptSpec } from "../prompts";

export type BuildResult =
  | { ok: true; htmlPath: string; logPath: string }
  | { ok: false; error: string; logPath: string };

const BUILD_INSTRUCTION =
  "Build the landing page described below. Write exactly one self-contained file named output.html " +
  "in the current directory (inline CSS/JS, no external requests). Brief:\n\n";

export async function buildPage(opts: {
  resolved: ResolvedHarness;
  prompt: PromptSpec;
  workspaceDir: string;
  timeoutMs?: number;
}): Promise<BuildResult> {
  const { resolved, prompt, workspaceDir, timeoutMs = 10 * 60 * 1000 } = opts;
  const logPath = join(dirname(workspaceDir), "build.log");
  const bin = process.env.PI_BIN ?? "pi";

  const proc = Bun.spawn([bin, ...resolved.piArgs, BUILD_INSTRUCTION + prompt.prompt], {
    cwd: workspaceDir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  writeFileSync(logPath, `# exit ${exitCode}\n## stdout\n${stdout}\n## stderr\n${stderr}\n`);

  const htmlPath = join(workspaceDir, "output.html");
  if (exitCode !== 0) return { ok: false, error: `pi exited ${exitCode}`, logPath };
  if (!existsSync(htmlPath)) return { ok: false, error: "no output.html produced", logPath };
  const html = readFileSync(htmlPath, "utf8");
  if (html.length < 100 || !/<html/i.test(html)) {
    return { ok: false, error: "output.html invalid or too small", logPath };
  }
  return { ok: true, htmlPath, logPath };
}
```

Note: the success-path stub writes >100 chars? `'<html><body>hi</body></html>'` is 29 chars — adjust the threshold check to `html.length < 20` OR make the stub write a longer body. Use the stub fix: in the test's success stub write `<html><body>` + 200 chars of text. Keep `html.length < 100` in the implementation (real pages are always larger).

- [ ] **Step 4: Run to verify PASS** — `bun test tests/build.test.ts` (after making the success stub emit ≥100 chars).

- [ ] **Step 5: Commit**

```bash
git add src/inner/build.ts tests/build.test.ts
git commit -m "feat: pi subprocess builder with hermetic flags and failure capture"
```

---

### Task 6: Screenshotter

**Files:**
- Create: `src/inner/screenshot.ts`
- Test: `tests/screenshot.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type Screenshots = { desktop: string[]; mobile: string[] };   // scroll-ordered segment paths
  const MAX_SEGMENTS = 8;
  function screenshotPage(htmlPath: string, outDir: string, baseName?: string): Promise<Screenshots>;
  ```
  Desktop 1440×900, mobile 390×844. Instead of one full-page shot, scroll one viewport height per step and capture a viewport-sized PNG per screen: `<outDir>/<baseName>.desktop.<i>.png` / `.mobile.<i>.png`, `i` starting at 0, at most `MAX_SEGMENTS` per viewport. The last segment is bottom-aligned (scroll position clamped to `scrollHeight - viewportHeight`) so there is no blank overshoot. A page shorter than one viewport yields exactly one segment. `baseName` defaults to `"candidate"`. Throws on render failure (caller records it).

- [ ] **Step 1: Write the failing test**

`tests/screenshot.test.ts`:
```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { screenshotPage, MAX_SEGMENTS } from "../src/inner/screenshot";

test("long page yields multiple scroll segments per viewport", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shot-"));
  const html = join(dir, "output.html");
  // ~4 desktop screens tall
  writeFileSync(html, `<html><body style="margin:0"><div style="height:3600px;background:linear-gradient(#0a5,#a05)"><h1>Hello</h1></div></body></html>`);
  const shots = await screenshotPage(html, dir);
  expect(shots.desktop.length).toBeGreaterThanOrEqual(3);
  expect(shots.desktop.length).toBeLessThanOrEqual(MAX_SEGMENTS);
  expect(shots.mobile.length).toBeGreaterThanOrEqual(4);
  expect(shots.desktop[0]).toContain("candidate.desktop.0.png");
  for (const p of [...shots.desktop, ...shots.mobile]) expect(statSync(p).size).toBeGreaterThan(1000);
}, 60000);

test("short page yields exactly one segment per viewport", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shot2-"));
  const html = join(dir, "output.html");
  writeFileSync(html, `<html><body><h1>Tiny</h1></body></html>`);
  const shots = await screenshotPage(html, dir);
  expect(shots.desktop.length).toBe(1);
  expect(shots.mobile.length).toBe(1);
}, 60000);
```

- [ ] **Step 2: Run to verify FAIL** — `bun test tests/screenshot.test.ts`

- [ ] **Step 3: Implement**

`src/inner/screenshot.ts`:
```ts
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

export type Screenshots = { desktop: string[]; mobile: string[] };

export const MAX_SEGMENTS = 8;

const VIEWPORTS = [
  { key: "desktop", width: 1440, height: 900 },
  { key: "mobile", width: 390, height: 844 },
] as const;

export async function screenshotPage(htmlPath: string, outDir: string, baseName = "candidate"): Promise<Screenshots> {
  const browser = await chromium.launch();
  try {
    const out: Record<string, string[]> = { desktop: [], mobile: [] };
    for (const vp of VIEWPORTS) {
      const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load", timeout: 30000 });
      await page.waitForTimeout(500); // settle fonts/animations
      const scrollHeight: number = await page.evaluate(() => document.documentElement.scrollHeight);
      const segments = Math.min(MAX_SEGMENTS, Math.max(1, Math.ceil(scrollHeight / vp.height)));
      for (let i = 0; i < segments; i++) {
        const y = Math.min(i * vp.height, Math.max(0, scrollHeight - vp.height)); // bottom-align last segment
        await page.evaluate((top) => window.scrollTo(0, top), y);
        await page.waitForTimeout(150); // let scroll-triggered rendering settle
        const path = join(outDir, `${baseName}.${vp.key}.${i}.png`);
        await page.screenshot({ path }); // viewport-sized, NOT fullPage
        out[vp.key].push(path);
      }
      await page.close();
    }
    return { desktop: out.desktop, mobile: out.mobile };
  } finally {
    await browser.close();
  }
}
```

- [ ] **Step 4: Run to verify PASS** — `bun test tests/screenshot.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/inner/screenshot.ts tests/screenshot.test.ts
git commit -m "feat: playwright screenshotter with per-viewport scroll segments"
```

---

### Task 7: LLM helper (forced tool call with retries)

**Files:**
- Create: `src/llm.ts`
- Test: `tests/llm.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface LlmClient { messages: { create(params: Record<string, unknown>): Promise<{ content: Array<{ type: string; name?: string; input?: unknown }> }> } }
  function realClient(): LlmClient;                       // wraps new Anthropic()
  function forcedToolCall<T>(client: LlmClient, opts: {
    model: string; system?: string; content: unknown[];   // Anthropic content blocks
    toolName: string; description: string; zodSchema: z.ZodType<T>; maxRetries?: number; maxTokens?: number;
  }): Promise<T>;
  function imageBlock(pngPath: string): unknown;          // base64 image content block
  ```
  On zod-parse failure or missing tool_use block: retry up to `maxRetries` (default 2), appending the validation error as an extra user turn. Exhausted → throw.

- [ ] **Step 1: Write the failing test**

`tests/llm.test.ts`:
```ts
import { expect, test } from "bun:test";
import { z } from "zod";
import { forcedToolCall, type LlmClient } from "../src/llm";

const schema = z.object({ score: z.number().min(0).max(10) });

function fakeClient(responses: unknown[]): LlmClient {
  let i = 0;
  return { messages: { create: async () => ({ content: responses[i++] as any }) } };
}

test("parses a valid tool call", async () => {
  const client = fakeClient([[{ type: "tool_use", name: "grade", input: { score: 7 } }]]);
  const r = await forcedToolCall(client, {
    model: "m", content: [{ type: "text", text: "grade it" }],
    toolName: "grade", description: "d", zodSchema: schema,
  });
  expect(r.score).toBe(7);
});

test("retries on invalid then succeeds", async () => {
  const client = fakeClient([
    [{ type: "tool_use", name: "grade", input: { score: 99 } }],
    [{ type: "tool_use", name: "grade", input: { score: 5 } }],
  ]);
  const r = await forcedToolCall(client, {
    model: "m", content: [{ type: "text", text: "grade it" }],
    toolName: "grade", description: "d", zodSchema: schema,
  });
  expect(r.score).toBe(5);
});

test("throws after retries exhausted", async () => {
  const bad = [{ type: "tool_use", name: "grade", input: { score: 99 } }];
  const client = fakeClient([bad, bad, bad]);
  await expect(
    forcedToolCall(client, {
      model: "m", content: [{ type: "text", text: "x" }],
      toolName: "grade", description: "d", zodSchema: schema, maxRetries: 2,
    }),
  ).rejects.toThrow();
});
```

- [ ] **Step 2: Run to verify FAIL** — `bun test tests/llm.test.ts`

- [ ] **Step 3: Implement**

`src/llm.ts`:
```ts
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { z } from "zod";

export interface LlmClient {
  messages: {
    create(params: Record<string, unknown>): Promise<{ content: Array<{ type: string; name?: string; input?: unknown }> }>;
  };
}

export function realClient(): LlmClient {
  return new Anthropic() as unknown as LlmClient;
}

export function imageBlock(pngPath: string): unknown {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: readFileSync(pngPath).toString("base64") },
  };
}

export async function forcedToolCall<T>(
  client: LlmClient,
  opts: {
    model: string;
    system?: string;
    content: unknown[];
    toolName: string;
    description: string;
    zodSchema: z.ZodType<T>;
    maxRetries?: number;
    maxTokens?: number;
  },
): Promise<T> {
  const { maxRetries = 2, maxTokens = 8192 } = opts;
  const jsonSchema = z.toJSONSchema(opts.zodSchema);
  const messages: Array<{ role: string; content: unknown }> = [{ role: "user", content: opts.content }];
  let lastError = "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      messages.push({
        role: "user",
        content: [{ type: "text", text: `Previous tool input was invalid: ${lastError}. Call ${opts.toolName} again with corrected input.` }],
      });
    }
    const res = await client.messages.create({
      model: opts.model,
      max_tokens: maxTokens,
      ...(opts.system ? { system: opts.system } : {}),
      messages,
      tools: [{ name: opts.toolName, description: opts.description, input_schema: jsonSchema }],
      tool_choice: { type: "tool", name: opts.toolName },
    });
    const block = res.content.find((b) => b.type === "tool_use" && b.name === opts.toolName);
    if (!block) { lastError = "no tool_use block returned"; continue; }
    const parsed = opts.zodSchema.safeParse(block.input);
    if (parsed.success) return parsed.data;
    lastError = parsed.error.message;
  }
  throw new Error(`forcedToolCall(${opts.toolName}) failed after ${maxRetries + 1} attempts: ${lastError}`);
}
```

- [ ] **Step 4: Run to verify PASS** — `bun test tests/llm.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/llm.ts tests/llm.test.ts
git commit -m "feat: schema-forced tool call helper with retry"
```

---

### Task 8: Evaluator + rubric

**Files:**
- Create: `src/inner/evaluate.ts`, `src/eval/rubric.md`
- Test: `tests/evaluate.test.ts`

**Interfaces:**
- Consumes: `forcedToolCall`, `imageBlock`, `LlmClient` (Task 7); `PromptSpec` (Task 3); `Screenshots` (Task 6).
- Produces:
  ```ts
  const EvalResultSchema: z.ZodType<EvalResult>;
  type EvalResult = {
    subscores: { hierarchy: number; typography: number; spacing: number; color_contrast: number; requirement_coverage: number; polish: number }; // each 0-10
    overall: number;                       // 0-100
    vs_reference: "behind" | "on_par" | "ahead";
    diff_dimensions: string[];
    critique: string;
  };
  function evaluatePage(opts: {
    client: LlmClient; model: string; prompt: PromptSpec;
    candidate: Screenshots; referenceDesktopPngs: string[];
  }): Promise<EvalResult>;
  ```
  Image budget per call: all candidate desktop segments (≤8, scroll order, each labeled "Candidate desktop — screen i+1/N"), the first 3 candidate mobile segments, and the first 4 reference desktop segments (labeled as reference). Default model resolution happens in callers: `process.env.EVAL_MODEL ?? "claude-opus-4-8"`.

- [ ] **Step 1: Write rubric**

`src/eval/rubric.md`:
```markdown
# Landing Page UI/UX Rubric

Score each dimension 0-10:

- **hierarchy** — Clear visual hierarchy: obvious primary message, scannable sections, sensible reading order.
- **typography** — Type scale, pairing, line length, weight contrast; no default-browser look.
- **spacing** — Consistent rhythm, breathing room, aligned grid; no cramped or floaty regions.
- **color_contrast** — Cohesive palette, sufficient text contrast (WCAG-ish), intentional accent usage.
- **requirement_coverage** — Every must-include item from the brief is present and functional-looking.
- **polish** — Overall craft: imagery/placeholder quality, component consistency, micro-details (buttons, cards, footer).

**overall (0-100):** weighted judgment, NOT a straight sum. requirement_coverage is a gate: if any required
section is missing, overall must not exceed 50 regardless of visual quality. A generic bootstrap-looking page
that covers everything sits around 50-60. Reserve 85+ for pages that would pass as a real product's site.

**vs_reference:** compare the candidate against the provided reference screenshot for the same brief:
`behind`, `on_par`, or `ahead`, and list the dimensions where they differ in diff_dimensions.

**critique:** 2-4 sentences: the single biggest weakness and the most impactful concrete improvement.
```

- [ ] **Step 2: Write the failing test**

`tests/evaluate.test.ts`:
```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePage, EvalResultSchema } from "../src/inner/evaluate";
import type { LlmClient } from "../src/llm";

const png = (dir: string, name: string) => {
  const p = join(dir, name);
  // 1x1 png
  writeFileSync(p, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  return p;
};

const valid = {
  subscores: { hierarchy: 7, typography: 6, spacing: 7, color_contrast: 8, requirement_coverage: 9, polish: 6 },
  overall: 68, vs_reference: "behind", diff_dimensions: ["typography"], critique: "Weak type scale.",
};

test("returns parsed eval and sends capped image segments + rubric", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eval-"));
  let captured: any;
  const client: LlmClient = {
    messages: { create: async (params) => { captured = params; return { content: [{ type: "tool_use", name: "submit_evaluation", input: valid }] }; } },
  };
  const r = await evaluatePage({
    client, model: "test-model",
    prompt: { id: "p", category: "c", split: "train", prompt: "Landing page for X. Must include: hero." },
    candidate: {
      desktop: [png(dir, "d0.png"), png(dir, "d1.png")],
      mobile: [png(dir, "m0.png"), png(dir, "m1.png"), png(dir, "m2.png"), png(dir, "m3.png")], // 4 → capped to 3
    },
    referenceDesktopPngs: [png(dir, "r0.png"), png(dir, "r1.png"), png(dir, "r2.png"), png(dir, "r3.png"), png(dir, "r4.png")], // 5 → capped to 4
  });
  expect(r.overall).toBe(68);
  expect(EvalResultSchema.parse(r)).toEqual(valid as any);
  const text = JSON.stringify(captured.messages);
  expect(text).toContain("requirement_coverage");           // rubric included
  expect(text).toContain("screen 1/2");                     // segment labeling
  const images = captured.messages[0].content.filter((b: any) => b.type === "image");
  expect(images.length).toBe(2 + 3 + 4);                     // desktop + capped mobile + capped reference
});
```

- [ ] **Step 3: Run to verify FAIL** — `bun test tests/evaluate.test.ts`

- [ ] **Step 4: Implement**

`src/inner/evaluate.ts`:
```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { forcedToolCall, imageBlock, type LlmClient } from "../llm";
import type { PromptSpec } from "../prompts";
import type { Screenshots } from "./screenshot";

const sub = z.number().min(0).max(10);
export const EvalResultSchema = z.object({
  subscores: z.object({
    hierarchy: sub, typography: sub, spacing: sub,
    color_contrast: sub, requirement_coverage: sub, polish: sub,
  }),
  overall: z.number().min(0).max(100),
  vs_reference: z.enum(["behind", "on_par", "ahead"]),
  diff_dimensions: z.array(z.string()),
  critique: z.string().min(1),
});
export type EvalResult = z.infer<typeof EvalResultSchema>;

const RUBRIC = readFileSync(join(import.meta.dir, "../eval/rubric.md"), "utf8");

const MAX_MOBILE = 3;
const MAX_REFERENCE = 4;

export async function evaluatePage(opts: {
  client: LlmClient;
  model: string;
  prompt: PromptSpec;
  candidate: Screenshots;
  referenceDesktopPngs: string[];
}): Promise<EvalResult> {
  const content: unknown[] = [
    { type: "text", text: `You are a strict design reviewer.\n\n${RUBRIC}\n\n## Brief\n${opts.prompt.prompt}` },
    { type: "text", text: "Screenshots are scrolled viewport segments in top-to-bottom order." },
  ];
  const desktop = opts.candidate.desktop;
  desktop.forEach((p, i) => {
    content.push({ type: "text", text: `Candidate desktop — screen ${i + 1}/${desktop.length}:` }, imageBlock(p));
  });
  const mobile = opts.candidate.mobile.slice(0, MAX_MOBILE);
  mobile.forEach((p, i) => {
    content.push({ type: "text", text: `Candidate mobile — screen ${i + 1}/${mobile.length}:` }, imageBlock(p));
  });
  const refs = opts.referenceDesktopPngs.slice(0, MAX_REFERENCE);
  refs.forEach((p, i) => {
    content.push({ type: "text", text: `Reference page for the same brief, desktop — screen ${i + 1}/${refs.length}:` }, imageBlock(p));
  });
  content.push({ type: "text", text: "Evaluate the candidate per the rubric and call submit_evaluation." });

  return forcedToolCall(opts.client, {
    model: opts.model,
    toolName: "submit_evaluation",
    description: "Submit the structured rubric evaluation of the candidate landing page.",
    zodSchema: EvalResultSchema,
    content,
  });
}
```

- [ ] **Step 5: Run to verify PASS** — `bun test tests/evaluate.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/inner/evaluate.ts src/eval/rubric.md tests/evaluate.test.ts
git commit -m "feat: opus vision evaluator with fixed rubric and reference comparison"
```

---

### Task 9: Run store (persistence layout)

**Files:**
- Create: `src/store/run-store.ts`
- Test: `tests/run-store.test.ts`

**Interfaces:**
- Consumes: `HarnessConfig` (Task 2), `EvalResult` (Task 8).
- Produces:
  ```ts
  type HistoryEntry = { iteration: number; config_version: number; mean_overall: number; best_version: number; best_score: number };
  type PromptOutcome = { prompt_id: string; status: "ok" | "build_failed" | "screenshot_failed" | "eval_failed"; overall: number; eval?: EvalResult; error?: string };
  type IterationSummary = {
    iteration: number; config_version: number; mean_overall: number;
    outcomes: PromptOutcome[]; dimension_means: Record<string, number>; mutator_rationale?: string;
  };
  class RunStore {
    constructor(runsDir: string, runId: string);
    initRun(meta: Record<string, unknown>): void;           // writes run.json, mkdir -p
    saveConfig(cfg: HarnessConfig): void;                    // configs/v<N>.json
    loadConfig(version: number): HarnessConfig;
    listConfigVersions(): number[];
    nextConfigVersion(): number;                             // max + 1
    iterationDir(n: number): string;                         // …/iterations/<n>, mkdir -p
    promptDir(n: number, promptId: string): string;          // …/prompts/<id>/workspace created
    saveSummary(s: IterationSummary): void;
    loadSummaries(): IterationSummary[];
    appendHistory(e: HistoryEntry): void;                    // history.jsonl
    readHistory(): HistoryEntry[];
    bestVersion(): { version: number; score: number };       // from history; falls back to {0, -1}
    completedIterations(): number[];                         // iterations with summary.json
  }
  ```

- [ ] **Step 1: Write the failing test**

`tests/run-store.test.ts`:
```ts
import { expect, test } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../src/store/run-store";
import { BASELINE_CONFIG } from "../src/config/schema";

test("full store lifecycle", () => {
  const dir = mkdtempSync(join(tmpdir(), "store-"));
  const s = new RunStore(dir, "run1");
  s.initRun({ note: "test" });
  expect(existsSync(join(dir, "run1", "run.json"))).toBe(true);

  s.saveConfig(BASELINE_CONFIG);
  expect(s.loadConfig(0)).toEqual(BASELINE_CONFIG);
  expect(s.nextConfigVersion()).toBe(1);

  const pd = s.promptDir(1, "saas-crm");
  expect(existsSync(join(pd, "workspace"))).toBe(true);

  s.saveSummary({ iteration: 1, config_version: 0, mean_overall: 55, outcomes: [], dimension_means: {} });
  s.appendHistory({ iteration: 1, config_version: 0, mean_overall: 55, best_version: 0, best_score: 55 });
  s.appendHistory({ iteration: 2, config_version: 1, mean_overall: 61, best_version: 1, best_score: 61 });
  expect(s.bestVersion()).toEqual({ version: 1, score: 61 });
  expect(s.completedIterations()).toEqual([1]);
  expect(s.readHistory().length).toBe(2);
});
```

- [ ] **Step 2: Run to verify FAIL** — `bun test tests/run-store.test.ts`

- [ ] **Step 3: Implement**

`src/store/run-store.ts`:
```ts
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessConfigSchema, type HarnessConfig } from "../config/schema";
import type { EvalResult } from "../inner/evaluate";

export type HistoryEntry = {
  iteration: number; config_version: number; mean_overall: number; best_version: number; best_score: number;
};
export type PromptOutcome = {
  prompt_id: string;
  status: "ok" | "build_failed" | "screenshot_failed" | "eval_failed";
  overall: number;
  eval?: EvalResult;
  error?: string;
};
export type IterationSummary = {
  iteration: number; config_version: number; mean_overall: number;
  outcomes: PromptOutcome[]; dimension_means: Record<string, number>; mutator_rationale?: string;
};

export class RunStore {
  readonly root: string;
  constructor(runsDir: string, runId: string) {
    this.root = join(runsDir, runId);
  }
  initRun(meta: Record<string, unknown>): void {
    mkdirSync(join(this.root, "configs"), { recursive: true });
    mkdirSync(join(this.root, "iterations"), { recursive: true });
    if (!existsSync(join(this.root, "run.json"))) {
      writeFileSync(join(this.root, "run.json"), JSON.stringify({ started_at: new Date().toISOString(), ...meta }, null, 2));
    }
  }
  saveConfig(cfg: HarnessConfig): void {
    writeFileSync(join(this.root, "configs", `v${cfg.version}.json`), JSON.stringify(cfg, null, 2));
  }
  loadConfig(version: number): HarnessConfig {
    return HarnessConfigSchema.parse(JSON.parse(readFileSync(join(this.root, "configs", `v${version}.json`), "utf8")));
  }
  listConfigVersions(): number[] {
    return readdirSync(join(this.root, "configs"))
      .map((f) => Number(f.match(/^v(\d+)\.json$/)?.[1]))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
  }
  nextConfigVersion(): number {
    const vs = this.listConfigVersions();
    return vs.length ? Math.max(...vs) + 1 : 0;
  }
  iterationDir(n: number): string {
    const d = join(this.root, "iterations", String(n));
    mkdirSync(d, { recursive: true });
    return d;
  }
  promptDir(n: number, promptId: string): string {
    const d = join(this.iterationDir(n), "prompts", promptId);
    mkdirSync(join(d, "workspace"), { recursive: true });
    return d;
  }
  saveSummary(s: IterationSummary): void {
    writeFileSync(join(this.iterationDir(s.iteration), "summary.json"), JSON.stringify(s, null, 2));
  }
  loadSummaries(): IterationSummary[] {
    return this.completedIterations().map((n) =>
      JSON.parse(readFileSync(join(this.root, "iterations", String(n), "summary.json"), "utf8")),
    );
  }
  appendHistory(e: HistoryEntry): void {
    appendFileSync(join(this.root, "history.jsonl"), JSON.stringify(e) + "\n");
  }
  readHistory(): HistoryEntry[] {
    const p = join(this.root, "history.jsonl");
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  bestVersion(): { version: number; score: number } {
    const h = this.readHistory();
    if (!h.length) return { version: 0, score: -1 };
    const best = h.reduce((a, b) => (b.mean_overall > a.mean_overall ? b : a));
    return { version: best.config_version, score: best.mean_overall };
  }
  completedIterations(): number[] {
    const dir = join(this.root, "iterations");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map(Number)
      .filter((n) => Number.isFinite(n) && existsSync(join(dir, String(n), "summary.json")))
      .sort((a, b) => a - b);
  }
}
```

- [ ] **Step 4: Run to verify PASS** — `bun test tests/run-store.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/store/run-store.ts tests/run-store.test.ts
git commit -m "feat: run store for configs, iterations, history"
```

---

### Task 10: Aggregation

**Files:**
- Create: `src/outer/aggregate.ts`
- Test: `tests/aggregate.test.ts`

**Interfaces:**
- Consumes: `PromptOutcome`, `IterationSummary` (Task 9).
- Produces:
  ```ts
  function aggregate(iteration: number, configVersion: number, outcomes: PromptOutcome[]): IterationSummary;
  ```
  Rules: `mean_overall` averages `overall` across outcomes EXCLUDING `eval_failed` (build/screenshot failures count as 0 and are included); `dimension_means` averages subscores across `status === "ok"` outcomes only; empty ok-set → `dimension_means = {}`.

- [ ] **Step 1: Write the failing test**

`tests/aggregate.test.ts`:
```ts
import { expect, test } from "bun:test";
import { aggregate } from "../src/outer/aggregate";
import type { PromptOutcome } from "../src/store/run-store";

const ok = (id: string, overall: number, hierarchy: number): PromptOutcome => ({
  prompt_id: id, status: "ok", overall,
  eval: {
    subscores: { hierarchy, typography: 5, spacing: 5, color_contrast: 5, requirement_coverage: 5, polish: 5 },
    overall, vs_reference: "on_par", diff_dimensions: [], critique: "c",
  },
});

test("means: failures are 0, eval_failed excluded", () => {
  const s = aggregate(3, 7, [
    ok("a", 80, 8),
    ok("b", 60, 6),
    { prompt_id: "c", status: "build_failed", overall: 0, error: "no html" },
    { prompt_id: "d", status: "eval_failed", overall: 0, error: "api" },
  ]);
  expect(s.iteration).toBe(3);
  expect(s.config_version).toBe(7);
  expect(s.mean_overall).toBeCloseTo((80 + 60 + 0) / 3);
  expect(s.dimension_means.hierarchy).toBeCloseTo(7);
});
```

- [ ] **Step 2: Run to verify FAIL** — `bun test tests/aggregate.test.ts`

- [ ] **Step 3: Implement**

`src/outer/aggregate.ts`:
```ts
import type { IterationSummary, PromptOutcome } from "../store/run-store";

export function aggregate(iteration: number, configVersion: number, outcomes: PromptOutcome[]): IterationSummary {
  const scored = outcomes.filter((o) => o.status !== "eval_failed");
  const mean_overall = scored.length ? scored.reduce((s, o) => s + o.overall, 0) / scored.length : 0;

  const oks = outcomes.filter((o) => o.status === "ok" && o.eval);
  const dimension_means: Record<string, number> = {};
  if (oks.length) {
    const keys = Object.keys(oks[0]!.eval!.subscores) as Array<keyof PromptOutcome["eval"] extends never ? never : any>;
    for (const k of keys) {
      dimension_means[k] = oks.reduce((s, o) => s + (o.eval!.subscores as any)[k], 0) / oks.length;
    }
  }
  return { iteration, config_version: configVersion, mean_overall, outcomes, dimension_means };
}
```

- [ ] **Step 4: Run to verify PASS** — `bun test tests/aggregate.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/outer/aggregate.ts tests/aggregate.test.ts
git commit -m "feat: iteration aggregation with failure semantics"
```

---

### Task 11: Mutator

**Files:**
- Create: `src/outer/mutate.ts`
- Test: `tests/mutate.test.ts`

**Interfaces:**
- Consumes: `forcedToolCall`, `LlmClient` (Task 7); `HarnessConfig`, `HarnessConfigSchema` (Task 2); `IterationSummary`, `HistoryEntry` (Task 9).
- Produces:
  ```ts
  function mutateConfig(opts: {
    client: LlmClient; model: string;
    bestConfig: HarnessConfig;                   // elitist anchor
    latestSummary: IterationSummary;
    history: HistoryEntry[];
    pastRationales: Array<{ version: number; rationale: string; mean_overall: number | null }>;
    nextVersion: number;
  }): Promise<HarnessConfig>;
  ```
  The returned config MUST have `version === nextVersion` and `parent_version === bestConfig.version` — enforced after the LLM call by overwriting those two fields, then re-validating with `HarnessConfigSchema`.

- [ ] **Step 1: Write the failing test**

`tests/mutate.test.ts`:
```ts
import { expect, test } from "bun:test";
import { mutateConfig } from "../src/outer/mutate";
import { BASELINE_CONFIG } from "../src/config/schema";
import type { LlmClient } from "../src/llm";

test("returns validated config with pinned version fields", async () => {
  const proposal = { ...BASELINE_CONFIG, version: 999, parent_version: 42, rationale: "Add typography skill", system_instructions: BASELINE_CONFIG.system_instructions + "\nUse a modular type scale." };
  let captured: any;
  const client: LlmClient = {
    messages: { create: async (p) => { captured = p; return { content: [{ type: "tool_use", name: "propose_config", input: proposal }] }; } },
  };
  const next = await mutateConfig({
    client, model: "m", bestConfig: BASELINE_CONFIG,
    latestSummary: { iteration: 1, config_version: 0, mean_overall: 52, outcomes: [], dimension_means: { typography: 4.1 } },
    history: [{ iteration: 1, config_version: 0, mean_overall: 52, best_version: 0, best_score: 52 }],
    pastRationales: [{ version: 0, rationale: "baseline", mean_overall: 52 }],
    nextVersion: 5,
  });
  expect(next.version).toBe(5);
  expect(next.parent_version).toBe(0);
  const sent = JSON.stringify(captured.messages);
  expect(sent).toContain("typography");        // summary reached the prompt
  expect(sent).toContain("baseline");          // history reached the prompt
});
```

- [ ] **Step 2: Run to verify FAIL** — `bun test tests/mutate.test.ts`

- [ ] **Step 3: Implement**

`src/outer/mutate.ts`:
```ts
import { forcedToolCall, type LlmClient } from "../llm";
import { HarnessConfigSchema, type HarnessConfig } from "../config/schema";
import type { HistoryEntry, IterationSummary } from "../store/run-store";

const MUTATOR_SYSTEM = `You are a harness engineer optimizing an AI coding agent's configuration so it produces
better-designed landing pages. You may change: system_instructions, skills (add/edit/remove markdown skill
documents), subagents (internal review passes), tools, model thinking_level. Make ONE focused, well-motivated
change per proposal — a targeted hypothesis, not a rewrite. Ground it in the evaluation critiques and the
weakest rubric dimensions. Avoid repeating past changes that did not improve the score.`;

export async function mutateConfig(opts: {
  client: LlmClient;
  model: string;
  bestConfig: HarnessConfig;
  latestSummary: IterationSummary;
  history: HistoryEntry[];
  pastRationales: Array<{ version: number; rationale: string; mean_overall: number | null }>;
  nextVersion: number;
}): Promise<HarnessConfig> {
  const critiques = opts.latestSummary.outcomes
    .filter((o) => o.eval)
    .map((o) => `- ${o.prompt_id} (${o.overall}, ${o.eval!.vs_reference}): ${o.eval!.critique}`)
    .join("\n");
  const failures = opts.latestSummary.outcomes
    .filter((o) => o.status !== "ok")
    .map((o) => `- ${o.prompt_id}: ${o.status} ${o.error ?? ""}`)
    .join("\n");

  const proposal = await forcedToolCall(opts.client, {
    model: opts.model,
    system: MUTATOR_SYSTEM,
    toolName: "propose_config",
    description: "Propose the complete next harness configuration.",
    zodSchema: HarnessConfigSchema,
    maxTokens: 16384,
    content: [
      {
        type: "text",
        text: [
          `## Current best config (version ${opts.bestConfig.version}, derive your proposal from this)`,
          JSON.stringify(opts.bestConfig, null, 2),
          `## Latest iteration summary (config v${opts.latestSummary.config_version}, mean ${opts.latestSummary.mean_overall.toFixed(1)})`,
          `Dimension means: ${JSON.stringify(opts.latestSummary.dimension_means)}`,
          `Per-prompt critiques:\n${critiques || "(none)"}`,
          failures ? `Failures:\n${failures}` : "",
          `## Score history`,
          opts.history.map((h) => `iter ${h.iteration}: v${h.config_version} → ${h.mean_overall.toFixed(1)} (best v${h.best_version}=${h.best_score.toFixed(1)})`).join("\n"),
          `## Past change rationales`,
          opts.pastRationales.map((r) => `v${r.version} (${r.mean_overall ?? "unscored"}): ${r.rationale}`).join("\n"),
          `Propose the next config now. Include a specific rationale explaining the hypothesis.`,
        ].filter(Boolean).join("\n\n"),
      },
    ],
  });

  return HarnessConfigSchema.parse({
    ...proposal,
    version: opts.nextVersion,
    parent_version: opts.bestConfig.version,
  });
}
```

- [ ] **Step 4: Run to verify PASS** — `bun test tests/mutate.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/outer/mutate.ts tests/mutate.test.ts
git commit -m "feat: schema-constrained config mutator with elitist anchoring"
```

---

### Task 12: Inner-loop pipeline (build → screenshot → evaluate per prompt)

**Files:**
- Create: `src/inner/pipeline.ts`, `src/util/concurrency.ts`
- Test: `tests/pipeline.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–9.
- Produces:
  ```ts
  function pLimit(n: number): <T>(fn: () => Promise<T>) => Promise<T>;   // src/util/concurrency.ts
  function runPromptPipeline(opts: {
    resolved: ResolvedHarness; prompt: PromptSpec; promptDir: string;    // from RunStore.promptDir
    client: LlmClient; evalModel: string; referenceDir: string;          // runs/reference
  }): Promise<PromptOutcome>;
  ```
  Also produces `referenceSegments(referenceDir: string, promptId: string): string[]` — all `<referenceDir>/<promptId>.desktop.<i>.png` paths sorted by segment index (exported for reuse by holdout/orchestrator).
  Steps: `buildPage` (workspace = `<promptDir>/workspace`) → on failure return `build_failed`; `screenshotPage(htmlPath, promptDir)` → on throw return `screenshot_failed`; `evaluatePage` with `referenceDesktopPngs = referenceSegments(...)`, retried internally by `forcedToolCall` → on throw return `eval_failed`; success writes `<promptDir>/eval.json` and returns `ok` with `overall`.

- [ ] **Step 1: Write the failing test**

`tests/pipeline.test.ts`:
```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPromptPipeline } from "../src/inner/pipeline";
import { pLimit } from "../src/util/concurrency";
import { resolveHarness } from "../src/config/resolver";
import { BASELINE_CONFIG } from "../src/config/schema";
import type { LlmClient } from "../src/llm";

const PAGE = `<html><body><h1>Test page</h1>${"<p>content</p>".repeat(30)}</body></html>`;
const EVAL = {
  subscores: { hierarchy: 6, typography: 6, spacing: 6, color_contrast: 6, requirement_coverage: 8, polish: 5 },
  overall: 62, vs_reference: "behind", diff_dimensions: [], critique: "fine",
};

function setup() {
  const base = mkdtempSync(join(tmpdir(), "pipe-"));
  const stub = join(base, "pi.sh");
  writeFileSync(stub, `#!/bin/bash\ncat > /dev/null <<'EOF'\nEOF\nprintf '%s' '${PAGE}' > output.html\n`);
  chmodSync(stub, 0o755);
  process.env.PI_BIN = stub;
  const refDir = join(base, "reference");
  mkdirSync(refDir, { recursive: true });
  const png1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  writeFileSync(join(refDir, "t1.desktop.0.png"), png1);
  writeFileSync(join(refDir, "t1.desktop.1.png"), png1);
  const promptDir = join(base, "p", "t1");
  mkdirSync(join(promptDir, "workspace"), { recursive: true });
  const client: LlmClient = { messages: { create: async () => ({ content: [{ type: "tool_use", name: "submit_evaluation", input: EVAL }] }) } };
  return { base, refDir, promptDir, client };
}

test("happy path produces ok outcome with eval.json", async () => {
  const { refDir, promptDir, client } = setup();
  const resolved = resolveHarness(BASELINE_CONFIG, join(promptDir, "resolved"));
  const out = await runPromptPipeline({
    resolved, prompt: { id: "t1", category: "c", split: "train", prompt: "x" },
    promptDir, client, evalModel: "m", referenceDir: refDir,
  });
  expect(out.status).toBe("ok");
  expect(out.overall).toBe(62);
}, 60000);

test("pLimit caps concurrency", async () => {
  const limit = pLimit(2);
  let active = 0, peak = 0;
  await Promise.all(
    Array.from({ length: 6 }, () =>
      limit(async () => {
        active++; peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
      }),
    ),
  );
  expect(peak).toBeLessThanOrEqual(2);
});
```

- [ ] **Step 2: Run to verify FAIL** — `bun test tests/pipeline.test.ts`

- [ ] **Step 3: Implement**

`src/util/concurrency.ts`:
```ts
export function pLimit(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= n || queue.length === 0) return;
    active++;
    queue.shift()!();
  };
  return <T>(fn: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => fn().then(resolve, reject).finally(() => { active--; next(); }));
      next();
    });
}
```

`src/inner/pipeline.ts`:
```ts
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedHarness } from "../config/resolver";
import type { PromptSpec } from "../prompts";
import type { LlmClient } from "../llm";
import type { PromptOutcome } from "../store/run-store";
import { buildPage } from "./build";
import { screenshotPage } from "./screenshot";
import { evaluatePage } from "./evaluate";

export function referenceSegments(referenceDir: string, promptId: string): string[] {
  const re = new RegExp(`^${promptId}\\.desktop\\.(\\d+)\\.png$`);
  return readdirSync(referenceDir)
    .map((f) => ({ f, m: f.match(re) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(a.m![1]) - Number(b.m![1]))
    .map((x) => join(referenceDir, x.f));
}

export async function runPromptPipeline(opts: {
  resolved: ResolvedHarness;
  prompt: PromptSpec;
  promptDir: string;
  client: LlmClient;
  evalModel: string;
  referenceDir: string;
}): Promise<PromptOutcome> {
  const { prompt, promptDir } = opts;

  const build = await buildPage({ resolved: opts.resolved, prompt, workspaceDir: join(promptDir, "workspace") });
  if (!build.ok) return { prompt_id: prompt.id, status: "build_failed", overall: 0, error: build.error };

  let shots;
  try {
    shots = await screenshotPage(build.htmlPath, promptDir);
  } catch (e) {
    return { prompt_id: prompt.id, status: "screenshot_failed", overall: 0, error: String(e) };
  }

  try {
    const refs = referenceSegments(opts.referenceDir, prompt.id);
    if (!refs.length) {
      return { prompt_id: prompt.id, status: "eval_failed", overall: 0, error: "no reference segments found" };
    }
    const evalResult = await evaluatePage({
      client: opts.client,
      model: opts.evalModel,
      prompt,
      candidate: shots,
      referenceDesktopPngs: refs,
    });
    writeFileSync(join(promptDir, "eval.json"), JSON.stringify(evalResult, null, 2));
    return { prompt_id: prompt.id, status: "ok", overall: evalResult.overall, eval: evalResult };
  } catch (e) {
    return { prompt_id: prompt.id, status: "eval_failed", overall: 0, error: String(e) };
  }
}
```

- [ ] **Step 4: Run to verify PASS** — `bun test tests/pipeline.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/inner/pipeline.ts src/util/concurrency.ts tests/pipeline.test.ts
git commit -m "feat: per-prompt build/screenshot/evaluate pipeline with pLimit"
```

---

### Task 13: Reference generator

**Files:**
- Create: `src/reference/build-reference.ts`
- Test: `tests/reference.test.ts` (stubbed PI_BIN, real Playwright)

**Interfaces:**
- Consumes: Tasks 2–6.
- Produces:
  ```ts
  const REFERENCE_CONFIG: HarnessConfig;   // Opus, thinking high, richer fixed design instructions; NOT part of the search
  function buildReferenceSet(opts: {
    prompts: PromptSpec[]; referenceDir: string; concurrency?: number; force?: boolean;
  }): Promise<{ built: string[]; skipped: string[]; failed: Array<{ id: string; error: string }> }>;
  function assertReferencesExist(prompts: PromptSpec[], referenceDir: string): void; // throws listing missing ids
  ```
  Per prompt: skip if `<id>.desktop.0.png` exists (unless `force`); otherwise build into `<referenceDir>/.work/<id>/workspace`, screenshot with `baseName = prompt.id` directly into `referenceDir` (yielding `<id>.desktop.<i>.png` / `<id>.mobile.<i>.png` segments), and copy `output.html` to `<referenceDir>/<id>.html`.

- [ ] **Step 1: Write the failing test**

`tests/reference.test.ts`:
```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReferenceSet, assertReferencesExist } from "../src/reference/build-reference";

const PAGE = `<html><body><h1>Ref</h1>${"<p>content</p>".repeat(30)}</body></html>`;

test("builds and caches reference pages, skips existing", async () => {
  const base = mkdtempSync(join(tmpdir(), "ref-"));
  const stub = join(base, "pi.sh");
  writeFileSync(stub, `#!/bin/bash\nprintf '%s' '${PAGE}' > output.html\n`);
  chmodSync(stub, 0o755);
  process.env.PI_BIN = stub;
  const refDir = join(base, "reference");
  const prompts = [{ id: "r1", category: "c", split: "train" as const, prompt: "x" }];

  const first = await buildReferenceSet({ prompts, referenceDir: refDir });
  expect(first.built).toEqual(["r1"]);
  expect(existsSync(join(refDir, "r1.desktop.0.png"))).toBe(true);
  expect(existsSync(join(refDir, "r1.html"))).toBe(true);

  const second = await buildReferenceSet({ prompts, referenceDir: refDir });
  expect(second.skipped).toEqual(["r1"]);

  expect(() => assertReferencesExist(prompts, refDir)).not.toThrow();
  expect(() => assertReferencesExist([{ id: "missing", category: "c", split: "train", prompt: "x" }], refDir)).toThrow("missing");
}, 120000);
```

- [ ] **Step 2: Run to verify FAIL** — `bun test tests/reference.test.ts`

- [ ] **Step 3: Implement**

`src/reference/build-reference.ts`:
```ts
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { BASELINE_CONFIG, type HarnessConfig } from "../config/schema";
import { resolveHarness } from "../config/resolver";
import { buildPage } from "../inner/build";
import { screenshotPage } from "../inner/screenshot";
import { pLimit } from "../util/concurrency";
import type { PromptSpec } from "../prompts";

export const REFERENCE_CONFIG: HarnessConfig = {
  ...BASELINE_CONFIG,
  rationale: "Fixed reference harness — not part of the search space.",
  model: { name: "anthropic/claude-opus-4-8", thinking_level: "high" },
  system_instructions: [
    BASELINE_CONFIG.system_instructions,
    "You are the reference standard: produce the best landing page you possibly can.",
    "Invest in typography (real type scale), a cohesive palette, generous consistent spacing,",
    "distinctive hero treatment, and polished components. Take your time; quality over speed.",
  ].join("\n"),
};

export async function buildReferenceSet(opts: {
  prompts: PromptSpec[];
  referenceDir: string;
  concurrency?: number;
  force?: boolean;
}): Promise<{ built: string[]; skipped: string[]; failed: Array<{ id: string; error: string }> }> {
  const { prompts, referenceDir, concurrency = 3, force = false } = opts;
  mkdirSync(referenceDir, { recursive: true });
  const resolved = resolveHarness(REFERENCE_CONFIG, join(referenceDir, ".work", "resolved"));
  const limit = pLimit(concurrency);
  const built: string[] = [], skipped: string[] = [], failed: Array<{ id: string; error: string }> = [];

  await Promise.all(
    prompts.map((prompt) =>
      limit(async () => {
        if (!force && existsSync(join(referenceDir, `${prompt.id}.desktop.0.png`))) {
          skipped.push(prompt.id);
          return;
        }
        const ws = join(referenceDir, ".work", prompt.id, "workspace");
        mkdirSync(ws, { recursive: true });
        const r = await buildPage({ resolved, prompt, workspaceDir: ws });
        if (!r.ok) { failed.push({ id: prompt.id, error: r.error }); return; }
        try {
          await screenshotPage(r.htmlPath, referenceDir, prompt.id);
          copyFileSync(r.htmlPath, join(referenceDir, `${prompt.id}.html`));
          built.push(prompt.id);
        } catch (e) {
          failed.push({ id: prompt.id, error: String(e) });
        }
      }),
    ),
  );
  return { built, skipped, failed };
}

export function assertReferencesExist(prompts: PromptSpec[], referenceDir: string): void {
  const missing = prompts.filter((p) => !existsSync(join(referenceDir, `${p.id}.desktop.0.png`))).map((p) => p.id);
  if (missing.length) throw new Error(`missing reference screenshots: ${missing.join(", ")} — run \`bun run reference\` first`);
}
```

- [ ] **Step 4: Run to verify PASS** — `bun test tests/reference.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/reference/build-reference.ts tests/reference.test.ts
git commit -m "feat: one-time reference set generator with fixed opus harness"
```

---

### Task 14: Orchestrator + CLI

**Files:**
- Create: `src/orchestrator.ts`, `src/cli.ts`
- Test: `tests/orchestrator.test.ts` (full fake iteration: stub PI_BIN + fake LlmClient, real Playwright/store)

**Interfaces:**
- Consumes: everything above.
- Produces:
  ```ts
  // src/orchestrator.ts
  function runLoop(opts: {
    store: RunStore; prompts: PromptSpec[];          // TRAIN prompts only — caller filters
    iterations: number; concurrency: number;
    client: LlmClient; evalModel: string; referenceDir: string;
    startIteration?: number;                          // resume support, default = last completed + 1
  }): Promise<void>;
  function runHoldout(opts: {
    store: RunStore; prompts: PromptSpec[];          // HOLDOUT prompts
    configVersion: number; concurrency: number;
    client: LlmClient; evalModel: string; referenceDir: string; outDir: string;
  }): Promise<IterationSummary>;
  ```
  `runLoop` per iteration N: ensure config v exists (iteration 1 seeds `BASELINE_CONFIG` if `configs/` empty; otherwise use the version proposed by the previous mutation, recorded as the latest saved config); resolve into `iterations/<N>/resolved/`; write `config-version.txt`; run all prompts via `runPromptPipeline` under `pLimit(concurrency)`; `aggregate`; mutate from `bestVersion()`s config (after updating history with this iteration); save proposal via `saveConfig`; `saveSummary` (with `mutator_rationale`); `appendHistory`. Mutation failure after retries: persist everything done so far, then throw (run is resumable).

- [ ] **Step 1: Write the failing test**

`tests/orchestrator.test.ts`:
```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoop, runHoldout } from "../src/orchestrator";
import { RunStore } from "../src/store/run-store";
import { BASELINE_CONFIG } from "../src/config/schema";
import type { LlmClient } from "../src/llm";

const PAGE = `<html><body><h1>P</h1>${"<p>c</p>".repeat(40)}</body></html>`;
const EVAL = {
  subscores: { hierarchy: 6, typography: 6, spacing: 6, color_contrast: 6, requirement_coverage: 8, polish: 5 },
  overall: 62, vs_reference: "behind", diff_dimensions: [], critique: "ok",
};
const PNG1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function fakeClient(): LlmClient {
  return {
    messages: {
      create: async (params: any) => {
        const isMutate = JSON.stringify(params.tools).includes("propose_config");
        if (isMutate) {
          return { content: [{ type: "tool_use", name: "propose_config", input: { ...BASELINE_CONFIG, rationale: "tweak", version: 0, parent_version: null } }] };
        }
        return { content: [{ type: "tool_use", name: "submit_evaluation", input: EVAL }] };
      },
    },
  };
}

function setup() {
  const base = mkdtempSync(join(tmpdir(), "orch-"));
  const stub = join(base, "pi.sh");
  writeFileSync(stub, `#!/bin/bash\nprintf '%s' '${PAGE}' > output.html\n`);
  chmodSync(stub, 0o755);
  process.env.PI_BIN = stub;
  const refDir = join(base, "reference");
  mkdirSync(refDir, { recursive: true });
  for (const id of ["a", "b", "h1"]) writeFileSync(join(refDir, `${id}.desktop.0.png`), PNG1);
  const store = new RunStore(join(base, "runs"), "test-run");
  store.initRun({});
  return { base, refDir, store };
}
const P = (id: string, split: "train" | "holdout") => ({ id, category: "c", split, prompt: "make page " + id });

test("two iterations: configs, summaries, history, best tracking", async () => {
  const { refDir, store } = setup();
  await runLoop({
    store, prompts: [P("a", "train"), P("b", "train")], iterations: 2, concurrency: 2,
    client: fakeClient(), evalModel: "m", referenceDir: refDir,
  });
  expect(store.completedIterations()).toEqual([1, 2]);
  expect(store.readHistory().length).toBe(2);
  expect(store.listConfigVersions()).toEqual([0, 1, 2]);   // baseline + 2 proposals
  expect(store.bestVersion().score).toBeCloseTo(62);
  const s = store.loadSummaries()[0];
  expect(s.mutator_rationale).toBe("tweak");
  expect(existsSync(join(store.root, "iterations", "1", "config-version.txt"))).toBe(true);
}, 120000);

test("holdout writes report without touching history", async () => {
  const { refDir, store, base } = setup();
  await runLoop({
    store, prompts: [P("a", "train")], iterations: 1, concurrency: 1,
    client: fakeClient(), evalModel: "m", referenceDir: refDir,
  });
  const before = store.readHistory().length;
  const summary = await runHoldout({
    store, prompts: [P("h1", "holdout")], configVersion: 0, concurrency: 1,
    client: fakeClient(), evalModel: "m", referenceDir: refDir, outDir: join(base, "runs", "test-run", "holdout", "t1"),
  });
  expect(summary.mean_overall).toBeCloseTo(62);
  expect(store.readHistory().length).toBe(before);          // unchanged
}, 120000);
```

- [ ] **Step 2: Run to verify FAIL** — `bun test tests/orchestrator.test.ts`

- [ ] **Step 3: Implement**

`src/orchestrator.ts`:
```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASELINE_CONFIG } from "./config/schema";
import { resolveHarness } from "./config/resolver";
import { runPromptPipeline } from "./inner/pipeline";
import { aggregate } from "./outer/aggregate";
import { mutateConfig } from "./outer/mutate";
import { pLimit } from "./util/concurrency";
import type { LlmClient } from "./llm";
import type { PromptSpec } from "./prompts";
import type { RunStore, IterationSummary } from "./store/run-store";

export async function runLoop(opts: {
  store: RunStore;
  prompts: PromptSpec[];
  iterations: number;
  concurrency: number;
  client: LlmClient;
  evalModel: string;
  referenceDir: string;
  startIteration?: number;
}): Promise<void> {
  const { store, prompts, client, evalModel, referenceDir, concurrency } = opts;
  if (prompts.some((p) => p.split !== "train")) throw new Error("runLoop accepts train prompts only");

  if (store.listConfigVersions().length === 0) store.saveConfig(BASELINE_CONFIG);
  const completed = store.completedIterations();
  const start = opts.startIteration ?? (completed.length ? Math.max(...completed) + 1 : 1);

  for (let iter = start; iter < start + opts.iterations; iter++) {
    // The config to evaluate this iteration: the newest saved config (last mutation's proposal, or baseline).
    const versions = store.listConfigVersions();
    const configVersion = Math.max(...versions);
    const config = store.loadConfig(configVersion);

    const iterDir = store.iterationDir(iter);
    writeFileSync(join(iterDir, "config-version.txt"), String(configVersion));
    const resolved = resolveHarness(config, join(iterDir, "resolved"));

    console.log(`[iter ${iter}] config v${configVersion} — building ${prompts.length} prompts…`);
    const limit = pLimit(concurrency);
    const outcomes = await Promise.all(
      prompts.map((prompt) =>
        limit(() =>
          runPromptPipeline({
            resolved, prompt, promptDir: store.promptDir(iter, prompt.id),
            client, evalModel, referenceDir,
          }).then((o) => { console.log(`[iter ${iter}] ${prompt.id}: ${o.status} ${o.overall}`); return o; }),
        ),
      ),
    );

    const summary = aggregate(iter, configVersion, outcomes);
    const prevBest = store.bestVersion();
    store.appendHistory({
      iteration: iter,
      config_version: configVersion,
      mean_overall: summary.mean_overall,
      best_version: summary.mean_overall > prevBest.score ? configVersion : prevBest.version,
      best_score: Math.max(summary.mean_overall, prevBest.score),
    });

    const best = store.bestVersion();
    const bestConfig = store.loadConfig(best.version);
    const historyEntries = store.readHistory();
    const pastRationales = store.listConfigVersions().map((v) => {
      const c = store.loadConfig(v);
      const scored = historyEntries.find((h) => h.config_version === v);
      return { version: v, rationale: c.rationale, mean_overall: scored ? scored.mean_overall : null };
    });

    console.log(`[iter ${iter}] mean ${summary.mean_overall.toFixed(1)} (best v${best.version}=${best.score.toFixed(1)}) — mutating…`);
    const next = await mutateConfig({
      client, model: evalModel, bestConfig, latestSummary: summary,
      history: historyEntries, pastRationales, nextVersion: store.nextConfigVersion(),
    });
    store.saveConfig(next);
    summary.mutator_rationale = next.rationale;
    store.saveSummary(summary);
  }
}

export async function runHoldout(opts: {
  store: RunStore;
  prompts: PromptSpec[];
  configVersion: number;
  concurrency: number;
  client: LlmClient;
  evalModel: string;
  referenceDir: string;
  outDir: string;
}): Promise<IterationSummary> {
  const config = opts.store.loadConfig(opts.configVersion);
  mkdirSync(opts.outDir, { recursive: true });
  const resolved = resolveHarness(config, join(opts.outDir, "resolved"));
  const limit = pLimit(opts.concurrency);
  const outcomes = await Promise.all(
    opts.prompts.map((prompt) =>
      limit(() => {
        const promptDir = join(opts.outDir, "prompts", prompt.id);
        mkdirSync(join(promptDir, "workspace"), { recursive: true });
        return runPromptPipeline({
          resolved, prompt, promptDir,
          client: opts.client, evalModel: opts.evalModel, referenceDir: opts.referenceDir,
        });
      }),
    ),
  );
  const summary = aggregate(0, opts.configVersion, outcomes);
  writeFileSync(join(opts.outDir, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}
```

`src/cli.ts`:
```ts
import { parseArgs } from "node:util";
import { join } from "node:path";
import { loadPrompts, trainPrompts, holdoutPrompts } from "./prompts";
import { RunStore } from "./store/run-store";
import { realClient } from "./llm";
import { runLoop, runHoldout } from "./orchestrator";
import { buildReferenceSet, assertReferencesExist } from "./reference/build-reference";

const RUNS_DIR = "runs";
const REFERENCE_DIR = join(RUNS_DIR, "reference");
const EVAL_MODEL = process.env.EVAL_MODEL ?? "claude-opus-4-8";

const [command] = Bun.argv.slice(2);
const { values } = parseArgs({
  args: Bun.argv.slice(3),
  options: {
    iterations: { type: "string", default: "5" },
    "run-id": { type: "string" },
    concurrency: { type: "string", default: "5" },
    version: { type: "string" },
    force: { type: "boolean", default: false },
  },
});

const all = loadPrompts();
const concurrency = Number(values.concurrency);

async function main() {
  switch (command) {
    case "reference": {
      const r = await buildReferenceSet({ prompts: all, referenceDir: REFERENCE_DIR, concurrency, force: values.force });
      console.log(`built: ${r.built.length}, skipped: ${r.skipped.length}, failed: ${r.failed.length}`);
      for (const f of r.failed) console.error(`  FAILED ${f.id}: ${f.error}`);
      if (r.failed.length) process.exit(1);
      break;
    }
    case "loop":
    case "resume": {
      const runId = values["run-id"] ?? `run-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`;
      if (command === "resume" && !values["run-id"]) throw new Error("resume requires --run-id");
      const train = trainPrompts(all);
      assertReferencesExist(train, REFERENCE_DIR);
      const store = new RunStore(RUNS_DIR, runId);
      store.initRun({ eval_model: EVAL_MODEL, concurrency });
      console.log(`run: ${runId}`);
      await runLoop({
        store, prompts: train, iterations: Number(values.iterations), concurrency,
        client: realClient(), evalModel: EVAL_MODEL, referenceDir: REFERENCE_DIR,
      });
      const best = store.bestVersion();
      console.log(`done. best config: v${best.version} (mean ${best.score.toFixed(1)})`);
      break;
    }
    case "holdout": {
      if (!values["run-id"]) throw new Error("holdout requires --run-id");
      const store = new RunStore(RUNS_DIR, values["run-id"]);
      const holdout = holdoutPrompts(all);
      assertReferencesExist(holdout, REFERENCE_DIR);
      const version = values.version ? Number(values.version) : store.bestVersion().version;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const summary = await runHoldout({
        store, prompts: holdout, configVersion: version, concurrency,
        client: realClient(), evalModel: EVAL_MODEL, referenceDir: REFERENCE_DIR,
        outDir: join(store.root, "holdout", stamp),
      });
      console.log(`holdout mean for v${version}: ${summary.mean_overall.toFixed(1)}`);
      break;
    }
    default:
      console.error("usage: bun src/cli.ts <reference|loop|resume|holdout> [options]");
      process.exit(1);
  }
}
main();
```

- [ ] **Step 4: Run to verify PASS** — `bun test tests/orchestrator.test.ts`, then full suite `bun test`.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.ts src/cli.ts tests/orchestrator.test.ts
git commit -m "feat: outer loop orchestrator, resume, holdout, CLI"
```

---

### Task 15: Real smoke run + docs polish

**Files:**
- Modify: `README.md` (fill in anything learned)
- No new source files.

Manual verification (needs `ANTHROPIC_API_KEY` exported and real `pi` on PATH):

- [ ] **Step 1: Type-check everything**

Run: `bunx tsc --noEmit` — Expected: no errors.

- [ ] **Step 2: Reference smoke (2 prompts)**

Temporarily verify with a trimmed prompt file: copy `prompts.json` to `runs/smoke-prompts.json` with only `saas-crm` + `holdout-proptech`, then run `bun src/cli.ts reference` pointed at it by editing nothing — instead just run the real thing for all prompts if cost is acceptable, or run:
```bash
PI_BIN=pi bun run reference
```
Expected: `runs/reference/<id>.desktop.0.png` for every prompt id; inspect 2-3 PNGs by eye.

- [ ] **Step 3: One-iteration loop smoke**

```bash
bun run loop --iterations 1 --run-id smoke --concurrency 3
```
Expected: `runs/smoke/iterations/1/` populated (html, pngs, eval.json per prompt), `history.jsonl` with 1 line, `configs/v0.json` + `configs/v1.json`, console shows mean score and mutation rationale.

- [ ] **Step 4: Holdout smoke**

```bash
bun run holdout --run-id smoke
```
Expected: holdout mean printed; `runs/smoke/holdout/<ts>/summary.json` exists; `history.jsonl` unchanged.

- [ ] **Step 5: Update README with any corrected usage, commit**

```bash
git add README.md
git commit -m "docs: verified usage after smoke run"
```

---

## Self-review notes

- **Spec coverage:** repo reset (T1), genome schema (T2), prompts+split discipline (T3, enforced again in `runLoop`'s train-only guard and CLI wiring), resolver determinism (T4), builder contract+hermetic flags (T5), dual-viewport screenshots (T6), forced-tool-call plumbing (T7), rubric+evaluator with reference image (T8), persistence layout (T9), failure semantics in means (T10), elitist-anchor mutator (T11), pipeline-not-barrier inner loop with bounded concurrency (T12), one-time cached reference set with startup assertion (T13), orchestrator/resume/holdout/CLI (T14), real smoke (T15).
- **Known deviation from spec, locked here:** subagents materialize as mandatory internal passes in the system prompt (plain `pi` has no hermetic subagent spawning); spec's intent (mutator can experiment with multi-role workflows) is preserved.
- **Type consistency:** `PromptOutcome`/`IterationSummary`/`HistoryEntry` defined once in Task 9 and imported everywhere; `Screenshots` from Task 6; `ResolvedHarness` from Task 4.
