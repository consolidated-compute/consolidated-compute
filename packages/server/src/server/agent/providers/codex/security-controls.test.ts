import { describe, expect, test } from "vitest";

import { CodexProviderOptionsSchema } from "./options.js";
import { CODEX_AGENT_PROFILE_SECURITY_PRESETS } from "./security-controls.js";

describe("Codex Agent Profile security controls", () => {
  test("publishes only provider-option payloads accepted by Codex", () => {
    expect(CODEX_AGENT_PROFILE_SECURITY_PRESETS.map((preset) => preset.id)).toEqual([
      "provider-defaults",
      "fail-closed-read-only",
      "fail-closed-workspace-write",
    ]);

    for (const preset of CODEX_AGENT_PROFILE_SECURITY_PRESETS) {
      expect(CodexProviderOptionsSchema.parse(preset.providerOptions)).toEqual(
        preset.providerOptions,
      );
    }
  });

  test("freezes the complete fail-closed Workspace boundary", () => {
    const workspaceWrite = CODEX_AGENT_PROFILE_SECURITY_PRESETS.find(
      (preset) => preset.id === "fail-closed-workspace-write",
    );

    expect(workspaceWrite?.providerOptions).toEqual({
      approval_policy: "never",
      sandbox_mode: "workspace-write",
      sandbox_workspace_write: {
        writable_roots: [],
        network_access: false,
        exclude_slash_tmp: true,
        exclude_tmpdir_env_var: true,
      },
      web_search: "disabled",
      features: { network_proxy: false, multi_agent_v2: false },
    });
  });
});
