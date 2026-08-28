import type { TeamSecurityFactDto } from "@getpaseo/protocol/team/types";

import type {
  ProviderSecurityPosture,
  ProviderSecurityPostureInput,
} from "../../provider-security-posture.js";

const FILESYSTEM_UNAVAILABLE: TeamSecurityFactDto = {
  status: "unavailable",
  summary: "Claude filesystem enforcement is not proved by the frozen launch.",
};
const NETWORK_UNAVAILABLE: TeamSecurityFactDto = {
  status: "unavailable",
  summary: "Claude network enforcement is not proved by the frozen launch.",
};

const TOOL_POLICY_SUMMARIES: Record<string, string> = {
  plan: "Claude Plan mode uses provider permissions to limit tool use.",
  default: "Claude asks for permission before protected tool use.",
  acceptEdits: "Claude uses provider permissions with edit-focused approvals.",
  auto: "Claude uses provider policy to review permission prompts automatically.",
};

export function projectClaudeSecurityPosture(
  input: ProviderSecurityPostureInput,
): ProviderSecurityPosture {
  return {
    source: { provider: input.provider },
    filesystemWrite: FILESYSTEM_UNAVAILABLE,
    networkAccess: NETWORK_UNAVAILABLE,
    toolShell: projectToolShell(input.modeId),
  };
}

function projectToolShell(modeId: string | null): TeamSecurityFactDto {
  const summary = modeId === null ? undefined : TOOL_POLICY_SUMMARIES[modeId];
  if (summary) return { status: "policy_only", summary };
  if (modeId === "bypassPermissions") {
    return {
      status: "unavailable",
      summary: "Claude runs tool and shell actions without permission prompts.",
    };
  }
  return {
    status: "unavailable",
    summary: "Claude tool and shell enforcement is not proved by the frozen launch.",
  };
}
