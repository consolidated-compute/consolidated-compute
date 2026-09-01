import {
  TeamDefinitionDtoSchema,
  TeamRunDtoSchema,
  TeamRunSupervisionEventDtoSchema,
  TeamRunSupervisionStateDtoSchema,
  type TeamDefinitionDto,
  type TeamRunDto,
  type TeamRunSupervisionEventDto,
  type TeamRunSupervisionStateDto,
} from "@getpaseo/protocol/team/types";

import type {
  PersistedTeamDefinition,
  PersistedTeamRunRecord,
  PersistedTeamRunSupervision,
} from "./model.js";

export function toTeamDefinitionDto(definition: PersistedTeamDefinition): TeamDefinitionDto {
  return TeamDefinitionDtoSchema.parse(definition);
}

export function toTeamRunDto(run: PersistedTeamRunRecord): TeamRunDto {
  const supervision = run.supervision
    ? {
        status: run.supervision.phase,
        supervisorRoleId: run.supervision.supervisor.roleId,
        supervisorAgentId: run.supervision.supervisor.agentId,
        completedWorkItems: run.supervision.workItems.filter(
          (workItem) => workItem.status === "succeeded",
        ).length,
        totalWorkItems: run.supervision.workItems.length,
        ...(run.supervision.humanRequest &&
        !run.supervision.humanRequest.resolution &&
        !run.supervision.humanRequest.retirement
          ? {
              pendingHumanRequest: {
                id: run.supervision.humanRequest.id,
                kind: run.supervision.humanRequest.kind,
                title: run.supervision.humanRequest.title,
                revision: run.supervision.humanRequest.revision,
              },
            }
          : {}),
        updatedAt: run.supervision.updatedAt,
      }
    : undefined;
  return TeamRunDtoSchema.parse({
    ...run,
    ...(supervision ? { supervision } : {}),
  });
}

export function toTeamRunSupervisionStateDto(
  run: PersistedTeamRunRecord & { supervision: PersistedTeamRunSupervision },
): TeamRunSupervisionStateDto {
  const request = run.supervision.humanRequest;
  const humanRequest = request
    ? {
        id: request.id,
        revision: request.revision,
        kind: request.kind,
        title: request.title,
        detail: request.detail,
        actions: request.actions,
        roleIds: request.roleIds,
        agentIds: request.agentIds,
        stepIds: request.stepIds,
        artifactIds: request.artifactIds,
        createdAt: request.createdAt,
        ...(request.resolution
          ? {
              resolution: {
                actionId: request.resolution.actionId,
                note: request.resolution.note,
                resolvedAt: request.resolution.resolvedAt,
              },
            }
          : {}),
        ...(request.retirement ? { retirement: request.retirement } : {}),
      }
    : null;
  return TeamRunSupervisionStateDtoSchema.parse({
    runId: run.id,
    revision: run.supervision.revision,
    status: run.supervision.phase,
    supervisorRoleId: run.supervision.supervisor.roleId,
    supervisorAgentId: run.supervision.supervisor.agentId,
    completedWorkItems: run.supervision.workItems.filter(
      (workItem) => workItem.status === "succeeded",
    ).length,
    totalWorkItems: run.supervision.workItems.length,
    humanRequest,
    updatedAt: run.supervision.updatedAt,
  });
}

export function toTeamRunSupervisionEventDto(
  event: NonNullable<PersistedTeamRunSupervision["events"]>[number],
): TeamRunSupervisionEventDto {
  return TeamRunSupervisionEventDtoSchema.parse(event);
}
