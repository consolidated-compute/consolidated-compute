import type { TeamSecurityFactDto } from "@getpaseo/protocol/team/types";

import type {
  ProviderSecurityPosture,
  ProviderSecurityPostureInput,
} from "../../provider-security-posture.js";
import { CODEX_MODE_PRESETS, type CodexModePreset } from "./modes.js";
import { CodexProviderOptionsSchema, type CodexProviderOptions } from "./options.js";

const UNAVAILABLE_INHERITED_FACT: TeamSecurityFactDto = {
  status: "unavailable",
  summary: "Codex security settings were not fully frozen for this launch.",
};

export function projectCodexSecurityPosture(
  input: ProviderSecurityPostureInput,
): ProviderSecurityPosture {
  const options = CodexProviderOptionsSchema.parse(input.providerOptions ?? {});
  const preset = input.modeId === null ? undefined : CODEX_MODE_PRESETS[input.modeId];
  if (!preset) {
    return {
      source: { provider: input.provider },
      filesystemWrite: UNAVAILABLE_INHERITED_FACT,
      networkAccess: UNAVAILABLE_INHERITED_FACT,
      toolShell: UNAVAILABLE_INHERITED_FACT,
      nativeDelegation: projectNativeDelegation(input.modeId, options),
    };
  }

  const sandbox = options.sandbox_mode ?? preset.sandbox;
  const approval = options.approval_policy ?? preset.approvalPolicy;
  return {
    source: { provider: input.provider },
    filesystemWrite: projectFilesystemWrite(sandbox, approval, options),
    networkAccess: projectNetworkAccess(sandbox, approval, options),
    toolShell: projectToolShell(approval, input.modeId),
    nativeDelegation: projectNativeDelegation(input.modeId, options),
  };
}

function projectNativeDelegation(
  modeId: string | null,
  options: CodexProviderOptions,
): TeamSecurityFactDto {
  if (modeId === "auto-review") {
    return {
      status: "unavailable",
      summary: "Codex auto-review mode may create a provider-native reviewer agent.",
    };
  }
  if (options.features?.multi_agent_v2 === false) {
    return {
      status: "enforced",
      summary: "Codex native multi-agent delegation is disabled for this launch.",
    };
  }
  return {
    status: "unavailable",
    summary: "Codex native multi-agent delegation was not explicitly disabled.",
  };
}

function projectFilesystemWrite(
  sandbox: CodexModePreset["sandbox"],
  approval: CodexProviderOptions["approval_policy"] | CodexModePreset["approvalPolicy"],
  options: CodexProviderOptions,
): TeamSecurityFactDto {
  if (sandbox === "danger-full-access") {
    return {
      status: "unavailable",
      summary: "Codex runs without a filesystem sandbox for this launch.",
    };
  }
  if (typeof approval !== "string") {
    return {
      status: "unavailable",
      summary: "Codex filesystem enforcement cannot be proved from granular approvals.",
    };
  }
  if (approval !== "never") {
    return {
      status: "policy_only",
      summary: "Codex applies a filesystem sandbox, but broader access may be approved.",
    };
  }
  if (sandbox === "read-only") {
    return {
      status: "enforced",
      summary:
        "Codex read-only sandbox denies provider-native filesystem writes with no approval escape.",
    };
  }

  const workspaceWrite = options.sandbox_workspace_write;
  if (
    workspaceWrite?.writable_roots?.length === 0 &&
    workspaceWrite.exclude_slash_tmp === true &&
    workspaceWrite.exclude_tmpdir_env_var === true
  ) {
    return {
      status: "enforced",
      summary:
        "Codex workspace-write sandbox limits provider-native writes to the Workspace, excludes standard temporary roots, and has no approval escape.",
    };
  }
  return {
    status: "unavailable",
    summary: "Codex write scope depends on workspace settings that were not fully frozen.",
  };
}

function projectNetworkAccess(
  sandbox: CodexModePreset["sandbox"],
  approval: CodexProviderOptions["approval_policy"] | CodexModePreset["approvalPolicy"],
  options: CodexProviderOptions,
): TeamSecurityFactDto {
  const hasFrozenDeny =
    sandbox === "workspace-write" &&
    options.sandbox_workspace_write?.network_access === false &&
    options.features?.network_proxy === false &&
    options.web_search === "disabled";
  if (hasFrozenDeny && approval === "never") {
    return {
      status: "enforced",
      summary: "Codex denies sandbox network access, network proxying, and web search.",
    };
  }
  if (hasFrozenDeny && (approval === "on-request" || approval === "untrusted")) {
    return {
      status: "policy_only",
      summary: "Codex denies sandbox network access, but broader access may be approved.",
    };
  }
  return {
    status: "unavailable",
    summary: "Codex network enforcement is not proved by the frozen launch.",
  };
}

function projectToolShell(
  approval: CodexProviderOptions["approval_policy"] | CodexModePreset["approvalPolicy"],
  modeId: string | null,
): TeamSecurityFactDto {
  if (approval === "never") {
    return {
      status: "unavailable",
      summary: "Codex runs tool and shell actions without approval.",
    };
  }
  if (typeof approval !== "string") {
    return {
      status: "policy_only",
      summary: "Codex applies provider-native granular approval policy to tool and shell use.",
    };
  }
  if (modeId === "auto-review") {
    return {
      status: "policy_only",
      summary: "Codex routes eligible approval requests through its provider reviewer.",
    };
  }
  return {
    status: "policy_only",
    summary: "Codex applies provider approval policy to tool and shell use.",
  };
}
