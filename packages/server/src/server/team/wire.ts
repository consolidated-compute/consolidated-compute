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
  return TeamRunDtoSchema.parse(run);
}
