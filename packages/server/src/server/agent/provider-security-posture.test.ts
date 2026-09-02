import { describe, expect, test } from "vitest";

import { projectClaudeSecurityPosture } from "./providers/claude/security-posture.js";
import { projectCodexSecurityPosture } from "./providers/codex/security-posture.js";
import { projectOpenCodeSecurityPosture } from "./providers/opencode/security-posture.js";
import { projectMockProviderSecurityPosture } from "./provider-security-posture.js";

describe("provider security posture", () => {
  test("reports only fail-closed Codex filesystem and network restrictions as enforced", () => {
    const posture = projectCodexSecurityPosture({
      provider: "codex",
      modeId: "auto",
      providerOptions: {
        approval_policy: "never",
        sandbox_workspace_write: {
          writable_roots: [],
          network_access: false,
          exclude_slash_tmp: true,
          exclude_tmpdir_env_var: true,
        },
        web_search: "disabled",
        features: { network_proxy: false, multi_agent_v2: false },
      },
    });

    expect(posture).toMatchObject({
      source: { provider: "codex" },
      filesystemWrite: { status: "enforced" },
      networkAccess: { status: "enforced" },
      toolShell: { status: "unavailable" },
      nativeDelegation: { status: "enforced" },
    });
  });

  test("does not upgrade inherited, granular, or incompletely frozen Codex controls", () => {
    const inherited = projectCodexSecurityPosture({
      provider: "codex",
      modeId: null,
      providerOptions: { sandbox_mode: "read-only", approval_policy: "never" },
    });
    const granular = projectCodexSecurityPosture({
      provider: "codex",
      modeId: "auto",
      providerOptions: {
        approval_policy: { granular: { sandbox_approval: false } },
        sandbox_workspace_write: {
          writable_roots: [],
          network_access: false,
          exclude_slash_tmp: true,
          exclude_tmpdir_env_var: true,
        },
        web_search: "disabled",
        features: { network_proxy: false },
      },
    });
    const incomplete = projectCodexSecurityPosture({
      provider: "codex",
      modeId: "auto",
      providerOptions: { approval_policy: "never" },
    });
    const broadWriteScope = projectCodexSecurityPosture({
      provider: "codex",
      modeId: "auto",
      providerOptions: {
        approval_policy: "never",
        sandbox_workspace_write: {
          writable_roots: ["/"],
          exclude_slash_tmp: false,
          exclude_tmpdir_env_var: false,
        },
      },
    });

    expect([
      inherited.filesystemWrite.status,
      inherited.networkAccess.status,
      inherited.toolShell.status,
    ]).toEqual(["unavailable", "unavailable", "unavailable"]);
    expect(granular.filesystemWrite.status).toBe("unavailable");
    expect(granular.networkAccess.status).toBe("unavailable");
    expect(granular.toolShell.status).toBe("policy_only");
    expect(incomplete.filesystemWrite.status).toBe("unavailable");
    expect(incomplete.networkAccess.status).toBe("unavailable");
    expect(broadWriteScope.filesystemWrite.status).toBe("unavailable");
    expect(incomplete.nativeDelegation?.status).toBe("unavailable");
  });

  test("keeps provider paths, proxies, sockets, and TLS material out of projected facts", () => {
    const codexPosture = projectCodexSecurityPosture({
      provider: "codex",
      modeId: "auto",
      providerOptions: {
        sandbox_workspace_write: {
          writable_roots: ["/secret/root-sentinel"],
          exclude_slash_tmp: false,
          exclude_tmpdir_env_var: false,
        },
        features: {
          network_proxy: {
            proxy_url: "https://proxy-sentinel.invalid",
            socks_url: "socks5://socket-sentinel.invalid",
            domains: { "domain-sentinel.invalid": "allow" },
            unix_sockets: { "/secret/socket-sentinel": "allow" },
          },
        },
      },
    });
    const claudePosture = projectClaudeSecurityPosture({
      provider: "claude",
      modeId: "default",
      providerOptions: {
        additionalDirectories: ["/secret/claude-root-sentinel"],
        sandbox: {
          network: {
            allowUnixSockets: ["/secret/claude-socket-sentinel"],
            tlsTerminate: {
              caCertPath: "/secret/cert-sentinel",
              caKeyPath: "/secret/key-sentinel",
            },
          },
        },
      },
    });
    const serialized = JSON.stringify([codexPosture, claudePosture]);

    expect(serialized).not.toContain("sentinel");
    expect(claudePosture).toMatchObject({
      filesystemWrite: { status: "unavailable" },
      networkAccess: { status: "unavailable" },
      toolShell: { status: "policy_only" },
      nativeDelegation: { status: "unavailable" },
    });
  });

  test("proves only explicit provider-native delegation denies", () => {
    const codex = projectCodexSecurityPosture({
      provider: "codex",
      modeId: null,
      providerOptions: { features: { multi_agent_v2: false } },
    });
    const claude = projectClaudeSecurityPosture({
      provider: "claude",
      modeId: "default",
      providerOptions: { disallowedTools: ["Task", "Agent", "Workflow"] },
    });
    const opencode = projectOpenCodeSecurityPosture({
      provider: "opencode",
      modeId: "build",
      providerOptions: { permission: { task: "deny" } },
    });

    expect(codex.nativeDelegation?.status).toBe("enforced");
    expect(claude.nativeDelegation?.status).toBe("enforced");
    expect(opencode.nativeDelegation?.status).toBe("enforced");
    expect(
      projectOpenCodeSecurityPosture({
        provider: "opencode",
        modeId: "build",
        providerOptions: { permission: { task: { reviewer: "deny" } } },
      }).nativeDelegation?.status,
    ).toBe("unavailable");
    expect(
      projectCodexSecurityPosture({
        provider: "codex",
        modeId: "auto-review",
        providerOptions: { features: { multi_agent_v2: false } },
      }).nativeDelegation?.status,
    ).toBe("unavailable");
  });

  test("treats the development mock provider's absent delegation runtime as enforced", () => {
    expect(
      projectMockProviderSecurityPosture({
        provider: "mock",
        modeId: "load-test",
        providerOptions: undefined,
      }).nativeDelegation,
    ).toEqual({
      status: "enforced",
      summary: "The development mock provider has no native delegation runtime.",
    });
  });
});
