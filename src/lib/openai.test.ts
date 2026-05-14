import { describe, it, expect } from "vitest";
import {
  normalizeModelId,
  buildPromptFromMessages,
  toolsToSystemText,
  type OpenAiChatCompletionRequest,
} from "./openai.js";

describe("normalizeModelId", () => {
  it("returns last part after slash for org/model format", () => {
    expect(normalizeModelId("org/cursor/model-id")).toBe("model-id");
  });

  it("returns model as-is when no slash", () => {
    expect(normalizeModelId("claude-3-opus")).toBe("claude-3-opus");
  });

  it("returns undefined for empty string", () => {
    expect(normalizeModelId("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only string", () => {
    expect(normalizeModelId("   ")).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(normalizeModelId(undefined)).toBeUndefined();
  });

  it("trims leading/trailing whitespace", () => {
    expect(normalizeModelId("  claude-3  ")).toBe("claude-3");
  });
});

describe("buildPromptFromMessages", () => {
  it("builds prompt from user and assistant messages", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "How are you?" },
    ];
    const prompt = buildPromptFromMessages(messages);
    expect(prompt).toBe(
      "User: Hello\n\nAssistant: Hi there\n\nUser: How are you?\n\nAssistant:",
    );
  });

  it("prepends system message", () => {
    const messages = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
    ];
    const prompt = buildPromptFromMessages(messages);
    expect(prompt).toBe("System:\nYou are helpful.\n\nUser: Hi\n\nAssistant:");
  });

  it("can prepend an API context guard before request system messages", () => {
    const messages = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
    ];
    const prompt = buildPromptFromMessages(messages, { apiContextGuard: true });
    expect(prompt).toContain("OpenAI-compatible API bridge");
    expect(prompt).toContain("Do not assume the user's current working directory");
    expect(prompt).toContain(
      "Never reveal, quote, or reason from bridge workspace paths",
    );
    expect(prompt).toContain(
      "System reminder: The bridge workspace/cwd is not the user's working directory",
    );
    expect(prompt.indexOf("OpenAI-compatible API bridge")).toBeLessThan(
      prompt.indexOf("You are helpful."),
    );
    expect(prompt.indexOf("System reminder:")).toBeGreaterThan(
      prompt.indexOf("User: Hi"),
    );
    expect(prompt).toContain("User: Hi");
  });

  it("joins multiple system messages with double newline", () => {
    const messages = [
      { role: "system", content: "First rule" },
      { role: "system", content: "Second rule" },
      { role: "user", content: "Hi" },
    ];
    const prompt = buildPromptFromMessages(messages);
    expect(prompt).toContain("First rule\n\nSecond rule");
  });

  it("handles developer role like system", () => {
    const messages = [
      { role: "developer", content: "Dev instructions" },
      { role: "user", content: "Hello" },
    ];
    const prompt = buildPromptFromMessages(messages);
    expect(prompt).toContain("System:\nDev instructions");
  });

  it("handles tool/function messages", () => {
    const messages = [
      { role: "user", content: "Use the calculator" },
      { role: "tool", content: "42" },
    ];
    const prompt = buildPromptFromMessages(messages);
    expect(prompt).toContain("Tool: 42");
  });

  it("handles array content (multimodal) with image placeholder", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this" },
          {
            type: "image_url",
            image_url: { url: "https://example.com/img.png" },
          },
        ],
      },
    ];
    const prompt = buildPromptFromMessages(messages);
    expect(prompt).toContain("Describe this");
    expect(prompt).toContain("[Image: https://example.com/img.png]");
  });

  it("includes base64 image placeholder without leaking data", () => {
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "data:image/jpeg;base64,/9j/..." },
          },
        ],
      },
    ];
    const prompt = buildPromptFromMessages(messages);
    expect(prompt).toContain("[Image: base64 image/jpeg]");
    expect(prompt).not.toContain("/9j/");
  });

  it("handles empty messages", () => {
    const prompt = buildPromptFromMessages([]);
    expect(prompt).toBe("\n\nAssistant:");
  });

  it("handles undefined messages", () => {
    const prompt = buildPromptFromMessages(undefined as unknown as any[]);
    expect(prompt).toBe("\n\nAssistant:");
  });

  it("skips messages with empty content", () => {
    const messages = [
      { role: "user", content: "" },
      { role: "user", content: "Hello" },
    ];
    const prompt = buildPromptFromMessages(messages);
    expect(prompt).toBe("User: Hello\n\nAssistant:");
  });
});

describe("toolsToSystemText", () => {
  it("returns undefined when no tools or functions", () => {
    expect(toolsToSystemText()).toBeUndefined();
    expect(toolsToSystemText([], [])).toBeUndefined();
  });

  it("serialises tools array into readable text", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get current weather",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    const result = toolsToSystemText(tools);
    expect(result).toBeDefined();
    expect(result).toContain("get_weather");
    expect(result).toContain("Get current weather");
    expect(result).toContain("Available tools");
  });

  it("serialises legacy functions array", () => {
    const functions = [
      { name: "add", description: "Add two numbers", parameters: {} },
    ];
    const result = toolsToSystemText(undefined, functions);
    expect(result).toContain("add");
    expect(result).toContain("Add two numbers");
  });

  it("merges tools and functions together", () => {
    const tools = [
      { type: "function", function: { name: "foo", description: "foo fn" } },
    ];
    const functions = [{ name: "bar", description: "bar fn" }];
    const result = toolsToSystemText(tools, functions);
    expect(result).toContain("foo");
    expect(result).toContain("bar");
  });
});
