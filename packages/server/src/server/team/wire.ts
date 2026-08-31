import {
  TeamDefinitionDtoSchema,
  TeamRunDtoSchema,
  type TeamDefinitionDto,
  type TeamRunDto,
} from "@getpaseo/protocol/team/types";

import type { PersistedTeamDefinition, PersistedTeamRunRecord } from "./model.js";

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
