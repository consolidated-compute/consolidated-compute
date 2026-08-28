import { createHash } from "node:crypto";

import {
  TeamResolvedLaunchDtoSchema,
  TeamRunPreviewDtoSchema,
  type TeamRunPreviewDto,
} from "@getpaseo/protocol/team/types";

import type { AcceptedTeamRunFacts } from "./execution.js";

export function buildTeamRunPreview(accepted: AcceptedTeamRunFacts): TeamRunPreviewDto {
  const fingerprint = createTeamRunPreviewFingerprint(accepted);
  return TeamRunPreviewDtoSchema.parse({
    workspace: accepted.workspace,
    roles: accepted.roles.map((role) => ({
      roleId: role.roleId,
      roleName: role.roleName,
      // Parsing through the public DTO is the privacy boundary. In particular,
      // providerOptions participate in the fingerprint but never cross the wire.
      resolvedLaunch: TeamResolvedLaunchDtoSchema.parse(role.resolvedLaunch),
    })),
    fingerprint,
  });
}

export function createTeamRunPreviewFingerprint(accepted: AcceptedTeamRunFacts): string {
  const fingerprintInput = {
    workspace: accepted.workspace,
    roles: accepted.roles.map((role) => ({
      roleId: role.roleId,
      resolvedLaunch: role.resolvedLaunch,
    })),
  };
  return createHash("sha256").update(canonicalJson(fingerprintInput)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}
