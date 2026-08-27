import { randomBytes } from "node:crypto";

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
export const ASSIGNMENT_ARTIFACT_KIND_MAX_CHARS = 128;
export const ASSIGNMENT_ARTIFACT_TITLE_MAX_CHARS = 120;
export const ASSIGNMENT_ARTIFACT_CONTENT_MAX_BYTES = 32 * 1_024;
export const ASSIGNMENT_TURN_ID_MAX_CHARS = 512;

const SAFE_ENTITY_ID_MAX_CHARS = 128;
const MAX_RECORDED_BYTE_LENGTH = Number.MAX_SAFE_INTEGER;

function nonBlankStringSchema(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0, "Must contain non-whitespace characters");
}

function openTokenSchema(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .regex(/^[a-z][a-z0-9._-]*$/, "Must be a lowercase token");
}

const TimestampSchema = z.string().datetime({ offset: true });
const AssignmentIdSchema = z.string().regex(/^asgn_[0-9a-f]{16}$/);
const AssignmentArtifactIdSchema = z.string().regex(/^aart_[0-9a-f]{16}$/);
const TeamRunIdSchema = z.string().regex(/^trun_[0-9a-f]{16}$/);
const SafeEntityIdSchema = z
  .string()
  .min(1)
  .max(SAFE_ENTITY_ID_MAX_CHARS)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const HttpUrlSchema = z
  .url()
  .max(ASSIGNMENT_WORK_ITEM_URL_MAX_CHARS)
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "Must use http or https");

export const PersistedAssignmentWorkItemReferenceSchema = z
  .object({
    sourceId: nonBlankStringSchema(ASSIGNMENT_WORK_ITEM_SOURCE_ID_MAX_CHARS),
    sourceLabel: nonBlankStringSchema(ASSIGNMENT_WORK_ITEM_SOURCE_LABEL_MAX_CHARS),
    resourceType: openTokenSchema(ASSIGNMENT_WORK_ITEM_RESOURCE_TYPE_MAX_CHARS),
    resourceId: nonBlankStringSchema(ASSIGNMENT_WORK_ITEM_RESOURCE_ID_MAX_CHARS),
    identifier: nonBlankStringSchema(ASSIGNMENT_WORK_ITEM_IDENTIFIER_MAX_CHARS),
    title: nonBlankStringSchema(ASSIGNMENT_WORK_ITEM_TITLE_MAX_CHARS),
    url: HttpUrlSchema,
  })
  .strict();

const OpenAssignmentStateSchema = z.object({ status: z.literal("open") }).strict();
const CompletedAssignmentStateSchema = z
  .object({
    status: z.literal("completed"),
    completedAt: TimestampSchema,
  })
  .strict();
const CanceledAssignmentStateSchema = z
  .object({
    status: z.literal("canceled"),
    canceledAt: TimestampSchema,
  })
  .strict();

export const PersistedAssignmentStateSchema = z.discriminatedUnion("status", [
  OpenAssignmentStateSchema,
  CompletedAssignmentStateSchema,
  CanceledAssignmentStateSchema,
]);

export const PersistedAssignmentRecordSchema = z
  .object({
    id: AssignmentIdSchema,
    revision: z.number().int().positive(),
    title: nonBlankStringSchema(ASSIGNMENT_TITLE_MAX_CHARS),
    objective: nonBlankStringSchema(ASSIGNMENT_OBJECTIVE_MAX_CHARS),
    workItem: PersistedAssignmentWorkItemReferenceSchema.nullable(),
    state: PersistedAssignmentStateSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((assignment, context) => {
    const createdAt = Date.parse(assignment.createdAt);
    const updatedAt = Date.parse(assignment.updatedAt);
    if (updatedAt < createdAt) {
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "updatedAt cannot precede createdAt",
      });
    }

    let lifecycleTimestamp: string | null = null;
    if (assignment.state.status === "completed") {
      lifecycleTimestamp = assignment.state.completedAt;
    } else if (assignment.state.status === "canceled") {
      lifecycleTimestamp = assignment.state.canceledAt;
    }
    if (lifecycleTimestamp === null) return;

    if (Date.parse(lifecycleTimestamp) < createdAt) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "Lifecycle timestamp cannot precede createdAt",
      });
    }
    if (Date.parse(lifecycleTimestamp) !== updatedAt) {
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "updatedAt must match the terminal lifecycle timestamp",
      });
    }
  });

const AssignmentArtifactContentSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, "Must contain non-whitespace characters")
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= ASSIGNMENT_ARTIFACT_CONTENT_MAX_BYTES,
    `Content exceeds ${ASSIGNMENT_ARTIFACT_CONTENT_MAX_BYTES} UTF-8 bytes`,
  );

export const PersistedAssignmentArtifactProducerSchema = z
  .object({
    kind: z.literal("team_run_step"),
    teamRunId: TeamRunIdSchema,
    stepId: SafeEntityIdSchema,
    roleId: SafeEntityIdSchema,
    agentId: z.guid(),
    turnId: nonBlankStringSchema(ASSIGNMENT_TURN_ID_MAX_CHARS).nullable(),
  })
  .strict();

export const PersistedAssignmentArtifactRecordSchema = z
  .object({
    id: AssignmentArtifactIdSchema,
    assignmentId: AssignmentIdSchema,
    assignmentRevision: z.number().int().positive(),
    kind: openTokenSchema(ASSIGNMENT_ARTIFACT_KIND_MAX_CHARS),
    title: nonBlankStringSchema(ASSIGNMENT_ARTIFACT_TITLE_MAX_CHARS),
    mediaType: z.literal("text/markdown"),
    content: AssignmentArtifactContentSchema,
    includedBytes: z.number().int().positive().max(ASSIGNMENT_ARTIFACT_CONTENT_MAX_BYTES),
    originalBytes: z.number().int().positive().max(MAX_RECORDED_BYTE_LENGTH),
    truncated: z.boolean(),
    producer: PersistedAssignmentArtifactProducerSchema,
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((artifact, context) => {
    const contentBytes = Buffer.byteLength(artifact.content, "utf8");
    if (artifact.includedBytes !== contentBytes) {
      context.addIssue({
        code: "custom",
        path: ["includedBytes"],
        message: "includedBytes must equal the UTF-8 byte length of content",
      });
    }
    if (artifact.originalBytes < artifact.includedBytes) {
      context.addIssue({
        code: "custom",
        path: ["originalBytes"],
        message: "originalBytes cannot be less than includedBytes",
      });
    }
    const shouldBeTruncated = artifact.originalBytes > artifact.includedBytes;
    if (artifact.truncated !== shouldBeTruncated) {
      context.addIssue({
        code: "custom",
        path: ["truncated"],
        message: shouldBeTruncated
          ? "truncated must be true when originalBytes exceeds includedBytes"
          : "truncated must be false when all original bytes are included",
      });
    }
  });

export type PersistedAssignmentWorkItemReference = z.infer<
  typeof PersistedAssignmentWorkItemReferenceSchema
>;
export type PersistedAssignmentState = z.infer<typeof PersistedAssignmentStateSchema>;
export type PersistedAssignmentRecord = z.infer<typeof PersistedAssignmentRecordSchema>;
export type PersistedAssignmentArtifactProducer = z.infer<
  typeof PersistedAssignmentArtifactProducerSchema
>;
export type PersistedAssignmentArtifactRecord = z.infer<
  typeof PersistedAssignmentArtifactRecordSchema
>;

export function generateAssignmentId(): string {
  return `asgn_${randomBytes(8).toString("hex")}`;
}

export function generateAssignmentArtifactId(): string {
  return `aart_${randomBytes(8).toString("hex")}`;
}
