export type ApiContextWorkspaceKind = "isolated" | "explicit" | "configured";
export type PromptFormat = "transcript" | "minimal";

function buildApiContextGuardText(
  workspaceKind: ApiContextWorkspaceKind = "configured",
): string {
  const parts = [
  "You are being called through an OpenAI-compatible API bridge.",
    "Treat cached Cursor session state, prior projects, global Cursor rules, and the bridge server process as implementation details, not as user-provided context.",
    "Use only the active workspace for this request plus content explicitly included in the API messages. Do not assume any other cwd, repository, files, or prior Cursor state.",
    "Never reveal, quote, or reason from bridge-only temporary paths such as /tmp/cursor-* or /tmp/cursor-api-proxy-workspace.",
  ];

  if (workspaceKind === "isolated") {
    parts.push(
      "This request is running in an isolated temporary workspace for safety; it is not the caller's project directory and may be empty.",
      "If the user asks about this/current directory without supplying a path, file list, or explicit workspace, explain that no project directory was provided instead of describing the temporary bridge directory.",
    );
  } else if (workspaceKind === "explicit") {
    parts.push(
      "The API request supplied an explicit active workspace for this run. If the user asks about this/current directory, inspect that active workspace.",
      "Refer to it as the active workspace unless the user explicitly supplied or asked for the absolute path.",
    );
  } else {
    parts.push(
      "A configured active workspace exists on the proxy host for this run. If the user asks about this/current directory, you may inspect that active workspace.",
      "Do not present the proxy process cwd or stale cached Cursor project state as the user's local shell cwd.",
    );
  }

  return parts.join(" ");
}

export type OpenAiChatCompletionRequest = {
  model?: string;
  /** Cursor CLI mode override: agent | ask | plan */
  mode?: string;
  /** Optional proxy-host workspace path for this request. */
  workspace?: string;
  /** Alias for workspace; useful for clients that naturally pass cwd metadata. */
  cwd?: string;
  /** Optional metadata bag; `metadata.cwd` and `metadata.workspace` are recognized. */
  metadata?: Record<string, unknown>;
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
  opts: {
    apiContextGuard?: boolean;
    workspaceKind?: ApiContextWorkspaceKind;
    promptFormat?: PromptFormat;
  } = {},
): string {
  const systemParts: string[] = opts.apiContextGuard
    ? [buildApiContextGuardText(opts.workspaceKind)]
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

  if (opts.promptFormat === "minimal" && !opts.apiContextGuard) {
    if (systemParts.length === 0 && convo.length === 1) {
      const only = convo[0];
      if (only.startsWith("User: ")) return only.slice("User: ".length);
    }

    const parts: string[] = [];
    if (systemParts.length > 0) {
      parts.push(`[System]\n${systemParts.join("\n\n")}`);
    }
    for (const line of convo) {
      const idx = line.indexOf(": ");
      const role = idx >= 0 ? line.slice(0, idx) : "User";
      const text = idx >= 0 ? line.slice(idx + 2) : line;
      parts.push(`[${role}]\n${text}`);
    }
    return parts.join("\n\n");
  }

  const system = systemParts.length
    ? `System:\n${systemParts.join("\n\n")}\n\n`
    : "";
  const transcript = convo.join("\n\n");
  const apiContextReminder = opts.apiContextGuard
    ? "\n\nSystem reminder: Use the active workspace selected for this request when file inspection is requested. Do not disclose bridge-only temporary paths or rely on stale Cursor workspace state."
    : "";
  return system + transcript + apiContextReminder + "\n\nAssistant:";
}
