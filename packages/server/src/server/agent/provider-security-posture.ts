import type { ProviderOptions } from "@getpaseo/protocol/agent-types";
import { TEAM_SECURITY_SUMMARY_MAX_CHARS } from "@getpaseo/protocol/team/types";
import { z } from "zod";

const SecurityFactSchema = z
  .object({
    status: z.enum(["enforced", "policy_only", "unavailable"]),
    summary: z.string().min(1).max(TEAM_SECURITY_SUMMARY_MAX_CHARS),
  })
  .strict();

export const ProviderSecurityPostureSchema = z
  .object({
    source: z.object({ provider: z.string().min(1).max(128) }).strict(),
    filesystemWrite: SecurityFactSchema,
    networkAccess: SecurityFactSchema,
    toolShell: SecurityFactSchema,
    nativeDelegation: SecurityFactSchema.optional(),
  })
  .strict();

export type ProviderSecurityPosture = z.infer<typeof ProviderSecurityPostureSchema>;

export interface ProviderSecurityPostureInput {
  provider: string;
  modeId: string | null;
  providerOptions: ProviderOptions | undefined;
}

export function projectUnavailableProviderSecurityPosture(
  input: ProviderSecurityPostureInput,
): ProviderSecurityPosture {
  return {
    source: { provider: input.provider },
    filesystemWrite: {
      status: "unavailable",
      summary: "No filesystem enforcement mapping is available for this provider.",
    },
    networkAccess: {
      status: "unavailable",
      summary: "No network enforcement mapping is available for this provider.",
    },
    toolShell: {
      status: "unavailable",
      summary: "No tool or shell enforcement mapping is available for this provider.",
    },
    nativeDelegation: {
      status: "unavailable",
      summary: "No native delegation enforcement mapping is available for this provider.",
    },
  };
}

export function projectMockProviderSecurityPosture(
  input: ProviderSecurityPostureInput,
): ProviderSecurityPosture {
  return {
    ...projectUnavailableProviderSecurityPosture(input),
    nativeDelegation: {
      status: "enforced",
      summary: "The development mock provider has no native delegation runtime.",
    },
  };
}
