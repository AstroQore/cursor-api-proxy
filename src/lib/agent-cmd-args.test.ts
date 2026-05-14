import { describe, expect, it } from "vitest";

import { buildAgentFixedArgs } from "./agent-cmd-args.js";
import type { BridgeConfig } from "./config.js";

function cfg(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    agentBin: "agent",
    acpCommand: "agent",
    acpArgs: ["acp"],
    acpEnv: {},
    host: "127.0.0.1",
    port: 8765,
    defaultModel: "default",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: "/w",
    timeoutMs: 30_000,
    sessionsLogPath: "/tmp/s.log",
    chatOnlyWorkspace: true,
    chatOnlyWorkspaceExplicit: false,
    trustChatOnlyWorkspace: true,
    verbose: false,
    apiContextGuard: false,
    allowWorkspaceHints: false,
    promptFormat: "transcript",
    maxMode: false,
    promptViaStdin: false,
    useAcp: false,
    acpSkipAuthenticate: true,
    acpRawDebug: false,
    configDirs: [],
    multiPort: false,
    winCmdlineMax: 30_000,
    ...overrides,
  };
}

describe("buildAgentFixedArgs", () => {
  it("omits explicit agent mode and passes --trust when the workspace is trusted", () => {
    const args = buildAgentFixedArgs(
      cfg(),
      "/ws",
      "gpt-5",
      false,
      "agent",
      true,
    );
    expect(args).not.toContain("--mode");
    expect(args).toContain("--trust");
  });

  it("omits --trust when the workspace is not trusted", () => {
    const args = buildAgentFixedArgs(
      cfg({ chatOnlyWorkspace: true }),
      "/ws",
      "gpt-5",
      false,
      "ask",
      false,
    );
    expect(args).not.toContain("--trust");
  });
});
