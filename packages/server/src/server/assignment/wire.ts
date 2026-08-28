import {
  AssignmentArtifactDtoSchema,
  AssignmentCollectionIssueDtoSchema,
  AssignmentDtoSchema,
  type AssignmentArtifactDto,
  type AssignmentCollectionIssueDto,
  type AssignmentDto,
} from "@getpaseo/protocol/assignment/types";

import type { PersistedAssignmentArtifactRecord, PersistedAssignmentRecord } from "./model.js";
import type { AssignmentRepositoryFileIssue } from "./repository.js";

export function toAssignmentDto(assignment: PersistedAssignmentRecord): AssignmentDto {
  return AssignmentDtoSchema.parse(assignment);
}

export function toAssignmentArtifactDto(
  artifact: PersistedAssignmentArtifactRecord,
): AssignmentArtifactDto {
  return AssignmentArtifactDtoSchema.parse(artifact);
}

export function toAssignmentCollectionIssueDto(
  issue: AssignmentRepositoryFileIssue,
): AssignmentCollectionIssueDto {
  return AssignmentCollectionIssueDtoSchema.parse(issue);
}
