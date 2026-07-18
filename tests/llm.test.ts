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
