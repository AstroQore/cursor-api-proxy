/**
 * ACP (Agent Client Protocol) client for Cursor CLI.
 * Spawns `agent acp` and communicates via JSON-RPC over stdio.
 * See https://cursor.com/docs/cli/acp and https://agentclientprotocol.com/
 */

import * as readline from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { debuglog } from "node:util";

import { trackChildProcess } from "./process.js";

const debugAcp = debuglog("cursor-api-proxy:acp");

export type AcpRunOptions = {
  cwd: string;
  /** Stable cwd for the long-lived ACP child. Defaults to cwd for one-shot runs. */
  processCwd?: string;
  timeoutMs: number;
  env?: Record<string, string | undefined>;
  /** When set, call session/set_config_option for "model" after session/new (ACP session config). */
  model?: string;
  /** Per-request timeout in ms (default 60000). Rejects and clears pending on timeout. */
  requestTimeoutMs?: number;
  /** Spawn options (e.g. windowsVerbatimArguments for cmd.exe fallback on Windows). */
  spawnOptions?: { windowsVerbatimArguments?: boolean };
  /** When true, skip authenticate step (use when pre-authenticated via --api-key or agent login). */
  skipAuthenticate?: boolean;
  /** When true, log every raw JSON-RPC line from ACP stdout (very verbose). */
  rawDebug?: boolean;
  /** When aborted, the ACP child is killed (same as CLI path). */
  signal?: AbortSignal;
};

export type AcpSyncResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type AcpStreamResult = {
  code: number;
  stderr: string;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** Avoid passing the entire parent environment into ACP children (may contain unrelated secrets). */
function buildAcpSpawnEnv(
  extra?: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const inheritKeys = [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "USERNAME",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMDATA",
    "PUBLIC",
    "NODE_OPTIONS",
  ];
  const out: NodeJS.ProcessEnv = {};
  for (const k of inheritKeys) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}

type AcpParsedMsg = {
  id?: number;
  method?: string;
  params?: { update?: { sessionUpdate?: string; content?: { text?: string } } };
  result?: unknown;
  error?: { message?: string };
};

/** Normalise CRLF / stray CR so JSON-RPC lines parse on Windows (avoids silent hangs). */
function parseAcpStdoutLine(line: string): AcpParsedMsg | null {
  const t = line.replace(/\r$/, "").trim();
  if (!t) return null;
  try {
    return JSON.parse(t) as AcpParsedMsg;
  } catch {
    return null;
  }
}

/**
 * Handle ACP server→client notifications (session/update chunks, permissions, cursor/*).
 * Returns true if the message was consumed as a notification.
 */
function handleAcpNotification(
  msg: AcpParsedMsg,
  opts: {
    rawDebug?: boolean;
    stdin: NodeJS.WritableStream | null | undefined;
    onAgentTextChunk?: (text: string) => void;
  },
): boolean {
  if (msg.method === "session/update") {
    const update = (msg.params?.update ?? msg.params) as {
      sessionUpdate?: string;
      content?: { text?: string } | Array<{ content?: { text?: string }; text?: string }>;
    } | undefined;
    const content = update?.content;
    const text =
      typeof content === "object" && content !== null && !Array.isArray(content) && typeof (content as { text?: string }).text === "string"
        ? (content as { text: string }).text
        : Array.isArray(content)
          ? content
              .map((c: { content?: { text?: string }; text?: string }) =>
                typeof c?.content?.text === "string"
                  ? c.content.text
                  : typeof c?.text === "string"
                    ? c.text
                    : "",
              )
              .join("")
          : "";
    const sessionUpdate = update?.sessionUpdate;
    if (
      (sessionUpdate === "agent_message_chunk" || sessionUpdate === "agent_thought_chunk") &&
      text
    ) {
      opts.onAgentTextChunk?.(text);
    } else if (
      sessionUpdate &&
      sessionUpdate !== "agent_thought_chunk" &&
      sessionUpdate !== "available_commands_update" &&
      sessionUpdate !== "tool_call" &&
      sessionUpdate !== "tool_call_update"
    ) {
      debugAcp(
        "session/update (unhandled): %s",
        JSON.stringify({
          sessionUpdate,
          hasContent: !!content,
          contentKeys: content && typeof content === "object" && !Array.isArray(content) ? Object.keys(content) : [],
        }),
      );
    }
    return true;
  }

  if (msg.method === "session/request_permission") {
    if (msg.id != null && opts.stdin) {
      respond(opts.stdin, msg.id, {
        outcome: { outcome: "selected", optionId: "reject-once" },
      });
    }
    return true;
  }

  if (msg.id != null && msg.method && opts.stdin) {
    const method = String(msg.method);
    if (method.startsWith("cursor/")) {
      const params = msg.params as Record<string, unknown> | undefined;
      if (method === "cursor/ask_question" && params?.options && Array.isArray(params.options)) {
        const options = params.options as Array<{ id?: string; label?: string }>;
        const first = options[0];
        console.warn(
          "[cursor-api-proxy:acp] cursor/ask_question auto-selecting first option: id=%s (total=%d)",
          first?.id ?? "(none)",
          options.length,
        );
        respond(opts.stdin, msg.id, { selectedId: first?.id ?? "" });
      } else if (method === "cursor/create_plan") {
        respond(opts.stdin, msg.id, { approved: true });
      } else {
        console.warn(
          "[cursor-api-proxy:acp] auto-responding to unknown %s with empty result",
          method,
        );
        respond(opts.stdin, msg.id, {});
      }
      return true;
    }
  }

  return false;
}

export type AcpAvailableModel = { modelId: string; name: string };

/**
 * Map OpenAI-style display name to Cursor ACP `modelId` (e.g. `composer-2` → `composer-2[fast=true]`).
 * If `availableModels` is missing or empty, returns `displayName` unchanged.
 * If the list is non-empty but no row matches `name`, logs via debug and falls back to session default.
 * Duplicate `name` entries: first match wins.
 */
export function resolveAcpModelConfigValue(
  displayName: string,
  availableModels: AcpAvailableModel[] | undefined,
): string {
  if (!availableModels?.length) return displayName;
  const hit = availableModels.find((m) => m.name === displayName);
  if (!hit) {
    debugAcp(
      "ACP model: no catalog match for display name %j; falling back to default[]",
      displayName,
    );
    return "default[]";
  }
  return hit.modelId;
}

function sendRequest(
  stdin: NodeJS.WritableStream,
  nextId: { current: number },
  method: string,
  params: object,
  pending: Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timerId?: ReturnType<typeof setTimeout> }
  >,
  requestTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  const id = nextId.current++;
  const line =
    JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  stdin.write(line, "utf8");
  return new Promise((resolve, reject) => {
    let timerId: ReturnType<typeof setTimeout> | undefined;
    if (requestTimeoutMs > 0) {
      timerId = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`ACP ${method} timed out after ${requestTimeoutMs}ms`));
        }
      }, requestTimeoutMs);
    }
    pending.set(id, {
      resolve: (v) => {
        if (timerId) clearTimeout(timerId);
        resolve(v);
      },
      reject: (e) => {
        if (timerId) clearTimeout(timerId);
        reject(e);
      },
      timerId,
    });
  });
}

function respond(stdin: NodeJS.WritableStream, id: number, result: object): void {
  const line = JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
  stdin.write(line, "utf8");
}


type AcpPending = Map<
  number,
  { resolve: (value: unknown) => void; reject: (err: Error) => void; timerId?: ReturnType<typeof setTimeout> }
>;

type AcpSessionNewResult = {
  sessionId?: string;
  models?: { availableModels?: AcpAvailableModel[] };
};

class PersistentAcpClient {
  private child?: ChildProcessWithoutNullStreams;
  private rl?: readline.Interface;
  private nextId = { current: 1 };
  private pending: AcpPending = new Map();
  private stderr = "";
  private startPromise?: Promise<void>;
  private serial: Promise<void> = Promise.resolve();
  private activeChunkHandler?: (text: string) => void;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly baseOpts: AcpRunOptions,
  ) {}

  runSync(prompt: string, opts: AcpRunOptions): Promise<AcpSyncResult> {
    let accumulated = "";
    return this.runPrompt(prompt, opts, (text) => {
      accumulated += text;
    }).then((result) => ({
      code: result.code,
      stdout: accumulated.trim(),
      stderr: result.stderr.trim(),
    }));
  }

  runStream(
    prompt: string,
    opts: AcpRunOptions,
    onChunk: (text: string) => void,
  ): Promise<AcpStreamResult> {
    return this.runPrompt(prompt, opts, onChunk).then((result) => ({
      code: result.code,
      stderr: result.stderr.trim(),
    }));
  }

  async close(): Promise<void> {
    await this.serial.catch(() => undefined);
    this.restart(new Error("ACP persistent client closed"));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.serial.catch(() => undefined).then(task);
    this.serial = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runPrompt(
    prompt: string,
    opts: AcpRunOptions,
    onChunk: (text: string) => void,
  ): Promise<{ code: number; stderr: string }> {
    return this.enqueue(async () => {
      const effectiveOpts = { ...this.baseOpts, ...opts };
      const stderrStart = this.stderr.length;

      try {
        await this.withRunGuards(effectiveOpts, async () => {
          await this.ensureStarted(effectiveOpts);
          const child = this.child;
          if (!child?.stdin) throw new Error("ACP child is not writable");

          this.activeChunkHandler = onChunk;

          debugAcp("ACP persistent step: session/new");
          const sessionResult = (await this.request(
            "session/new",
            { cwd: effectiveOpts.cwd, mcpServers: [] },
            effectiveOpts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
          )) as AcpSessionNewResult;
          const sessionId = sessionResult?.sessionId;
          if (!sessionId) throw new Error("ACP session/new returned no sessionId");

          if (effectiveOpts.model) {
            const resolvedModelId = resolveAcpModelConfigValue(
              effectiveOpts.model,
              sessionResult.models?.availableModels,
            );
            if (resolvedModelId !== "default" && resolvedModelId !== "default[]") {
              debugAcp("ACP persistent step: session/set_config_option (model)");
              await this.request(
                "session/set_config_option",
                { sessionId, configId: "model", value: resolvedModelId },
                effectiveOpts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
              );
            } else {
              debugAcp(
                "ACP persistent step: session/set_config_option (model) skipped",
              );
            }
          }

          debugAcp("ACP persistent step: session/prompt");
          await this.request(
            "session/prompt",
            { sessionId, prompt: [{ type: "text", text: prompt }] },
            effectiveOpts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
          );
        });

        return { code: 0, stderr: this.stderr.slice(stderrStart) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        debugAcp("ACP persistent run failed: %s", message);
        this.restart(err instanceof Error ? err : new Error(message));
        const stderr = this.stderr.slice(stderrStart) || message;
        return {
          code: effectiveOpts.signal?.aborted ? 499 : 1,
          stderr,
        };
      } finally {
        this.activeChunkHandler = undefined;
      }
    });
  }

  private async withRunGuards<T>(
    opts: AcpRunOptions,
    task: () => Promise<T>,
  ): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;

    const guard = new Promise<never>((_, reject) => {
      if (opts.timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          reject(new Error(`ACP persistent prompt timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
      }
      if (opts.signal) {
        abortHandler = () => reject(new Error("ACP persistent prompt aborted"));
        if (opts.signal.aborted) abortHandler();
        else opts.signal.addEventListener("abort", abortHandler, { once: true });
      }
    });

    try {
      return await Promise.race([task(), guard]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (opts.signal && abortHandler) {
        opts.signal.removeEventListener("abort", abortHandler);
      }
    }
  }

  private async ensureStarted(opts: AcpRunOptions): Promise<void> {
    if (this.child && !this.child.killed && this.startPromise) {
      return this.startPromise;
    }

    const child = spawn(this.command, this.args, {
      cwd: opts.processCwd ?? opts.cwd,
      env: buildAcpSpawnEnv(opts.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: opts.spawnOptions?.windowsVerbatimArguments,
    });
    trackChildProcess(child);

    this.child = child;
    this.nextId = { current: 1 };
    this.pending = new Map();
    this.stderr = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });

    this.rl = readline.createInterface({ input: child.stdout });
    this.rl.on("line", (line: string) => this.handleLine(line));

    child.on("error", (err) => {
      this.restart(err instanceof Error ? err : new Error(String(err)));
    });
    child.on("close", (code) => {
      if (this.child === child) {
        this.rejectPending(new Error(`ACP child exited with code ${code ?? 1}`));
        this.child = undefined;
        this.startPromise = undefined;
        this.rl?.close();
        this.rl = undefined;
      }
    });

    this.startPromise = (async () => {
      debugAcp("ACP persistent step: initialize");
      await this.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "cursor-api-proxy", version: "0.1.0" },
      }, opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

      if (!opts.skipAuthenticate) {
        debugAcp("ACP persistent step: authenticate");
        await this.request("authenticate", { methodId: "cursor_login" }, opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      } else {
        debugAcp("ACP persistent step: authenticate (skipped, pre-authenticated)");
      }
    })().catch((err) => {
      this.restart(err instanceof Error ? err : new Error(String(err)));
      throw err;
    });

    return this.startPromise;
  }

  private request(
    method: string,
    params: object,
    requestTimeoutMs: number,
  ): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin) return Promise.reject(new Error("ACP child is not writable"));
    return sendRequest(child.stdin, this.nextId, method, params, this.pending, requestTimeoutMs);
  }

  private handleLine(line: string): void {
    try {
      if (this.baseOpts.rawDebug) debugAcp("ACP raw: %s", line);
      const msg = parseAcpStdoutLine(line);
      if (!msg) return;

      if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
        const reqId = typeof msg.id === "number" ? msg.id : Number(msg.id);
        const waiter = Number.isFinite(reqId) ? this.pending.get(reqId) : undefined;
        if (waiter) {
          this.pending.delete(reqId);
          if (msg.error) waiter.reject(new Error(msg.error.message ?? "ACP error"));
          else waiter.resolve(msg.result);
        }
        return;
      }

      handleAcpNotification(msg, {
        rawDebug: this.baseOpts.rawDebug,
        stdin: this.child?.stdin,
        onAgentTextChunk: (text) => this.activeChunkHandler?.(text),
      });
    } catch {
      /* ignore notification handler errors */
    }
  }

  private rejectPending(err: Error): void {
    for (const [id, waiter] of Array.from(this.pending.entries())) {
      this.pending.delete(id);
      if (waiter.timerId) clearTimeout(waiter.timerId);
      waiter.reject(err);
    }
  }

  private restart(err: Error): void {
    this.rejectPending(err);
    const child = this.child;
    this.child = undefined;
    this.startPromise = undefined;
    this.activeChunkHandler = undefined;
    try {
      this.rl?.close();
    } catch {
      /* ignore */
    }
    this.rl = undefined;
    try {
      child?.stdin.end();
      child?.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

const persistentAcpClients = new Map<string, PersistentAcpClient>();

function stableEnvKey(env?: Record<string, string | undefined>): Array<[string, string]> {
  return Object.entries(env ?? {})
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
}

function persistentAcpClientKey(
  command: string,
  args: string[],
  opts: AcpRunOptions,
): string {
  return JSON.stringify({
    command,
    args,
    processCwd: opts.processCwd ?? opts.cwd,
    env: stableEnvKey(opts.env),
    skipAuthenticate: !!opts.skipAuthenticate,
    spawnOptions: opts.spawnOptions ?? null,
  });
}

function getPersistentAcpClient(
  command: string,
  args: string[],
  opts: AcpRunOptions,
): PersistentAcpClient {
  const key = persistentAcpClientKey(command, args, opts);
  let client = persistentAcpClients.get(key);
  if (!client) {
    client = new PersistentAcpClient(command, args, opts);
    persistentAcpClients.set(key, client);
  }
  return client;
}

export function runPersistentAcpSync(
  command: string,
  args: string[],
  prompt: string,
  opts: AcpRunOptions,
): Promise<AcpSyncResult> {
  return getPersistentAcpClient(command, args, opts).runSync(prompt, opts);
}

export function runPersistentAcpStream(
  command: string,
  args: string[],
  prompt: string,
  opts: AcpRunOptions,
  onChunk: (text: string) => void,
): Promise<AcpStreamResult> {
  return getPersistentAcpClient(command, args, opts).runStream(prompt, opts, onChunk);
}

export async function shutdownPersistentAcpClients(): Promise<void> {
  const clients = Array.from(persistentAcpClients.values());
  persistentAcpClients.clear();
  await Promise.all(clients.map((client) => client.close()));
}

/**
 * Run a single prompt via ACP and return the full response (sync).
 * Uses pre-resolved command + args (e.g. node + script on Windows) to avoid spawn EINVAL and DEP0190.
 */
export function runAcpSync(
  command: string,
  args: string[],
  prompt: string,
  opts: AcpRunOptions,
): Promise<AcpSyncResult> {
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: buildAcpSpawnEnv(opts.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: opts.spawnOptions?.windowsVerbatimArguments,
    });

    trackChildProcess(child);

    let stderr = "";
    let accumulated = "";
    let resolved = false;

    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const finish = (code: number) => {
      if (resolved) return;
      resolved = true;
      opts.signal?.removeEventListener("abort", onAbort);
      const exitErr = new Error(`ACP child exited with code ${code}`);
      for (const [id, waiter] of Array.from(pending.entries())) {
        pending.delete(id);
        if (waiter.timerId) clearTimeout(waiter.timerId);
        waiter.reject(exitErr);
      }
      try {
        child.stdin?.end();
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve({
        code,
        stdout: accumulated.trim(),
        stderr: stderr.trim(),
      });
    };

    const timeout =
      opts.timeoutMs > 0
        ? setTimeout(() => {
            finish(124); // timeout exit code
          }, opts.timeoutMs)
        : undefined;

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => (stderr += chunk));

    const nextId = { current: 1 };
    const pending = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (err: Error) => void; timerId?: ReturnType<typeof setTimeout> }
    >();

    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (line: string) => {
      try {
        if (opts.rawDebug) {
          debugAcp("ACP raw: %s", line);
        }
        const msg = parseAcpStdoutLine(line);
        if (!msg) return;

        if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
          const reqId = typeof msg.id === "number" ? msg.id : Number(msg.id);
          const waiter = Number.isFinite(reqId) ? pending.get(reqId) : undefined;
          if (waiter) {
            pending.delete(reqId);
            if (msg.error) {
              waiter.reject(new Error(msg.error.message ?? "ACP error"));
            } else {
              waiter.resolve(msg.result);
            }
          }
          return;
        }

        handleAcpNotification(msg, {
          rawDebug: opts.rawDebug,
          stdin: child.stdin,
          onAgentTextChunk: (text) => {
            accumulated += text;
          },
        });
      } catch {
        /* ignore notification handler errors */
      }
    });

    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      opts.signal?.removeEventListener("abort", onAbort);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      finish(code ?? 1);
    });

    const run = async () => {
      if (!child.stdin) {
        finish(1);
        return;
      }
      try {
        debugAcp("ACP step: initialize");
        await sendRequest(child.stdin, nextId, "initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "cursor-api-proxy", version: "0.1.0" },
        }, pending, requestTimeoutMs);

        if (!opts.skipAuthenticate) {
          debugAcp("ACP step: authenticate");
          await sendRequest(child.stdin, nextId, "authenticate", {
            methodId: "cursor_login",
          }, pending, requestTimeoutMs);
        } else {
          debugAcp("ACP step: authenticate (skipped, pre-authenticated)");
        }

        debugAcp("ACP step: session/new");
        const sessionResult = (await sendRequest(
          child.stdin,
          nextId,
          "session/new",
          { cwd: opts.cwd, mcpServers: [] },
          pending,
          requestTimeoutMs,
        )) as {
          sessionId?: string;
          models?: { availableModels?: AcpAvailableModel[] };
        };
        const sessionId = sessionResult?.sessionId;
        if (!sessionId) {
          finish(1);
          return;
        }

        if (opts.model) {
          const resolvedModelId = resolveAcpModelConfigValue(
            opts.model,
            sessionResult.models?.availableModels,
          );
          if (resolvedModelId !== "default" && resolvedModelId !== "default[]") {
            debugAcp("ACP step: session/set_config_option (model)");
            await sendRequest(
              child.stdin,
              nextId,
              "session/set_config_option",
              { sessionId, configId: "model", value: resolvedModelId },
              pending,
              requestTimeoutMs,
            );
          } else {
            debugAcp(
              "ACP step: session/set_config_option (model) — skipped, using session default",
            );
          }
        }

        debugAcp("ACP step: session/prompt");
        await sendRequest(child.stdin, nextId, "session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: prompt }],
        }, pending, requestTimeoutMs);
        if (accumulated.length === 0) {
          debugAcp("ACP sync: no content accumulated; stderr tail: %s", stderr.slice(-500));
        }
        finish(0);
      } catch {
        if (timeout) clearTimeout(timeout);
        if (!resolved) {
          finish(1);
        }
      }
    };

    run();
  });
}

/**
 * Run a single prompt via ACP and stream response chunks via onChunk.
 */
export function runAcpStream(
  command: string,
  args: string[],
  prompt: string,
  opts: AcpRunOptions,
  onChunk: (text: string) => void,
): Promise<AcpStreamResult> {
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: buildAcpSpawnEnv(opts.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: opts.spawnOptions?.windowsVerbatimArguments,
    });

    trackChildProcess(child);

    let stderr = "";
    let resolved = false;

    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const finish = (code: number) => {
      if (resolved) return;
      resolved = true;
      opts.signal?.removeEventListener("abort", onAbort);
      const exitErr = new Error(`ACP child exited with code ${code}`);
      for (const [id, waiter] of Array.from(pending.entries())) {
        pending.delete(id);
        if (waiter.timerId) clearTimeout(waiter.timerId);
        waiter.reject(exitErr);
      }
      try {
        child.stdin?.end();
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve({ code, stderr: stderr.trim() });
    };

    const timeout =
      opts.timeoutMs > 0
        ? setTimeout(() => finish(124), opts.timeoutMs)
        : undefined;

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => (stderr += chunk));

    const nextId = { current: 1 };
    const pending = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (err: Error) => void; timerId?: ReturnType<typeof setTimeout> }
    >();

    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (line: string) => {
      try {
        if (opts.rawDebug) {
          debugAcp("ACP raw: %s", line);
        }
        const msg = parseAcpStdoutLine(line);
        if (!msg) return;

        if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
          const reqId = typeof msg.id === "number" ? msg.id : Number(msg.id);
          const waiter = Number.isFinite(reqId) ? pending.get(reqId) : undefined;
          if (waiter) {
            pending.delete(reqId);
            if (msg.error) {
              waiter.reject(new Error(msg.error.message ?? "ACP error"));
            } else {
              waiter.resolve(msg.result);
            }
          }
          return;
        }

        handleAcpNotification(msg, {
          rawDebug: opts.rawDebug,
          stdin: child.stdin,
          onAgentTextChunk: onChunk,
        });
      } catch {
        /* ignore notification handler errors */
      }
    });

    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      opts.signal?.removeEventListener("abort", onAbort);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      finish(code ?? 1);
    });

    const run = async () => {
      if (!child.stdin) {
        finish(1);
        return;
      }
      try {
        debugAcp("ACP step: initialize");
        await sendRequest(child.stdin, nextId, "initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "cursor-api-proxy", version: "0.1.0" },
        }, pending, requestTimeoutMs);

        if (!opts.skipAuthenticate) {
          debugAcp("ACP step: authenticate");
          await sendRequest(child.stdin, nextId, "authenticate", {
            methodId: "cursor_login",
          }, pending, requestTimeoutMs);
        } else {
          debugAcp("ACP step: authenticate (skipped, pre-authenticated)");
        }

        debugAcp("ACP step: session/new");
        const sessionResult = (await sendRequest(
          child.stdin,
          nextId,
          "session/new",
          { cwd: opts.cwd, mcpServers: [] },
          pending,
          requestTimeoutMs,
        )) as {
          sessionId?: string;
          models?: { availableModels?: AcpAvailableModel[] };
        };
        const sessionId = sessionResult?.sessionId;
        if (!sessionId) {
          finish(1);
          return;
        }

        if (opts.model) {
          const resolvedModelId = resolveAcpModelConfigValue(
            opts.model,
            sessionResult.models?.availableModels,
          );
          if (resolvedModelId !== "default" && resolvedModelId !== "default[]") {
            debugAcp("ACP step: session/set_config_option (model)");
            await sendRequest(
              child.stdin,
              nextId,
              "session/set_config_option",
              { sessionId, configId: "model", value: resolvedModelId },
              pending,
              requestTimeoutMs,
            );
          } else {
            debugAcp(
              "ACP step: session/set_config_option (model) — skipped, using session default",
            );
          }
        }

        debugAcp("ACP step: session/prompt");
        await sendRequest(child.stdin, nextId, "session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: prompt }],
        }, pending, requestTimeoutMs);
        finish(0);
      } catch {
        if (timeout) clearTimeout(timeout);
        if (!resolved) {
          finish(1);
        }
      }
    };

    run();
  });
}
