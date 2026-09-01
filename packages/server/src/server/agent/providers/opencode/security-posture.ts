import type { TeamSecurityFactDto } from "@getpaseo/protocol/team/types";

import {
  projectUnavailableProviderSecurityPosture,
  type ProviderSecurityPosture,
  type ProviderSecurityPostureInput,
} from "../../provider-security-posture.js";
import { OpenCodeProviderOptionsSchema, type OpenCodeProviderOptions } from "./options.js";

export function projectOpenCodeSecurityPosture(
  input: ProviderSecurityPostureInput,
): ProviderSecurityPosture {
  const unavailable = projectUnavailableProviderSecurityPosture(input);
  const options = OpenCodeProviderOptionsSchema.parse(input.providerOptions ?? {});
  return {
    ...unavailable,
    nativeDelegation: projectNativeDelegation(options),
  };
}

function projectNativeDelegation(options: OpenCodeProviderOptions): TeamSecurityFactDto {
  const permission = options.permission;
  if (permission === "deny") {
    return {
      status: "enforced",
      summary: "OpenCode denies every provider-native tool, including task delegation.",
    };
  }
  if (permission && typeof permission === "object" && !Array.isArray(permission)) {
    const task = permission.task;
    if (task === "deny") {
      return {
        status: "enforced",
        summary: "OpenCode provider-native task delegation is disabled.",
      };
    }
    if (
      task &&
      typeof task === "object" &&
      !Array.isArray(task) &&
      task["*"] === "deny" &&
      Object.values(task).every((action) => action === "deny")
    ) {
      return {
        status: "enforced",
        summary: "OpenCode denies every provider-native task delegation pattern.",
      };
    }
  }
  return {
    status: "unavailable",
    summary: "OpenCode provider-native task delegation was not explicitly disabled.",
  };
}
