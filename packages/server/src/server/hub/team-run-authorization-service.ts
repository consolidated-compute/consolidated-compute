import { isDeepStrictEqual } from "node:util";

import type { TeamRunPreviewDto } from "@getpaseo/protocol/team/types";

import type { PersistedAssignmentRecord } from "../assignment/model.js";
import {
  AssignmentNotFoundError,
  AssignmentRevisionConflictError,
  AssignmentStateConflictError,
} from "../assignment/repository.js";
import type { PersistedTeamDefinition } from "../team/model.js";
import { TeamNotFoundError, TeamRevisionConflictError } from "../team/repository.js";
import {
  TeamSecurityPreviewStaleError,
  TeamSupervisedRunAuthenticationRequiredError,
  TeamSupervisedRunEnvironmentPasswordUnsupportedError,
  type AdmitSupervisedAssignmentTeamRunInput,
  type PreviewTeamRunInput,
} from "../team/service.js";
import {
  TeamNativeDelegationUnenforcedError,
  TeamSupervisorRoleInvalidError,
} from "../team/supervision.js";
import {
  type CreateHubTeamRunAuthorizationInput,
  type HubTeamRunAuthorizationRepository,
  HubTeamRunAuthorizationDeniedError,
  type InspectHubTeamRunSourceInput,
  type RevokeHubTeamRunAuthorizationInput,
} from "./team-run-authorization-repository.js";
import type {
  HubTeamRunAuthorizationPolicy,
  PersistedHubRelationshipIdentity,
  PersistedHubTeamRunAuthorization,
  PersistedHubTeamRunAuthorizationTarget,
  PersistedHubTeamRunSource,
  PersistedHubTriggerIdentity,
} from "./team-run-authorization-model.js";

export type HubTeamRunAuthorizationPolicyInput = Omit<
  HubTeamRunAuthorizationPolicy,
  "launchAllowlist"
>;

export interface ApproveHubTeamRunAuthorizationInput {
  relationship: PersistedHubRelationshipIdentity;
  trigger: PersistedHubTriggerIdentity;
  teamId: string;
  expectedTeamRevision: number;
  assignmentId: string;
  expectedAssignmentRevision: number;
  workspaceId: string;
  supervisorRoleId: string;
  expectedPreviewFingerprint: string;
  policy: HubTeamRunAuthorizationPolicyInput;
  maxUses: number;
  expiresAt: string;
  approvedByPrincipalId: string;
}

export interface ReserveAuthorizedHubTeamRunInput extends InspectHubTeamRunSourceInput {}

export interface AuthorizedHubTeamRunAdmission {
  authorization: PersistedHubTeamRunAuthorization;
  source: PersistedHubTeamRunSource;
  replayed: boolean;
  teamRunInput: AdmitSupervisedAssignmentTeamRunInput & {
    expectedPreviewFingerprint: string;
    unattendedPolicy: PersistedHubTeamRunAuthorization["unattendedPolicy"];
  };
}

export interface HubTeamRunAuthorizationTeamStore {
  getDefinition(teamId: string): Promise<PersistedTeamDefinition | null>;
}

export interface HubTeamRunAuthorizationAssignmentStore {
  getAssignment(assignmentId: string): Promise<PersistedAssignmentRecord | null>;
}

export interface HubTeamRunAuthorizationPreflight {
  getSupervisedAdmissionStatus():
    | "available"
    | "authentication_required"
    | "environment_password_unsupported";
  previewRun(input: PreviewTeamRunInput): Promise<TeamRunPreviewDto>;
}

export interface HubTeamRunAuthorizationServiceOptions {
  repository: HubTeamRunAuthorizationRepository;
  teams: HubTeamRunAuthorizationTeamStore;
  assignments: HubTeamRunAuthorizationAssignmentStore;
  preflight: HubTeamRunAuthorizationPreflight;
}

export class HubTeamRunAuthorizationService {
  constructor(private readonly options: HubTeamRunAuthorizationServiceOptions) {}

  getAuthorization(authorizationId: string): Promise<PersistedHubTeamRunAuthorization | null> {
    return this.options.repository.getAuthorization(authorizationId);
  }

  listAuthorizations(relationshipId?: string): Promise<PersistedHubTeamRunAuthorization[]> {
    return this.options.repository.listAuthorizations(relationshipId);
  }

  listSources(authorizationId: string): Promise<PersistedHubTeamRunSource[]> {
    return this.options.repository.listSourcesForAuthorization(authorizationId);
  }

  async approve(
    input: ApproveHubTeamRunAuthorizationInput,
  ): Promise<PersistedHubTeamRunAuthorization> {
    this.requireSupervisedAdmissionAvailable();
    const definition = await this.requireDefinition(input.teamId, input.expectedTeamRevision);
    const assignment = await this.requireAssignment(
      input.assignmentId,
      input.expectedAssignmentRevision,
    );
    const preview = await this.options.preflight.previewRun({
      teamId: definition.id,
      expectedRevision: definition.revision,
      workspaceId: input.workspaceId,
    });
    if (preview.fingerprint !== input.expectedPreviewFingerprint) {
      throw new TeamSecurityPreviewStaleError();
    }
    const target = buildAuthorizationTarget({
      definition,
      assignment,
      preview,
      supervisorRoleId: input.supervisorRoleId,
    });
    const createInput: CreateHubTeamRunAuthorizationInput = {
      relationship: input.relationship,
      trigger: input.trigger,
      target,
      policy: {
        ...input.policy,
        launchAllowlist: buildLaunchAllowlist(target),
      },
      maxUses: input.maxUses,
      expiresAt: input.expiresAt,
      approvedByPrincipalId: input.approvedByPrincipalId,
    };
    return this.options.repository.createAuthorization(createInput);
  }

  async reserve(input: ReserveAuthorizedHubTeamRunInput): Promise<AuthorizedHubTeamRunAdmission> {
    const inspection = await this.options.repository.inspectSourceReservation(input);
    if (!inspection.existingSource) {
      this.requireSupervisedAdmissionAvailable();
    }
    const reservation = await this.options.repository.reserveSource(
      {
        ...input,
        expectedAuthorizationRevision:
          inspection.existingSource?.authorizationRevision ?? inspection.authorization.revision,
      },
      inspection.existingSource
        ? undefined
        : (authorization) => this.requireCurrentTarget(authorization),
    );
    return {
      ...reservation,
      teamRunInput: toTeamRunInput(reservation.authorization, reservation.source),
    };
  }

  revoke(input: RevokeHubTeamRunAuthorizationInput): Promise<PersistedHubTeamRunAuthorization> {
    return this.options.repository.revokeAuthorization(input);
  }

  async recordAdmittedRun(input: {
    relationshipId: string;
    triggerRunId: string;
    teamRunId: string;
  }): Promise<PersistedHubTeamRunSource> {
    return this.options.repository.bindTeamRun(input);
  }

  private requireSupervisedAdmissionAvailable(): void {
    const status = this.options.preflight.getSupervisedAdmissionStatus();
    if (status === "authentication_required") {
      throw new TeamSupervisedRunAuthenticationRequiredError();
    }
    if (status === "environment_password_unsupported") {
      throw new TeamSupervisedRunEnvironmentPasswordUnsupportedError();
    }
  }

  private async requireCurrentTarget(
    authorization: PersistedHubTeamRunAuthorization,
  ): Promise<void> {
    const definition = await this.requireDefinition(
      authorization.target.team.id,
      authorization.target.team.revision,
    );
    const assignment = await this.requireAssignment(
      authorization.target.assignment.id,
      authorization.target.assignment.revision,
    );
    const preview = await this.options.preflight.previewRun({
      teamId: definition.id,
      expectedRevision: definition.revision,
      workspaceId: authorization.target.workspace.id,
    });
    if (preview.fingerprint !== authorization.target.previewFingerprint) {
      throw new TeamSecurityPreviewStaleError();
    }
    const currentTarget = buildAuthorizationTarget({
      definition,
      assignment,
      preview,
      supervisorRoleId: authorization.target.supervisor.roleId,
    });
    if (!isDeepStrictEqual(currentTarget, authorization.target)) {
      throw new HubTeamRunAuthorizationDeniedError("not_authorized");
    }
  }

  private async requireDefinition(
    teamId: string,
    expectedRevision: number,
  ): Promise<PersistedTeamDefinition> {
    const definition = await this.options.teams.getDefinition(teamId);
    if (!definition) throw new TeamNotFoundError(teamId);
    if (definition.revision !== expectedRevision) {
      throw new TeamRevisionConflictError(teamId, expectedRevision, definition.revision);
    }
    return definition;
  }

  private async requireAssignment(
    assignmentId: string,
    expectedRevision: number,
  ): Promise<PersistedAssignmentRecord> {
    const assignment = await this.options.assignments.getAssignment(assignmentId);
    if (!assignment) throw new AssignmentNotFoundError(assignmentId);
    if (assignment.revision !== expectedRevision) {
      throw new AssignmentRevisionConflictError(
        assignment.id,
        expectedRevision,
        assignment.revision,
      );
    }
    if (assignment.state.status !== "open") {
      throw new AssignmentStateConflictError(assignment.id, assignment.state.status);
    }
    return assignment;
  }
}

function buildAuthorizationTarget(input: {
  definition: PersistedTeamDefinition;
  assignment: PersistedAssignmentRecord;
  preview: TeamRunPreviewDto;
  supervisorRoleId: string;
}): PersistedHubTeamRunAuthorizationTarget {
  const supervisor = input.definition.roles.find((role) => role.id === input.supervisorRoleId);
  if (!supervisor) {
    throw new TeamSupervisorRoleInvalidError(
      input.supervisorRoleId,
      `Team supervisor role does not exist: ${input.supervisorRoleId}`,
    );
  }
  if (input.definition.workflow.some((step) => step.roleId === input.supervisorRoleId)) {
    throw new TeamSupervisorRoleInvalidError(
      input.supervisorRoleId,
      "The supervisor role cannot also be a worker workflow role",
    );
  }

  const selectedRoleIds = new Set([
    input.supervisorRoleId,
    ...input.definition.workflow.map((step) => step.roleId),
  ]);
  const previewByRoleId = new Map(input.preview.roles.map((role) => [role.roleId, role]));
  const launches = input.definition.roles
    .filter((role) => selectedRoleIds.has(role.id))
    .map((role) => {
      const previewRole = previewByRoleId.get(role.id);
      if (!previewRole) {
        throw new TeamSupervisorRoleInvalidError(
          role.id,
          `Team Run preview omitted selected role: ${role.id}`,
        );
      }
      const posture = previewRole.resolvedLaunch.securityPosture;
      if (posture?.nativeDelegation?.status !== "enforced") {
        throw new TeamNativeDelegationUnenforcedError(role.id, previewRole.resolvedLaunch.provider);
      }
      return {
        roleId: role.id,
        roleName: role.name,
        profileId: previewRole.resolvedLaunch.profileId,
        provider: previewRole.resolvedLaunch.provider,
        model: previewRole.resolvedLaunch.model,
        securityPosture: posture,
      };
    });
  if (launches.length !== selectedRoleIds.size) {
    throw new TeamSupervisorRoleInvalidError(
      input.supervisorRoleId,
      "The selected Team roles are not available for supervised execution",
    );
  }

  return {
    team: {
      id: input.definition.id,
      revision: input.definition.revision,
      name: input.definition.name,
    },
    assignment: {
      id: input.assignment.id,
      revision: input.assignment.revision,
      title: input.assignment.title,
    },
    workspace: {
      id: input.preview.workspace.workspaceId,
      projectId: input.preview.workspace.projectId,
      displayName: input.preview.workspace.displayName,
    },
    supervisor: { roleId: supervisor.id, roleName: supervisor.name },
    launches,
    previewFingerprint: input.preview.fingerprint,
  };
}

function buildLaunchAllowlist(
  target: PersistedHubTeamRunAuthorizationTarget,
): HubTeamRunAuthorizationPolicy["launchAllowlist"] {
  const modelsByProvider = new Map<string, Array<string | null>>();
  for (const launch of target.launches) {
    const models = modelsByProvider.get(launch.provider) ?? [];
    if (!models.includes(launch.model)) models.push(launch.model);
    modelsByProvider.set(launch.provider, models);
  }
  return Array.from(modelsByProvider, ([provider, models]) => ({ provider, models }));
}

function toTeamRunInput(
  authorization: PersistedHubTeamRunAuthorization,
  source: PersistedHubTeamRunSource,
): AuthorizedHubTeamRunAdmission["teamRunInput"] {
  return {
    teamId: authorization.target.team.id,
    expectedRevision: authorization.target.team.revision,
    idempotencyKey: source.idempotencyKey,
    assignmentId: authorization.target.assignment.id,
    expectedAssignmentRevision: authorization.target.assignment.revision,
    workspaceId: authorization.target.workspace.id,
    supervisorRoleId: authorization.target.supervisor.roleId,
    expectedPreviewFingerprint: authorization.target.previewFingerprint,
    unattendedPolicy: authorization.unattendedPolicy,
  };
}
