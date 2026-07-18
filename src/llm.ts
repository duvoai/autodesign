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
