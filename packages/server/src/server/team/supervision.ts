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
    humanRequest: null,
    updatedAt: input.timestamp,
  });
}
