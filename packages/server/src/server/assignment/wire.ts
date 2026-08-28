import {
  AssignmentArtifactDtoSchema,
  AssignmentDtoSchema,
  type AssignmentArtifactDto,
  type AssignmentDto,
} from "@getpaseo/protocol/assignment/types";

import type { PersistedAssignmentArtifactRecord, PersistedAssignmentRecord } from "./model.js";

export function toAssignmentDto(assignment: PersistedAssignmentRecord): AssignmentDto {
  return AssignmentDtoSchema.parse(assignment);
}

export function toAssignmentArtifactDto(
  artifact: PersistedAssignmentArtifactRecord,
): AssignmentArtifactDto {
  return AssignmentArtifactDtoSchema.parse(artifact);
}
