import type { AgentProfileSecurityPreset } from "@getpaseo/protocol/agent-types";

import { CodexProviderOptionsSchema } from "./options.js";

function createSecurityPreset(
  preset: Omit<AgentProfileSecurityPreset, "providerOptions"> & { providerOptions: unknown },
): AgentProfileSecurityPreset {
  return {
    ...preset,
    providerOptions: CodexProviderOptionsSchema.parse(preset.providerOptions),
  };
}

export const CODEX_AGENT_PROFILE_SECURITY_PRESETS: AgentProfileSecurityPreset[] = [
  createSecurityPreset({
    id: "provider-defaults",
    label: "Provider defaults",
    description: "Use the Codex defaults selected by the profile mode.",
    providerOptions: {},
  }),
  createSecurityPreset({
    id: "fail-closed-read-only",
    label: "Fail-closed read only",
    description: "Deny filesystem writes, web search, network proxying, and approval escapes.",
    providerOptions: {
      approval_policy: "never",
      sandbox_mode: "read-only",
      web_search: "disabled",
      features: { network_proxy: false },
    },
  }),
  createSecurityPreset({
    id: "fail-closed-workspace-write",
    label: "Fail-closed Workspace write",
    description: "Allow writes only in the Workspace while denying network and approval escapes.",
    providerOptions: {
      approval_policy: "never",
      sandbox_mode: "workspace-write",
      sandbox_workspace_write: {
        writable_roots: [],
        network_access: false,
        exclude_slash_tmp: true,
        exclude_tmpdir_env_var: true,
      },
      web_search: "disabled",
      features: { network_proxy: false },
    },
  }),
];
