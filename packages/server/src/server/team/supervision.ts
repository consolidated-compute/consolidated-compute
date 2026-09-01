import type { AcceptedTeamRunFacts } from "./execution.js";
import {
  PersistedTeamRunSupervisionSchema,
  TEAM_SUPERVISION_MAX_ATTEMPTS_PER_WORK_ITEM,
  TEAM_SUPERVISION_MAX_DECISIONS,
  TEAM_SUPERVISION_MAX_WORK_ITEMS,
  type PersistedTeamDefinition,
  type PersistedTeamRunSupervision,
} from "./model.js";

export interface CreateTeamRunSupervisionInput {
  definition: PersistedTeamDefinition;
  accepted: AcceptedTeamRunFacts;
  supervisorRoleId: string;
  supervisorAgentId: string;
  timestamp: string;
}

export class TeamSupervisorRoleInvalidError extends Error {
  readonly code = "team_supervisor_role_invalid";

  constructor(
    readonly roleId: string,
    message: string,
  ) {
    super(message);
    this.name = "TeamSupervisorRoleInvalidError";
  }
}

export class TeamNativeDelegationUnenforcedError extends Error {
  readonly code = "team_native_delegation_unenforced";

  constructor(
    readonly roleId: string,
    readonly provider: string,
  ) {
    super(
      `Team role ${roleId} cannot join a supervised run because provider '${provider}' does not prove native delegation is disabled`,
    );
    this.name = "TeamNativeDelegationUnenforcedError";
  }
}

export function createInitialTeamRunSupervision(
  input: CreateTeamRunSupervisionInput,
): PersistedTeamRunSupervision {
  const role = input.definition.roles.find((candidate) => candidate.id === input.supervisorRoleId);
  const acceptedRole = input.accepted.roles.find(
    (candidate) => candidate.roleId === input.supervisorRoleId,
  );
  if (!role || !acceptedRole) {
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

  requireLaunchNativeDelegationDisabled(role.id, acceptedRole.resolvedLaunch);
  for (const step of input.accepted.steps) {
    requireLaunchNativeDelegationDisabled(step.snapshot.roleId, step.snapshot.resolvedLaunch);
  }

  return PersistedTeamRunSupervisionSchema.parse({
    revision: 1,
    phase: "queued",
    supervisor: {
      roleId: role.id,
      roleName: role.name,
      roleInstructions: role.instructions,
      resolvedLaunch: acceptedRole.resolvedLaunch,
      agentId: input.supervisorAgentId,
    },
    workerTemplates: input.accepted.steps.map((step) => {
      const {
        inputArtifactIds: _inputArtifactIds,
        outputArtifact: _outputArtifact,
        supervision: _supervision,
        ...template
      } = step.snapshot;
      return template;
    }),
    limits: {
      maxWorkItems: TEAM_SUPERVISION_MAX_WORK_ITEMS,
      maxActiveWorkers: 1,
      maxAttemptsPerWorkItem: TEAM_SUPERVISION_MAX_ATTEMPTS_PER_WORK_ITEM,
      maxSupervisorActions: TEAM_SUPERVISION_MAX_DECISIONS,
      maxDelegationDepth: 1,
    },
    workItems: [],
    decisions: [],
    events: [],
    humanRequest: null,
    updatedAt: input.timestamp,
  });
}

export function requireSupervisionNativeDelegationDisabled(
  supervision: PersistedTeamRunSupervision,
): void {
  requireLaunchNativeDelegationDisabled(
    supervision.supervisor.roleId,
    supervision.supervisor.resolvedLaunch,
  );
  for (const template of supervision.workerTemplates) {
    requireLaunchNativeDelegationDisabled(template.roleId, template.resolvedLaunch);
  }
}

function requireLaunchNativeDelegationDisabled(
  roleId: string,
  launch: PersistedTeamRunSupervision["supervisor"]["resolvedLaunch"],
): void {
  if (launch.securityPosture?.nativeDelegation?.status === "enforced") return;
  throw new TeamNativeDelegationUnenforcedError(roleId, launch.provider);
}
