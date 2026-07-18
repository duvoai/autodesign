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
