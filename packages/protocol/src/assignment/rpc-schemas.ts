import { z } from "zod";

import {
  AssignmentArtifactDtoSchema,
  AssignmentCollectionIssueDtoSchema,
  AssignmentDtoSchema,
  AssignmentInputDtoSchema,
  AssignmentPatchDtoSchema,
} from "./types.js";
import { TeamRunDtoSchema } from "../team/types.js";

export const ASSIGNMENT_ARTIFACT_PAGE_MAX_LIMIT = 100;

export const ASSIGNMENT_RPC_ERROR_CODES = [
  "assignments_unsupported",
  "assignment_not_found",
  "assignment_artifact_not_found",
  "assignment_revision_conflict",
  "assignment_state_conflict",
  "assignment_has_active_run",
  "assignment_patch_empty",
  "assignment_artifact_conflict",
  "assignment_artifact_revision_unavailable",
  "invalid_assignment_artifact_page",
  "invalid_assignment_repository_id",
  "assignment_storage_corrupt",
  "assignment_request_failed",
] as const;

export const AssignmentRpcErrorCodeSchema = z.enum(ASSIGNMENT_RPC_ERROR_CODES);
export type AssignmentRpcErrorCode = z.infer<typeof AssignmentRpcErrorCodeSchema>;

export const AssignmentCreateRequestSchema = z.object({
  type: z.literal("assignment.create.request"),
  requestId: z.string(),
  assignment: AssignmentInputDtoSchema,
});

export const AssignmentListRequestSchema = z.object({
  type: z.literal("assignment.list.request"),
  requestId: z.string(),
});

export const AssignmentGetRequestSchema = z.object({
  type: z.literal("assignment.get.request"),
  requestId: z.string(),
  assignmentId: z.string(),
});

export const AssignmentPatchRequestSchema = z.object({
  type: z.literal("assignment.patch.request"),
  requestId: z.string(),
  assignmentId: z.string(),
  expectedRevision: z.number().int().positive(),
  patch: AssignmentPatchDtoSchema,
});

const AssignmentTransitionRequestFieldsSchema = z.object({
  requestId: z.string(),
  assignmentId: z.string(),
  expectedRevision: z.number().int().positive(),
});

export const AssignmentCompleteRequestSchema = AssignmentTransitionRequestFieldsSchema.extend({
  type: z.literal("assignment.complete.request"),
});

export const AssignmentCancelRequestSchema = AssignmentTransitionRequestFieldsSchema.extend({
  type: z.literal("assignment.cancel.request"),
});

export const AssignmentArtifactGetRequestSchema = z.object({
  type: z.literal("assignment.artifact.get.request"),
  requestId: z.string(),
  artifactId: z.string(),
});

export const AssignmentArtifactListRequestSchema = z.object({
  type: z.literal("assignment.artifact.list.request"),
  requestId: z.string(),
  assignmentId: z.string(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(ASSIGNMENT_ARTIFACT_PAGE_MAX_LIMIT).optional(),
});

export const AssignmentTeamRunStartRequestSchema = z.object({
  type: z.literal("assignment.team_run.start.request"),
  requestId: z.string(),
  teamId: z.string(),
  expectedRevision: z.number().int().positive(),
  idempotencyKey: z.string(),
  assignmentId: z.string(),
  expectedAssignmentRevision: z.number().int().positive(),
  workspaceId: z.string(),
});

const assignmentPayload = <const TType extends string>(type: TType) =>
  z.object({
    type: z.literal(type),
    payload: z.object({ requestId: z.string(), assignment: AssignmentDtoSchema }),
  });

export const AssignmentCreateResponseSchema = assignmentPayload("assignment.create.response");
export const AssignmentGetResponseSchema = assignmentPayload("assignment.get.response");
export const AssignmentPatchResponseSchema = assignmentPayload("assignment.patch.response");
export const AssignmentCompleteResponseSchema = assignmentPayload("assignment.complete.response");
export const AssignmentCancelResponseSchema = assignmentPayload("assignment.cancel.response");

export const AssignmentListResponseSchema = z.object({
  type: z.literal("assignment.list.response"),
  payload: z.object({
    requestId: z.string(),
    assignments: z.array(AssignmentDtoSchema),
    issues: z.array(AssignmentCollectionIssueDtoSchema).optional(),
  }),
});

export const AssignmentArtifactGetResponseSchema = z.object({
  type: z.literal("assignment.artifact.get.response"),
  payload: z.object({ requestId: z.string(), artifact: AssignmentArtifactDtoSchema }),
});

export const AssignmentArtifactListResponseSchema = z.object({
  type: z.literal("assignment.artifact.list.response"),
  payload: z.object({
    requestId: z.string(),
    artifacts: z.array(AssignmentArtifactDtoSchema),
    nextCursor: z.string().nullable(),
    issues: z.array(AssignmentCollectionIssueDtoSchema).optional(),
  }),
});

export const AssignmentTeamRunStartResponseSchema = z.object({
  type: z.literal("assignment.team_run.start.response"),
  payload: z.object({ requestId: z.string(), run: TeamRunDtoSchema }),
});

export type AssignmentCreateRequest = z.infer<typeof AssignmentCreateRequestSchema>;
export type AssignmentListRequest = z.infer<typeof AssignmentListRequestSchema>;
export type AssignmentGetRequest = z.infer<typeof AssignmentGetRequestSchema>;
export type AssignmentPatchRequest = z.infer<typeof AssignmentPatchRequestSchema>;
export type AssignmentCompleteRequest = z.infer<typeof AssignmentCompleteRequestSchema>;
export type AssignmentCancelRequest = z.infer<typeof AssignmentCancelRequestSchema>;
export type AssignmentArtifactGetRequest = z.infer<typeof AssignmentArtifactGetRequestSchema>;
export type AssignmentArtifactListRequest = z.infer<typeof AssignmentArtifactListRequestSchema>;
export type AssignmentTeamRunStartRequest = z.infer<typeof AssignmentTeamRunStartRequestSchema>;
