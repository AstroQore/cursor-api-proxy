export const API_CONTEXT_GUARD_TEXT = [
  "You are being called through an OpenAI-compatible API bridge.",
  "Treat the bridge server process, Cursor runtime, workspace, cwd, and any cached Cursor session state as implementation details, not as the user's project context.",
  "Do not assume the user's current working directory, repository, files, rules, or prior Cursor state unless they are explicitly included in this API request.",
  "Never reveal, quote, or reason from bridge workspace paths such as /tmp/cursor-* or /tmp/cursor-api-proxy-workspace.",
  "If asked about the current working directory, repository, or local files and they were not provided in the request messages, answer that the API request did not provide that information.",
].join(" ");

export type OpenAiChatCompletionRequest = {
  model?: string;
  /** Cursor CLI mode override: agent | ask | plan */
  mode?: string;
  messages: any[];
  stream?: boolean;
  tools?: any[];
  tool_choice?: any;
  functions?: any[];
  function_call?: any;
};

export function normalizeModelId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || undefined;
}

function imageUrlToText(imageUrl: any): string {
  if (!imageUrl) return "[Image]";
  const url: string =
    typeof imageUrl === "string"
      ? imageUrl
      : typeof imageUrl?.url === "string"
        ? imageUrl.url
        : "";
  if (!url) return "[Image]";
  if (url.startsWith("data:")) {
    const mime = url.slice(5, url.indexOf(";")) || "image";
    return `[Image: base64 ${mime}]`;
  }
  return `[Image: ${url}]`;
}

function messageContentToText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (!p) return "";
        if (typeof p === "string") return p;
        if (p.type === "text" && typeof p.text === "string") return p.text;
        if (p.type === "image_url") return imageUrlToText(p.image_url);
        if (p.type === "image") return imageUrlToText(p.source?.url ?? p.url ?? p.source);
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

/**
 * Serialise tool/function schemas into a text block for the system prompt.
 * This allows the model to be aware of available tools even though we can't
 * return tool_call deltas natively.
 */
export function toolsToSystemText(
  tools?: any[],
  functions?: any[],
): string | undefined {
  const defs: any[] = [];

  if (tools && tools.length > 0) {
    for (const t of tools) {
      const fn = t?.type === "function" ? t.function : t;
      if (fn) defs.push(fn);
    }
  }
  if (functions && functions.length > 0) {
    defs.push(...functions);
  }

  if (defs.length === 0) return undefined;

  const lines = [
    "Available tools (respond with a JSON object to call one):",
    "",
    ...defs.map((fn) => {
      const params = fn.parameters
        ? JSON.stringify(fn.parameters, null, 2)
        : "{}";
      return `Function: ${fn.name}\nDescription: ${fn.description ?? ""}\nParameters: ${params}`;
    }),
  ];
  return lines.join("\n");
}

export function buildPromptFromMessages(
  messages: any[],
  opts: { apiContextGuard?: boolean } = {},
): string {
  const systemParts: string[] = opts.apiContextGuard
    ? [API_CONTEXT_GUARD_TEXT]
    : [];
  const convo: string[] = [];

  for (const m of messages || []) {
    const role = m?.role;
    const text = messageContentToText(m?.content);
    if (!text) continue;

    if (role === "system" || role === "developer") {
      systemParts.push(text);
      continue;
    }
    if (role === "user") {
      convo.push(`User: ${text}`);
      continue;
    }
    if (role === "assistant") {
      convo.push(`Assistant: ${text}`);
      continue;
    }
    if (role === "tool" || role === "function") {
      convo.push(`Tool: ${text}`);
      continue;
    }
  }

  const system = systemParts.length
    ? `System:\n${systemParts.join("\n\n")}\n\n`
    : "";
  const transcript = convo.join("\n\n");
  const apiContextReminder = opts.apiContextGuard
    ? "\n\nSystem reminder: The bridge workspace/cwd is not the user's working directory. Do not disclose bridge workspace paths. If the user did not provide a cwd, repository, or file contents in this API request, say that information is unavailable."
    : "";
  return system + transcript + apiContextReminder + "\n\nAssistant:";
}
