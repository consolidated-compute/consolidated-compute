import { z } from "zod";

export const ASSIGNMENT_TITLE_MAX_CHARS = 120;
export const ASSIGNMENT_OBJECTIVE_MAX_CHARS = 32_000;
export const ASSIGNMENT_WORK_ITEM_SOURCE_ID_MAX_CHARS = 128;
export const ASSIGNMENT_WORK_ITEM_SOURCE_LABEL_MAX_CHARS = 120;
export const ASSIGNMENT_WORK_ITEM_RESOURCE_TYPE_MAX_CHARS = 128;
export const ASSIGNMENT_WORK_ITEM_RESOURCE_ID_MAX_CHARS = 2_048;
export const ASSIGNMENT_WORK_ITEM_IDENTIFIER_MAX_CHARS = 256;
export const ASSIGNMENT_WORK_ITEM_TITLE_MAX_CHARS = 512;
export const ASSIGNMENT_WORK_ITEM_URL_MAX_CHARS = 8_192;

export const AssignmentWorkItemReferenceDtoSchema = z.object({
  sourceId: z.string(),
  sourceLabel: z.string(),
  resourceType: z.string(),
  resourceId: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
});

export const AssignmentStateDtoSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("open") }),
  z.object({ status: z.literal("completed"), completedAt: z.string() }),
  z.object({ status: z.literal("canceled"), canceledAt: z.string() }),
]);

export const AssignmentInputDtoSchema = z.object({
  title: z.string(),
  objective: z.string(),
  workItem: AssignmentWorkItemReferenceDtoSchema.nullable(),
});

const AssignmentPatchFieldsDtoSchema = AssignmentInputDtoSchema.partial();

export const AssignmentPatchDtoSchema = z.union([
  AssignmentPatchFieldsDtoSchema.extend({ title: AssignmentInputDtoSchema.shape.title }),
  AssignmentPatchFieldsDtoSchema.extend({ objective: AssignmentInputDtoSchema.shape.objective }),
  AssignmentPatchFieldsDtoSchema.extend({ workItem: AssignmentInputDtoSchema.shape.workItem }),
]);

export const AssignmentDtoSchema = AssignmentInputDtoSchema.extend({
  id: z.string(),
  revision: z.number().int(),
  state: AssignmentStateDtoSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const AssignmentArtifactProducerDtoSchema = z.object({
  kind: z.literal("team_run_step"),
  teamRunId: z.string(),
  stepId: z.string(),
  roleId: z.string(),
  agentId: z.string(),
  turnId: z.string().nullable(),
});

export const AssignmentArtifactDtoSchema = z.object({
  id: z.string(),
  assignmentId: z.string(),
  assignmentRevision: z.number().int(),
  kind: z.string(),
  title: z.string(),
  mediaType: z.literal("text/markdown"),
  content: z.string(),
  includedBytes: z.number().int(),
  originalBytes: z.number().int(),
  truncated: z.boolean(),
  producer: AssignmentArtifactProducerDtoSchema,
  createdAt: z.string(),
});

export const AssignmentCollectionIssueDtoSchema = z.object({
  collection: z.enum(["records", "artifacts"]),
  fileName: z.string(),
  kind: z.enum(["unknown_file", "invalid_record"]),
  message: z.string(),
});

export type AssignmentWorkItemReferenceDto = z.infer<typeof AssignmentWorkItemReferenceDtoSchema>;
export type AssignmentStateDto = z.infer<typeof AssignmentStateDtoSchema>;
export type AssignmentInputDto = z.infer<typeof AssignmentInputDtoSchema>;
export type AssignmentPatchDto = z.infer<typeof AssignmentPatchDtoSchema>;
export type AssignmentDto = z.infer<typeof AssignmentDtoSchema>;
export type AssignmentArtifactProducerDto = z.infer<typeof AssignmentArtifactProducerDtoSchema>;
export type AssignmentArtifactDto = z.infer<typeof AssignmentArtifactDtoSchema>;
export type AssignmentCollectionIssueDto = z.infer<typeof AssignmentCollectionIssueDtoSchema>;
