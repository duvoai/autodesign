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
