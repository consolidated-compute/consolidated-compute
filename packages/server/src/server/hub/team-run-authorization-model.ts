import { randomBytes } from "node:crypto";

import { z } from "zod";
import { ASSIGNMENT_TITLE_MAX_CHARS, PersistedAssignmentIdSchema } from "../assignment/model.js";
import { ProviderSecurityPostureSchema } from "../agent/provider-security-posture.js";
import {
  PersistedTeamEntityIdSchema,
  TeamRunUnattendedPolicyInputSchema,
  TEAM_MAX_ROLES,
  TEAM_MODEL_ID_MAX_CHARS,
  TEAM_NAME_MAX_CHARS,
  TEAM_PROVIDER_ID_MAX_CHARS,
  TEAM_ROLE_NAME_MAX_CHARS,
  type TeamRunUnattendedPolicyInput,
} from "../team/model.js";
import { normalizeHubUrl } from "./hub-origin.js";

export const HUB_TEAM_RUN_AUTHORIZATION_MAX_USES = 10_000;
export const HUB_TEAM_RUN_EXTERNAL_ID_MAX_CHARS = 512;
export const HUB_TEAM_RUN_PRINCIPAL_ID_MAX_CHARS = 512;
export const HUB_TEAM_RUN_REVOCATION_REASON_MAX_CHARS = 1_024;

const TimestampSchema = z.string().datetime({ offset: true });
const WorkspaceIdSchema = nonBlankStringSchema(8_192);
const ExternalIdSchema = nonBlankStringSchema(HUB_TEAM_RUN_EXTERNAL_ID_MAX_CHARS);
const PrincipalIdSchema = nonBlankStringSchema(HUB_TEAM_RUN_PRINCIPAL_ID_MAX_CHARS);
const HubOriginSchema = z
  .url()
  .max(2_048)
  .refine((value) => {
    try {
      return normalizeHubUrl(value) === value;
    } catch {
      return false;
    }
  }, "Hub origin must be a canonical HTTP(S) origin without credentials, query, or fragment");

export const PersistedHubTeamRunAuthorizationIdSchema = z.string().regex(/^htra_[0-9a-f]{16}$/);
export const PersistedHubTeamRunSourceIdSchema = z.string().regex(/^htrs_[0-9a-f]{16}$/);
const TeamRunIdSchema = z.string().regex(/^trun_[0-9a-f]{16}$/);
const PreviewFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const TriggerDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const PersistedHubRelationshipIdentitySchema = z
  .object({
    id: ExternalIdSchema,
    hubOrigin: HubOriginSchema,
  })
  .strict();

export const PersistedHubTriggerIdentitySchema = z
  .object({
    configurationId: ExternalIdSchema,
    triggerId: ExternalIdSchema,
    digest: TriggerDigestSchema,
  })
  .strict();

export const PersistedHubTeamRunAuthorizationLaunchSchema = z
  .object({
    roleId: PersistedTeamEntityIdSchema,
    roleName: nonBlankStringSchema(TEAM_ROLE_NAME_MAX_CHARS),
    profileId: ExternalIdSchema,
    provider: nonBlankStringSchema(TEAM_PROVIDER_ID_MAX_CHARS),
    model: nonBlankStringSchema(TEAM_MODEL_ID_MAX_CHARS).nullable(),
    securityPosture: ProviderSecurityPostureSchema,
  })
  .strict()
  .superRefine((launch, context) => {
    if (launch.securityPosture.source.provider !== launch.provider) {
      context.addIssue({
        code: "custom",
        path: ["securityPosture", "source", "provider"],
        message: "Security posture source must match the authorized launch provider",
      });
    }
  });

export const PersistedHubTeamRunAuthorizationTargetSchema = z
  .object({
    team: z
      .object({
        id: PersistedTeamEntityIdSchema,
        revision: z.number().int().positive(),
        name: nonBlankStringSchema(TEAM_NAME_MAX_CHARS),
      })
      .strict(),
    assignment: z
      .object({
        id: PersistedAssignmentIdSchema,
        revision: z.number().int().positive(),
        title: nonBlankStringSchema(ASSIGNMENT_TITLE_MAX_CHARS),
      })
      .strict(),
    workspace: z
      .object({
        id: WorkspaceIdSchema,
        projectId: WorkspaceIdSchema,
        displayName: nonBlankStringSchema(512),
      })
      .strict(),
    supervisor: z
      .object({
        roleId: PersistedTeamEntityIdSchema,
        roleName: nonBlankStringSchema(TEAM_ROLE_NAME_MAX_CHARS),
      })
      .strict(),
    launches: z.array(PersistedHubTeamRunAuthorizationLaunchSchema).min(1).max(TEAM_MAX_ROLES),
    previewFingerprint: PreviewFingerprintSchema,
  })
  .strict()
  .superRefine((target, context) => {
    const roleIds = new Set<string>();
    for (const [index, launch] of target.launches.entries()) {
      if (roleIds.has(launch.roleId)) {
        context.addIssue({
          code: "custom",
          path: ["launches", index, "roleId"],
          message: `Duplicate authorized role: ${launch.roleId}`,
        });
      }
      roleIds.add(launch.roleId);
    }
    if (!roleIds.has(target.supervisor.roleId)) {
      context.addIssue({
        code: "custom",
        path: ["supervisor", "roleId"],
        message: "The supervisor must have an authorized launch snapshot",
      });
    }
  });

export const PersistedHubTeamRunAuthorizationSchema = z
  .object({
    id: PersistedHubTeamRunAuthorizationIdSchema,
    revision: z.number().int().positive(),
    relationship: PersistedHubRelationshipIdentitySchema,
    trigger: PersistedHubTriggerIdentitySchema,
    target: PersistedHubTeamRunAuthorizationTargetSchema,
    unattendedPolicy: TeamRunUnattendedPolicyInputSchema,
    maxUses: z.number().int().positive().max(HUB_TEAM_RUN_AUTHORIZATION_MAX_USES),
    approvedBy: z
      .object({
        principalId: PrincipalIdSchema,
        approvedAt: TimestampSchema,
      })
      .strict(),
    revocation: z
      .object({
        principalId: PrincipalIdSchema,
        revokedAt: TimestampSchema,
        reason: nonBlankStringSchema(HUB_TEAM_RUN_REVOCATION_REASON_MAX_CHARS).nullable(),
      })
      .strict()
      .nullable(),
    expiresAt: TimestampSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((authorization, context) => {
    validateAuthorizationLifecycle(authorization, context);
    validateAuthorizationPolicy(authorization, context);
  });

export const PersistedHubTeamRunSourceSchema = z
  .object({
    id: PersistedHubTeamRunSourceIdSchema,
    relationship: PersistedHubRelationshipIdentitySchema,
    authorizationId: PersistedHubTeamRunAuthorizationIdSchema,
    authorizationRevision: z.number().int().positive(),
    trigger: PersistedHubTriggerIdentitySchema,
    triggerRunId: ExternalIdSchema,
    providerEventReceiptId: ExternalIdSchema,
    deadlineAt: TimestampSchema,
    targetFingerprint: PreviewFingerprintSchema,
    idempotencyKey: nonBlankStringSchema(256),
    teamRunId: TeamRunIdSchema.nullable(),
    reservedAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((source, context) => {
    if (Date.parse(source.deadlineAt) <= Date.parse(source.reservedAt)) {
      context.addIssue({
        code: "custom",
        path: ["deadlineAt"],
        message: "The trigger deadline must follow source reservation",
      });
    }
    if (Date.parse(source.updatedAt) < Date.parse(source.reservedAt)) {
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "updatedAt cannot precede source reservation",
      });
    }
  });

export const PersistedHubTeamRunAuthorityStoreSchema = z
  .object({
    version: z.literal(1),
    authorizations: z.array(PersistedHubTeamRunAuthorizationSchema),
    sources: z.array(PersistedHubTeamRunSourceSchema),
  })
  .strict()
  .superRefine((store, context) => validateAuthorityStore(store, context));

export type PersistedHubRelationshipIdentity = z.infer<
  typeof PersistedHubRelationshipIdentitySchema
>;
export type PersistedHubTriggerIdentity = z.infer<typeof PersistedHubTriggerIdentitySchema>;
export type PersistedHubTeamRunAuthorizationTarget = z.infer<
  typeof PersistedHubTeamRunAuthorizationTargetSchema
>;
export type PersistedHubTeamRunAuthorization = z.infer<
  typeof PersistedHubTeamRunAuthorizationSchema
>;
export type PersistedHubTeamRunSource = z.infer<typeof PersistedHubTeamRunSourceSchema>;
export type PersistedHubTeamRunAuthorityStore = z.infer<
  typeof PersistedHubTeamRunAuthorityStoreSchema
>;
export type HubTeamRunAuthorizationPolicy = Omit<TeamRunUnattendedPolicyInput, "source">;

export function generateHubTeamRunAuthorizationId(): string {
  return `htra_${randomBytes(8).toString("hex")}`;
}

export function generateHubTeamRunSourceId(): string {
  return `htrs_${randomBytes(8).toString("hex")}`;
}

function nonBlankStringSchema(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0, "Must contain non-whitespace characters");
}

function validateAuthorizationLifecycle(
  authorization: z.infer<typeof PersistedHubTeamRunAuthorizationSchema>,
  context: z.RefinementCtx,
): void {
  const createdAt = Date.parse(authorization.createdAt);
  const approvedAt = Date.parse(authorization.approvedBy.approvedAt);
  const updatedAt = Date.parse(authorization.updatedAt);
  const expiresAt = Date.parse(authorization.expiresAt);
  if (approvedAt !== createdAt) {
    context.addIssue({
      code: "custom",
      path: ["approvedBy", "approvedAt"],
      message: "Approval and record creation must be atomic",
    });
  }
  if (expiresAt <= createdAt) {
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "Authorization expiry must follow approval",
    });
  }
  if (authorization.revocation === null) {
    if (authorization.revision !== 1) {
      context.addIssue({
        code: "custom",
        path: ["revision"],
        message: "An active authorization must remain at revision 1",
      });
    }
    if (updatedAt !== createdAt) {
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "An active authorization cannot change after approval",
      });
    }
    return;
  }
  const revokedAt = Date.parse(authorization.revocation.revokedAt);
  if (authorization.revision !== 2) {
    context.addIssue({
      code: "custom",
      path: ["revision"],
      message: "A revoked authorization must be revision 2",
    });
  }
  if (revokedAt < createdAt || updatedAt !== revokedAt) {
    context.addIssue({
      code: "custom",
      path: ["revocation", "revokedAt"],
      message: "Revocation must follow approval and own updatedAt",
    });
  }
}

function validateAuthorizationPolicy(
  authorization: z.infer<typeof PersistedHubTeamRunAuthorizationSchema>,
  context: z.RefinementCtx,
): void {
  const policy = authorization.unattendedPolicy;
  if (policy.source.type !== "hub" || policy.source.scopeId !== authorization.id) {
    context.addIssue({
      code: "custom",
      path: ["unattendedPolicy", "source"],
      message: "Hub authorization policy source must be its authorization ID",
    });
  }
  if (policy.executionWindow.type !== "event") {
    context.addIssue({
      code: "custom",
      path: ["unattendedPolicy", "executionWindow"],
      message: "Hub authorizations require an event execution window",
    });
    return;
  }
  if (Date.parse(policy.executionWindow.closesAt) > Date.parse(authorization.expiresAt)) {
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "Authorization expiry cannot precede its execution-window close",
    });
  }
  if (Date.parse(policy.executionWindow.closesAt) <= Date.parse(authorization.createdAt)) {
    context.addIssue({
      code: "custom",
      path: ["unattendedPolicy", "executionWindow", "closesAt"],
      message: "Authorization execution window must remain open after approval",
    });
  }

  const authorizedLaunches = new Set(
    policy.launchAllowlist.flatMap((entry) =>
      entry.models.map((model) => launchIdentity(entry.provider, model)),
    ),
  );
  const targetLaunches = new Set(
    authorization.target.launches.map((launch) => launchIdentity(launch.provider, launch.model)),
  );
  if (
    authorizedLaunches.size !== targetLaunches.size ||
    [...targetLaunches].some((launch) => !authorizedLaunches.has(launch))
  ) {
    context.addIssue({
      code: "custom",
      path: ["unattendedPolicy", "launchAllowlist"],
      message: "Launch allowlist must exactly match the frozen target launches",
    });
  }
}

function validateAuthorityStore(
  store: z.infer<typeof PersistedHubTeamRunAuthorityStoreSchema>,
  context: z.RefinementCtx,
): void {
  const authorizations = indexAuthorizations(store.authorizations, context);
  const identities = createSourceIdentityIndex();
  const useCounts = new Map<string, number>();
  for (const [index, source] of store.sources.entries()) {
    validateSourceUniqueness(source, index, identities, context);
    const authorization = authorizations.get(source.authorizationId);
    if (!authorization) {
      context.addIssue({
        code: "custom",
        path: ["sources", index, "authorizationId"],
        message: "Hub Team Run source references a missing authorization",
      });
      continue;
    }
    validateSourceAuthorization(source, authorization, index, context);
    useCounts.set(source.authorizationId, (useCounts.get(source.authorizationId) ?? 0) + 1);
  }
  validateAuthorizationUseCounts(useCounts, authorizations, context);
}

interface SourceIdentityIndex {
  sourceIds: Set<string>;
  sourceIdentities: Set<string>;
  idempotencyKeys: Set<string>;
  teamRunIds: Set<string>;
}

function indexAuthorizations(
  authorizations: readonly PersistedHubTeamRunAuthorization[],
  context: z.RefinementCtx,
): Map<string, PersistedHubTeamRunAuthorization> {
  const result = new Map<string, PersistedHubTeamRunAuthorization>();
  for (const [index, authorization] of authorizations.entries()) {
    if (result.has(authorization.id)) {
      context.addIssue({
        code: "custom",
        path: ["authorizations", index, "id"],
        message: `Duplicate Hub Team Run authorization: ${authorization.id}`,
      });
    }
    result.set(authorization.id, authorization);
  }
  return result;
}

function createSourceIdentityIndex(): SourceIdentityIndex {
  return {
    sourceIds: new Set(),
    sourceIdentities: new Set(),
    idempotencyKeys: new Set(),
    teamRunIds: new Set(),
  };
}

function validateSourceUniqueness(
  source: PersistedHubTeamRunSource,
  index: number,
  identities: SourceIdentityIndex,
  context: z.RefinementCtx,
): void {
  if (identities.sourceIds.has(source.id)) {
    context.addIssue({
      code: "custom",
      path: ["sources", index, "id"],
      message: `Duplicate Hub Team Run source: ${source.id}`,
    });
  }
  identities.sourceIds.add(source.id);
  const sourceIdentity = JSON.stringify([source.relationship.id, source.triggerRunId]);
  if (identities.sourceIdentities.has(sourceIdentity)) {
    context.addIssue({
      code: "custom",
      path: ["sources", index, "triggerRunId"],
      message: "Duplicate Hub relationship and trigger-run identity",
    });
  }
  identities.sourceIdentities.add(sourceIdentity);
  if (identities.idempotencyKeys.has(source.idempotencyKey)) {
    context.addIssue({
      code: "custom",
      path: ["sources", index, "idempotencyKey"],
      message: "Duplicate Hub Team Run idempotency key",
    });
  }
  identities.idempotencyKeys.add(source.idempotencyKey);
  if (source.teamRunId === null) return;
  if (identities.teamRunIds.has(source.teamRunId)) {
    context.addIssue({
      code: "custom",
      path: ["sources", index, "teamRunId"],
      message: "A Team Run cannot belong to more than one Hub source",
    });
  }
  identities.teamRunIds.add(source.teamRunId);
}

function validateSourceAuthorization(
  source: PersistedHubTeamRunSource,
  authorization: PersistedHubTeamRunAuthorization,
  index: number,
  context: z.RefinementCtx,
): void {
  if (
    source.relationship.id !== authorization.relationship.id ||
    source.relationship.hubOrigin !== authorization.relationship.hubOrigin
  ) {
    context.addIssue({
      code: "custom",
      path: ["sources", index, "relationship"],
      message: "Source relationship must match its authorization",
    });
  }
  if (JSON.stringify(source.trigger) !== JSON.stringify(authorization.trigger)) {
    context.addIssue({
      code: "custom",
      path: ["sources", index, "trigger"],
      message: "Source trigger must match its authorization",
    });
  }
  if (source.targetFingerprint !== authorization.target.previewFingerprint) {
    context.addIssue({
      code: "custom",
      path: ["sources", index, "targetFingerprint"],
      message: "Source target fingerprint must match its authorization",
    });
  }
  const executionWindow = authorization.unattendedPolicy.executionWindow;
  if (executionWindow.type !== "event" || source.deadlineAt !== executionWindow.closesAt) {
    context.addIssue({
      code: "custom",
      path: ["sources", index, "deadlineAt"],
      message: "Source deadline must match the authorized execution-window close",
    });
  }
  if (source.authorizationRevision > authorization.revision) {
    context.addIssue({
      code: "custom",
      path: ["sources", index, "authorizationRevision"],
      message: "Source authorization revision cannot exceed the stored authorization",
    });
  }
  validateSourceReservationTime(source, authorization, index, context);
}

function validateSourceReservationTime(
  source: PersistedHubTeamRunSource,
  authorization: PersistedHubTeamRunAuthorization,
  index: number,
  context: z.RefinementCtx,
): void {
  const reservedAt = Date.parse(source.reservedAt);
  const executionWindow = authorization.unattendedPolicy.executionWindow;
  const reservedUnderActiveAuthority =
    source.authorizationRevision === 1 &&
    reservedAt >= Date.parse(authorization.approvedBy.approvedAt) &&
    reservedAt < Date.parse(authorization.expiresAt) &&
    executionWindow.type === "event" &&
    reservedAt >= Date.parse(executionWindow.opensAt) &&
    reservedAt < Date.parse(executionWindow.closesAt);
  if (!reservedUnderActiveAuthority) {
    context.addIssue({
      code: "custom",
      path: ["sources", index, "reservedAt"],
      message: "Source reservation must occur under active revision 1 authority",
    });
  }
  if (authorization.revocation && reservedAt > Date.parse(authorization.revocation.revokedAt)) {
    context.addIssue({
      code: "custom",
      path: ["sources", index, "reservedAt"],
      message: "A source cannot be reserved after authorization revocation",
    });
  }
}

function validateAuthorizationUseCounts(
  useCounts: ReadonlyMap<string, number>,
  authorizations: ReadonlyMap<string, PersistedHubTeamRunAuthorization>,
  context: z.RefinementCtx,
): void {
  for (const [authorizationId, uses] of useCounts) {
    const authorization = authorizations.get(authorizationId);
    if (authorization && uses > authorization.maxUses) {
      context.addIssue({
        code: "custom",
        path: ["sources"],
        message: `Authorization ${authorizationId} exceeds its use cap`,
      });
    }
  }
}

function launchIdentity(provider: string, model: string | null): string {
  return JSON.stringify([provider, model]);
}
