import { randomBytes } from "node:crypto";

import equal from "fast-deep-equal";
import { z } from "zod";

import {
  TEAM_AGENT_PROFILE_ID_MAX_CHARS,
  TEAM_INSTRUCTIONS_MAX_CHARS,
  TEAM_MAX_ROLES,
  TEAM_MAX_WORKFLOW_STEPS,
  TEAM_NAME_MAX_CHARS,
  TEAM_OBJECTIVE_MAX_CHARS,
  TEAM_ROLE_NAME_MAX_CHARS,
} from "@getpaseo/protocol/team/types";
import {
  ASSIGNMENT_ARTIFACT_TITLE_MAX_CHARS,
  PersistedAssignmentArtifactIdSchema,
  PersistedAssignmentIdSchema,
  PersistedAssignmentRecordSchema,
} from "../assignment/model.js";
import { ProviderSecurityPostureSchema } from "../agent/provider-security-posture.js";

export {
  TEAM_AGENT_PROFILE_ID_MAX_CHARS,
  TEAM_INSTRUCTIONS_MAX_CHARS,
  TEAM_MAX_ROLES,
  TEAM_MAX_WORKFLOW_STEPS,
  TEAM_NAME_MAX_CHARS,
  TEAM_OBJECTIVE_MAX_CHARS,
  TEAM_ROLE_NAME_MAX_CHARS,
} from "@getpaseo/protocol/team/types";

export const TEAM_ERROR_MAX_CHARS = 4_096;
export const TEAM_IDEMPOTENCY_KEY_MAX_CHARS = 256;
export const TEAM_PROVIDER_ID_MAX_CHARS = 128;
export const TEAM_MODEL_ID_MAX_CHARS = 256;
export const TEAM_MODE_ID_MAX_CHARS = 256;
export const TEAM_THINKING_OPTION_ID_MAX_CHARS = 256;
export const TEAM_ENTITY_ID_MAX_CHARS = 128;
export const TEAM_HANDOFF_MAX_BYTES = 4_096;
export const TEAM_SUPERVISION_DECISION_SUMMARY_MAX_CHARS = 4_096;
export const TEAM_SUPERVISION_HUMAN_REQUEST_DETAIL_MAX_CHARS = 8_192;
export const TEAM_SUPERVISION_HUMAN_REQUEST_NOTE_MAX_CHARS = 4_096;
export const TEAM_SUPERVISION_HUMAN_REQUEST_TITLE_MAX_CHARS = 256;
export const TEAM_SUPERVISION_MAX_ATTEMPTS_PER_WORK_ITEM = 4;
export const TEAM_SUPERVISION_MAX_DECISIONS = 128;
export const TEAM_SUPERVISION_MAX_HUMAN_ACTIONS = 8;
export const TEAM_SUPERVISION_MAX_RUN_STEPS = 256;
export const TEAM_SUPERVISION_MAX_WORK_ITEMS = TEAM_MAX_WORKFLOW_STEPS;

function nonBlankStringSchema(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0, "Must contain non-whitespace characters");
}

export const PersistedTeamEntityIdSchema = z
  .string()
  .min(1)
  .max(TEAM_ENTITY_ID_MAX_CHARS)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const WorkspaceRegistryIdSchema = nonBlankStringSchema(8_192);
const TimestampSchema = z.string().datetime({ offset: true });
const ErrorSchema = nonBlankStringSchema(TEAM_ERROR_MAX_CHARS);

export const PersistedTeamResolvedLaunchSchema = z
  .object({
    profileId: nonBlankStringSchema(TEAM_AGENT_PROFILE_ID_MAX_CHARS),
    provider: nonBlankStringSchema(TEAM_PROVIDER_ID_MAX_CHARS),
    model: nonBlankStringSchema(TEAM_MODEL_ID_MAX_CHARS).nullable(),
    modeId: nonBlankStringSchema(TEAM_MODE_ID_MAX_CHARS).nullable(),
    thinkingOptionId: nonBlankStringSchema(TEAM_THINKING_OPTION_ID_MAX_CHARS).nullable(),
    featureValues: z.record(z.string(), z.json()),
    providerOptions: z.record(z.string(), z.json()).optional(),
    securityPosture: ProviderSecurityPostureSchema.optional(),
  })
  .strict()
  .superRefine((launch, context) => {
    if (launch.securityPosture && launch.securityPosture.source.provider !== launch.provider) {
      context.addIssue({
        code: "custom",
        path: ["securityPosture", "source", "provider"],
        message: "Security posture source must match the resolved launch provider",
      });
    }
  });

export const PersistedTeamRoleSchema = z
  .object({
    id: PersistedTeamEntityIdSchema,
    name: nonBlankStringSchema(TEAM_ROLE_NAME_MAX_CHARS),
    instructions: nonBlankStringSchema(TEAM_INSTRUCTIONS_MAX_CHARS),
    profileId: nonBlankStringSchema(TEAM_AGENT_PROFILE_ID_MAX_CHARS),
  })
  .strict();

export const PersistedTeamWorkflowStepSchema = z
  .object({
    id: PersistedTeamEntityIdSchema,
    roleId: PersistedTeamEntityIdSchema,
    instructions: nonBlankStringSchema(TEAM_INSTRUCTIONS_MAX_CHARS).nullable(),
  })
  .strict();

export const PersistedTeamDefinitionSchema = z
  .object({
    id: PersistedTeamEntityIdSchema,
    revision: z.number().int().positive(),
    name: nonBlankStringSchema(TEAM_NAME_MAX_CHARS),
    instructions: nonBlankStringSchema(TEAM_INSTRUCTIONS_MAX_CHARS),
    roles: z.array(PersistedTeamRoleSchema).min(1).max(TEAM_MAX_ROLES),
    workflow: z.array(PersistedTeamWorkflowStepSchema).min(1).max(TEAM_MAX_WORKFLOW_STEPS),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((team, context) => {
    const roleIds = new Set<string>();
    for (const [index, role] of team.roles.entries()) {
      if (roleIds.has(role.id)) {
        context.addIssue({
          code: "custom",
          path: ["roles", index, "id"],
          message: `Duplicate role ID: ${role.id}`,
        });
      }
      roleIds.add(role.id);
    }

    const stepIds = new Set<string>();
    for (const [index, step] of team.workflow.entries()) {
      if (stepIds.has(step.id)) {
        context.addIssue({
          code: "custom",
          path: ["workflow", index, "id"],
          message: `Duplicate workflow step ID: ${step.id}`,
        });
      }
      stepIds.add(step.id);
      if (!roleIds.has(step.roleId)) {
        context.addIssue({
          code: "custom",
          path: ["workflow", index, "roleId"],
          message: `Unknown role ID: ${step.roleId}`,
        });
      }
    }

    if (Date.parse(team.updatedAt) < Date.parse(team.createdAt)) {
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "updatedAt cannot precede createdAt",
      });
    }
  });

export const PersistedTeamRunWorkspaceSnapshotSchema = z
  .object({
    workspaceId: WorkspaceRegistryIdSchema,
    projectId: WorkspaceRegistryIdSchema,
    cwd: z.string().min(1).max(8_192),
    displayName: nonBlankStringSchema(512),
  })
  .strict();

export const PersistedTeamRunArtifactOutputSchema = z
  .object({
    id: PersistedAssignmentArtifactIdSchema,
    kind: z.literal("team_step_output"),
    title: nonBlankStringSchema(ASSIGNMENT_ARTIFACT_TITLE_MAX_CHARS),
    mediaType: z.literal("text/markdown"),
  })
  .strict();

export const PersistedTeamRunStepSnapshotSchema = z
  .object({
    stepId: PersistedTeamEntityIdSchema,
    roleId: PersistedTeamEntityIdSchema,
    roleName: nonBlankStringSchema(TEAM_ROLE_NAME_MAX_CHARS),
    roleInstructions: nonBlankStringSchema(TEAM_INSTRUCTIONS_MAX_CHARS),
    stepInstructions: nonBlankStringSchema(TEAM_INSTRUCTIONS_MAX_CHARS).nullable(),
    resolvedLaunch: PersistedTeamResolvedLaunchSchema,
    inputArtifactIds: z
      .array(PersistedAssignmentArtifactIdSchema)
      .max(TEAM_MAX_WORKFLOW_STEPS)
      .optional(),
    outputArtifact: PersistedTeamRunArtifactOutputSchema.optional(),
    supervision: z
      .discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("supervisor"),
            turn: z.number().int().positive(),
            decisionId: PersistedTeamEntityIdSchema,
          })
          .strict(),
        z
          .object({
            kind: z.literal("worker"),
            workItemId: PersistedTeamEntityIdSchema,
            attemptId: PersistedTeamEntityIdSchema,
            attemptNumber: z.number().int().positive(),
            templateStepId: PersistedTeamEntityIdSchema,
            revisionParentAttemptId: PersistedTeamEntityIdSchema.nullable(),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();

export const PersistedTeamRunSupervisorSnapshotSchema = z
  .object({
    roleId: PersistedTeamEntityIdSchema,
    roleName: nonBlankStringSchema(TEAM_ROLE_NAME_MAX_CHARS),
    roleInstructions: nonBlankStringSchema(TEAM_INSTRUCTIONS_MAX_CHARS),
    resolvedLaunch: PersistedTeamResolvedLaunchSchema,
    agentId: z.guid(),
  })
  .strict();

export const PersistedTeamRunWorkerTemplateSchema = PersistedTeamRunStepSnapshotSchema.omit({
  inputArtifactIds: true,
  outputArtifact: true,
  supervision: true,
});

export const PersistedTeamRunSupervisionLimitsSchema = z
  .object({
    maxWorkItems: z.number().int().positive().max(TEAM_SUPERVISION_MAX_WORK_ITEMS),
    maxActiveWorkers: z.literal(1),
    maxAttemptsPerWorkItem: z
      .number()
      .int()
      .positive()
      .max(TEAM_SUPERVISION_MAX_ATTEMPTS_PER_WORK_ITEM),
    maxSupervisorActions: z.number().int().positive().max(TEAM_SUPERVISION_MAX_DECISIONS),
    maxDelegationDepth: z.literal(1),
  })
  .strict();

export const PersistedTeamRunSupervisionWorkItemSchema = z
  .object({
    id: PersistedTeamEntityIdSchema,
    templateStepId: PersistedTeamEntityIdSchema,
    inputArtifactIds: z
      .array(PersistedAssignmentArtifactIdSchema)
      .max(TEAM_SUPERVISION_MAX_WORK_ITEMS),
    attemptIds: z
      .array(PersistedTeamEntityIdSchema)
      .max(TEAM_SUPERVISION_MAX_ATTEMPTS_PER_WORK_ITEM),
    acceptedAttemptId: PersistedTeamEntityIdSchema.nullable(),
    status: z.enum(["planned", "active", "succeeded", "failed", "canceled", "interrupted"]),
  })
  .strict()
  .superRefine((workItem, context) => {
    const seenArtifactIds = new Set<string>();
    for (const [index, artifactId] of workItem.inputArtifactIds.entries()) {
      if (seenArtifactIds.has(artifactId)) {
        context.addIssue({
          code: "custom",
          path: ["inputArtifactIds", index],
          message: `Duplicate supervised input Artifact ID: ${artifactId}`,
        });
      }
      seenArtifactIds.add(artifactId);
    }
  });

const PersistedTeamRunSupervisionDecisionBaseSchema = z.object({
  id: PersistedTeamEntityIdSchema,
  sequence: z.number().int().positive(),
  actionId: PersistedTeamEntityIdSchema,
  summary: nonBlankStringSchema(TEAM_SUPERVISION_DECISION_SUMMARY_MAX_CHARS),
  createdAt: TimestampSchema,
});

export const PersistedTeamRunSupervisionDecisionSchema = z.discriminatedUnion("kind", [
  PersistedTeamRunSupervisionDecisionBaseSchema.extend({
    kind: z.literal("plan"),
    workItemId: z.null(),
    attemptId: z.null(),
  }).strict(),
  PersistedTeamRunSupervisionDecisionBaseSchema.extend({
    kind: z.literal("dispatch"),
    workItemId: PersistedTeamEntityIdSchema,
    attemptId: PersistedTeamEntityIdSchema,
  }).strict(),
  PersistedTeamRunSupervisionDecisionBaseSchema.extend({
    kind: z.literal("request_revision"),
    workItemId: PersistedTeamEntityIdSchema,
    attemptId: PersistedTeamEntityIdSchema,
  }).strict(),
  PersistedTeamRunSupervisionDecisionBaseSchema.extend({
    kind: z.literal("escalate"),
    workItemId: PersistedTeamEntityIdSchema.nullable(),
    attemptId: PersistedTeamEntityIdSchema.nullable(),
  }).strict(),
  PersistedTeamRunSupervisionDecisionBaseSchema.extend({
    kind: z.literal("complete"),
    workItemId: z.null(),
    attemptId: z.null(),
  }).strict(),
]);

const PersistedTeamRunSupervisionHumanActionSchema = z
  .object({
    id: PersistedTeamEntityIdSchema,
    label: nonBlankStringSchema(128),
    description: nonBlankStringSchema(512).optional(),
    requiresNote: z.boolean(),
  })
  .strict();

const PersistedTeamRunSupervisionHumanResolutionSchema = z
  .object({
    actionId: PersistedTeamEntityIdSchema,
    note: nonBlankStringSchema(TEAM_SUPERVISION_HUMAN_REQUEST_NOTE_MAX_CHARS).nullable(),
    idempotencyKey: nonBlankStringSchema(TEAM_IDEMPOTENCY_KEY_MAX_CHARS),
    resolvedAt: TimestampSchema,
  })
  .strict();

const PersistedTeamRunSupervisionHumanRetirementSchema = z
  .object({
    reason: z.enum(["failed", "canceled", "interrupted"]),
    retiredAt: TimestampSchema,
  })
  .strict();

export const PersistedTeamRunSupervisionHumanRequestSchema = z
  .object({
    id: PersistedTeamEntityIdSchema,
    revision: z.number().int().positive(),
    kind: nonBlankStringSchema(128),
    title: nonBlankStringSchema(TEAM_SUPERVISION_HUMAN_REQUEST_TITLE_MAX_CHARS),
    detail: nonBlankStringSchema(TEAM_SUPERVISION_HUMAN_REQUEST_DETAIL_MAX_CHARS),
    actions: z
      .array(PersistedTeamRunSupervisionHumanActionSchema)
      .min(1)
      .max(TEAM_SUPERVISION_MAX_HUMAN_ACTIONS),
    roleIds: z.array(PersistedTeamEntityIdSchema).max(TEAM_MAX_ROLES),
    agentIds: z.array(z.guid()).max(TEAM_SUPERVISION_MAX_RUN_STEPS),
    stepIds: z.array(PersistedTeamEntityIdSchema).max(TEAM_SUPERVISION_MAX_RUN_STEPS),
    artifactIds: z.array(PersistedAssignmentArtifactIdSchema).max(TEAM_SUPERVISION_MAX_WORK_ITEMS),
    createdAt: TimestampSchema,
    resolution: PersistedTeamRunSupervisionHumanResolutionSchema.optional(),
    retirement: PersistedTeamRunSupervisionHumanRetirementSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.resolution && request.retirement) {
      context.addIssue({
        code: "custom",
        path: ["retirement"],
        message: "A human request cannot be both resolved and retired",
      });
    }
  });

export const PersistedTeamRunSupervisionSchema = z
  .object({
    revision: z.number().int().positive(),
    phase: z.enum([
      "queued",
      "planning",
      "working",
      "awaiting_human",
      "completed",
      "failed",
      "canceled",
      "interrupted",
    ]),
    supervisor: PersistedTeamRunSupervisorSnapshotSchema,
    workerTemplates: z
      .array(PersistedTeamRunWorkerTemplateSchema)
      .min(1)
      .max(TEAM_MAX_WORKFLOW_STEPS),
    limits: PersistedTeamRunSupervisionLimitsSchema,
    workItems: z
      .array(PersistedTeamRunSupervisionWorkItemSchema)
      .max(TEAM_SUPERVISION_MAX_WORK_ITEMS),
    decisions: z
      .array(PersistedTeamRunSupervisionDecisionSchema)
      .max(TEAM_SUPERVISION_MAX_DECISIONS),
    humanRequest: PersistedTeamRunSupervisionHumanRequestSchema.nullable(),
    updatedAt: TimestampSchema,
  })
  .strict();

const PendingStepStateSchema = z.object({ status: z.literal("pending") }).strict();
const CreatingStepStateSchema = z
  .object({
    status: z.literal("creating"),
    plannedAgentId: z.guid(),
    startedAt: TimestampSchema,
  })
  .strict();
const RunningStepStateSchema = z
  .object({
    status: z.literal("running"),
    plannedAgentId: z.guid(),
    agentId: z.guid(),
    startedAt: TimestampSchema,
  })
  .strict();
const WaitingForPermissionStepStateSchema = z
  .object({
    status: z.literal("waiting_for_permission"),
    plannedAgentId: z.guid(),
    agentId: z.guid(),
    startedAt: TimestampSchema,
  })
  .strict();
const StoppingStepStateSchema = z
  .object({
    status: z.literal("stopping"),
    plannedAgentId: z.guid(),
    agentId: z.guid().nullable(),
    startedAt: TimestampSchema,
    stopRequestedAt: TimestampSchema,
  })
  .strict();
const SucceededStepStateSchema = z
  .object({
    status: z.literal("succeeded"),
    plannedAgentId: z.guid(),
    agentId: z.guid(),
    startedAt: TimestampSchema,
    endedAt: TimestampSchema,
  })
  .strict();
const FailedStepStateSchema = z
  .object({
    status: z.literal("failed"),
    plannedAgentId: z.guid(),
    agentId: z.guid().nullable(),
    startedAt: TimestampSchema,
    endedAt: TimestampSchema,
    error: ErrorSchema,
  })
  .strict();
const CanceledStepStateSchema = z
  .object({
    status: z.literal("canceled"),
    plannedAgentId: z.guid(),
    agentId: z.guid().nullable(),
    startedAt: TimestampSchema,
    endedAt: TimestampSchema,
  })
  .strict();
const InterruptedStepStateSchema = z
  .object({
    status: z.literal("interrupted"),
    plannedAgentId: z.guid(),
    agentId: z.guid().nullable(),
    startedAt: TimestampSchema,
    endedAt: TimestampSchema,
    error: ErrorSchema,
  })
  .strict();
const StopFailedStepStateSchema = z
  .object({
    status: z.literal("stop_failed"),
    plannedAgentId: z.guid(),
    agentId: z.guid(),
    startedAt: TimestampSchema,
    stopRequestedAt: TimestampSchema,
    error: ErrorSchema,
  })
  .strict();

export const PersistedTeamRunStepStateSchema = z
  .discriminatedUnion("status", [
    PendingStepStateSchema,
    CreatingStepStateSchema,
    RunningStepStateSchema,
    WaitingForPermissionStepStateSchema,
    StoppingStepStateSchema,
    SucceededStepStateSchema,
    FailedStepStateSchema,
    CanceledStepStateSchema,
    InterruptedStepStateSchema,
    StopFailedStepStateSchema,
  ])
  .superRefine((state, context) => {
    if (!("plannedAgentId" in state)) return;
    if (!("agentId" in state)) return;
    if (state.agentId === null || state.agentId === state.plannedAgentId) return;
    context.addIssue({
      code: "custom",
      path: ["agentId"],
      message: "agentId must match plannedAgentId",
    });
  });

export const PersistedTeamRunStepSchema = z
  .object({
    snapshot: PersistedTeamRunStepSnapshotSchema,
    state: PersistedTeamRunStepStateSchema,
  })
  .strict();

const QueuedRunStateSchema = z.object({ status: z.literal("queued") }).strict();
const RunningRunStateSchema = z
  .object({ status: z.literal("running"), startedAt: TimestampSchema })
  .strict();
const WaitingForPermissionRunStateSchema = z
  .object({ status: z.literal("waiting_for_permission"), startedAt: TimestampSchema })
  .strict();
const StoppingRunStateSchema = z
  .object({
    status: z.literal("stopping"),
    startedAt: TimestampSchema,
    stopRequestedAt: TimestampSchema,
  })
  .strict();
const SucceededRunStateSchema = z
  .object({
    status: z.literal("succeeded"),
    startedAt: TimestampSchema,
    endedAt: TimestampSchema,
  })
  .strict();
const FailedRunStateSchema = z
  .object({
    status: z.literal("failed"),
    startedAt: TimestampSchema,
    endedAt: TimestampSchema,
    error: ErrorSchema,
  })
  .strict();
const CanceledRunStateSchema = z
  .object({
    status: z.literal("canceled"),
    startedAt: TimestampSchema.nullable(),
    endedAt: TimestampSchema,
  })
  .strict();
const InterruptedRunStateSchema = z
  .object({
    status: z.literal("interrupted"),
    startedAt: TimestampSchema.nullable(),
    endedAt: TimestampSchema,
    error: ErrorSchema,
  })
  .strict();
const StopFailedRunStateSchema = z
  .object({
    status: z.literal("stop_failed"),
    startedAt: TimestampSchema,
    stopRequestedAt: TimestampSchema,
    error: ErrorSchema,
  })
  .strict();

export const PersistedTeamRunStateSchema = z.discriminatedUnion("status", [
  QueuedRunStateSchema,
  RunningRunStateSchema,
  WaitingForPermissionRunStateSchema,
  StoppingRunStateSchema,
  SucceededRunStateSchema,
  FailedRunStateSchema,
  CanceledRunStateSchema,
  InterruptedRunStateSchema,
  StopFailedRunStateSchema,
]);

export type PersistedTeamRunState = z.infer<typeof PersistedTeamRunStateSchema>;
export type PersistedTeamRunStepState = z.infer<typeof PersistedTeamRunStepStateSchema>;
export type TeamRunStatus = PersistedTeamRunState["status"];
export type TeamRunStepStatus = PersistedTeamRunStepState["status"];

const ACTIVE_STEP_STATUSES: ReadonlySet<TeamRunStepStatus> = new Set([
  "creating",
  "running",
  "waiting_for_permission",
  "stopping",
  "stop_failed",
]);
const TERMINAL_RUN_STATUSES: ReadonlySet<TeamRunStatus> = new Set([
  "succeeded",
  "failed",
  "canceled",
  "interrupted",
]);

function requiredCurrentStepStatus(status: TeamRunStatus): TeamRunStepStatus | null {
  if (status === "waiting_for_permission") return "waiting_for_permission";
  if (status === "stopping") return "stopping";
  if (status === "stop_failed") return "stop_failed";
  return null;
}

function requiredRunStatusForCurrentStep(status: TeamRunStepStatus): TeamRunStatus | null {
  if (status === "waiting_for_permission") return "waiting_for_permission";
  if (status === "stopping") return "stopping";
  if (status === "stop_failed") return "stop_failed";
  return null;
}

const PersistedTeamRunRecordBaseSchema = z
  .object({
    id: PersistedTeamEntityIdSchema,
    teamId: PersistedTeamEntityIdSchema,
    teamRevision: z.number().int().positive(),
    idempotencyKey: nonBlankStringSchema(TEAM_IDEMPOTENCY_KEY_MAX_CHARS),
    teamSnapshot: PersistedTeamDefinitionSchema,
    objective: nonBlankStringSchema(TEAM_OBJECTIVE_MAX_CHARS),
    assignmentId: PersistedAssignmentIdSchema.optional(),
    assignmentRevision: z.number().int().positive().optional(),
    assignmentSnapshot: PersistedAssignmentRecordSchema.optional(),
    workspace: PersistedTeamRunWorkspaceSnapshotSchema,
    steps: z.array(PersistedTeamRunStepSchema).max(TEAM_SUPERVISION_MAX_RUN_STEPS),
    supervision: PersistedTeamRunSupervisionSchema.optional(),
    state: PersistedTeamRunStateSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

type TeamRunRecordShape = z.infer<typeof PersistedTeamRunRecordBaseSchema>;

interface ContractIssue {
  path: (string | number)[];
  message: string;
}

function validateRunIdentity(run: TeamRunRecordShape): ContractIssue[] {
  const issues: ContractIssue[] = [];
  if (run.teamId !== run.teamSnapshot.id) {
    issues.push({ path: ["teamId"], message: "teamId must match the frozen Team snapshot" });
  }
  if (run.teamRevision !== run.teamSnapshot.revision) {
    issues.push({
      path: ["teamRevision"],
      message: "teamRevision must match the frozen Team snapshot",
    });
  }
  if (!run.supervision && run.steps.length !== run.teamSnapshot.workflow.length) {
    issues.push({ path: ["steps"], message: "Run steps must match the frozen workflow length" });
  }
  issues.push(...validateAssignmentIdentity(run));
  return issues;
}

function validateAssignmentIdentity(run: TeamRunRecordShape): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const assignmentFields = [run.assignmentId, run.assignmentRevision, run.assignmentSnapshot];
  const presentFieldCount = assignmentFields.filter((field) => field !== undefined).length;
  if (presentFieldCount === 0) return issues;
  if (presentFieldCount !== assignmentFields.length) {
    issues.push({
      path: ["assignmentId"],
      message: "Assignment identity, revision, and snapshot must be present together",
    });
    return issues;
  }

  const assignmentId = run.assignmentId!;
  const assignmentRevision = run.assignmentRevision!;
  const assignmentSnapshot = run.assignmentSnapshot!;
  if (assignmentId !== assignmentSnapshot.id) {
    issues.push({
      path: ["assignmentId"],
      message: "assignmentId must match the frozen Assignment snapshot",
    });
  }
  if (assignmentRevision !== assignmentSnapshot.revision) {
    issues.push({
      path: ["assignmentRevision"],
      message: "assignmentRevision must match the frozen Assignment snapshot",
    });
  }
  if (run.objective !== assignmentSnapshot.objective) {
    issues.push({
      path: ["objective"],
      message: "objective must match the frozen Assignment snapshot",
    });
  }
  if (assignmentSnapshot.state.status !== "open") {
    issues.push({
      path: ["assignmentSnapshot", "state", "status"],
      message: "Assignment-backed runs must freeze an open Assignment",
    });
  }
  if (!run.supervision) issues.push(...validateAssignmentArtifactPlan(run));
  return issues;
}

function validateAssignmentArtifactPlan(run: TeamRunRecordShape): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const outputIds = new Set<string>();
  let precedingOutputId: string | null = null;
  for (const [index, step] of run.steps.entries()) {
    const { inputArtifactIds, outputArtifact } = step.snapshot;
    if (!inputArtifactIds || !outputArtifact) {
      issues.push({
        path: ["steps", index, "snapshot"],
        message: "Assignment-backed steps must freeze Artifact inputs and output",
      });
      precedingOutputId = outputArtifact?.id ?? null;
      continue;
    }

    const expectedInputs = precedingOutputId === null ? [] : [precedingOutputId];
    if (
      inputArtifactIds.length !== expectedInputs.length ||
      inputArtifactIds.some((artifactId, inputIndex) => artifactId !== expectedInputs[inputIndex])
    ) {
      issues.push({
        path: ["steps", index, "snapshot", "inputArtifactIds"],
        message: "Each downstream step must consume exactly the preceding output Artifact ID",
      });
    }
    if (outputIds.has(outputArtifact.id)) {
      issues.push({
        path: ["steps", index, "snapshot", "outputArtifact", "id"],
        message: "Each Team Run step must own a distinct output Artifact ID",
      });
    }
    outputIds.add(outputArtifact.id);
    if (outputArtifact.title !== `${step.snapshot.roleName} output`) {
      issues.push({
        path: ["steps", index, "snapshot", "outputArtifact", "title"],
        message: "Team step output titles must use the canonical role display",
      });
    }
    precedingOutputId = outputArtifact.id;
  }
  return issues;
}

function stepSnapshotMatchesRole(
  step: TeamRunRecordShape["steps"][number],
  workflowStep: TeamRunRecordShape["teamSnapshot"]["workflow"][number],
  role: TeamRunRecordShape["teamSnapshot"]["roles"][number] | undefined,
): boolean {
  if (!role) return false;
  const identityMatches = step.snapshot.roleId === role.id && step.snapshot.roleName === role.name;
  const instructionsMatch =
    step.snapshot.roleInstructions === role.instructions &&
    step.snapshot.stepInstructions === workflowStep.instructions;
  const profileMatches = step.snapshot.resolvedLaunch.profileId === role.profileId;
  return identityMatches && instructionsMatch && profileMatches;
}

function validateRunStepSnapshots(run: TeamRunRecordShape): ContractIssue[] {
  if (run.supervision) return validateSupervisedRunStepSnapshots(run);
  const issues: ContractIssue[] = [];
  const roles = new Map(run.teamSnapshot.roles.map((role) => [role.id, role]));
  for (const [index, step] of run.steps.entries()) {
    const workflowStep = run.teamSnapshot.workflow[index];
    if (!workflowStep || step.snapshot.stepId !== workflowStep.id) {
      issues.push({
        path: ["steps", index, "snapshot", "stepId"],
        message: "Run step order must match the frozen workflow",
      });
      continue;
    }
    const role = roles.get(workflowStep.roleId);
    if (!stepSnapshotMatchesRole(step, workflowStep, role)) {
      issues.push({
        path: ["steps", index, "snapshot"],
        message: "Run step snapshot must match its frozen Team role and workflow step",
      });
    }
  }
  return issues;
}

type SupervisedRunStep = TeamRunRecordShape["steps"][number];
type SupervisedStepMetadata = NonNullable<SupervisedRunStep["snapshot"]["supervision"]>;
type SupervisorStepMetadata = Extract<SupervisedStepMetadata, { kind: "supervisor" }>;
type WorkerStepMetadata = Extract<SupervisedStepMetadata, { kind: "worker" }>;

interface SupervisedStepValidationContext {
  run: TeamRunRecordShape;
  issues: ContractIssue[];
  workItems: Map<string, NonNullable<TeamRunRecordShape["supervision"]>["workItems"][number]>;
  decisions: Map<string, NonNullable<TeamRunRecordShape["supervision"]>["decisions"][number]>;
  templates: Map<string, NonNullable<TeamRunRecordShape["supervision"]>["workerTemplates"][number]>;
  stepsByAttemptId: Map<string, SupervisedRunStep>;
  seenWorkerAgentIds: Set<string>;
  supervisorSteps: SupervisedRunStep[];
}

function validateSupervisedRunStepSnapshots(run: TeamRunRecordShape): ContractIssue[] {
  const supervision = run.supervision!;
  const issues = validateSupervisionSnapshot(run);
  const context: SupervisedStepValidationContext = {
    run,
    issues,
    workItems: new Map(supervision.workItems.map((workItem) => [workItem.id, workItem])),
    decisions: new Map(supervision.decisions.map((decision) => [decision.id, decision])),
    templates: new Map(supervision.workerTemplates.map((template) => [template.stepId, template])),
    stepsByAttemptId: new Map(),
    seenWorkerAgentIds: new Set([supervision.supervisor.agentId]),
    supervisorSteps: [],
  };
  const seenStepIds = new Set<string>();

  for (const [index, step] of run.steps.entries()) {
    const metadata = step.snapshot.supervision;
    if (!metadata) {
      issues.push({
        path: ["steps", index, "snapshot", "supervision"],
        message: "Supervised Team Run steps must carry supervision identity",
      });
      continue;
    }
    if (seenStepIds.has(step.snapshot.stepId)) {
      issues.push({
        path: ["steps", index, "snapshot", "stepId"],
        message: `Duplicate supervised step ID: ${step.snapshot.stepId}`,
      });
    }
    seenStepIds.add(step.snapshot.stepId);

    if (metadata.kind === "supervisor") {
      validateSupervisorStep(context, index, step, metadata);
      continue;
    }
    validateWorkerStep(context, index, step, metadata);
  }

  for (const [index, step] of context.supervisorSteps.entries()) {
    const metadata = step.snapshot.supervision;
    if (metadata?.kind !== "supervisor") continue;
    if (metadata.turn !== index + 1) {
      issues.push({
        path: ["steps", run.steps.indexOf(step), "snapshot", "supervision", "turn"],
        message: "Supervisor turn numbers must be contiguous",
      });
    }
  }

  issues.push(...validateSupervisorDecisionOwnership(run, context.supervisorSteps));
  issues.push(...validateSupervisionAttempts(run, context.stepsByAttemptId));
  return issues;
}

function validateSupervisorStep(
  context: SupervisedStepValidationContext,
  index: number,
  step: SupervisedRunStep,
  metadata: SupervisorStepMetadata,
): void {
  context.supervisorSteps.push(step);
  const supervisor = context.run.supervision!.supervisor;
  if (!supervisedStepMatchesRole(step, supervisor)) {
    context.issues.push({
      path: ["steps", index, "snapshot"],
      message: "Supervisor step must match the frozen supervisor role",
    });
  }
  if ("plannedAgentId" in step.state && step.state.plannedAgentId !== supervisor.agentId) {
    context.issues.push({
      path: ["steps", index, "state", "plannedAgentId"],
      message: "Supervisor steps must use the frozen supervisor agent ID",
    });
  }
  if (step.state.status === "succeeded" && !context.decisions.has(metadata.decisionId)) {
    context.issues.push({
      path: ["steps", index, "snapshot", "supervision", "decisionId"],
      message: "A succeeded supervisor turn must own a durable decision",
    });
  }
}

function validateSupervisorDecisionOwnership(
  run: TeamRunRecordShape,
  supervisorSteps: SupervisedRunStep[],
): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const ownedDecisionIds = new Set<string>();
  for (const step of supervisorSteps) {
    const metadata = step.snapshot.supervision;
    if (metadata?.kind !== "supervisor" || step.state.status !== "succeeded") continue;
    if (ownedDecisionIds.has(metadata.decisionId)) {
      issues.push({
        path: ["steps", run.steps.indexOf(step), "snapshot", "supervision", "decisionId"],
        message: "A durable supervisor decision must belong to exactly one succeeded turn",
      });
    }
    ownedDecisionIds.add(metadata.decisionId);
  }
  for (const [index, decision] of run.supervision!.decisions.entries()) {
    if (ownedDecisionIds.has(decision.id)) continue;
    issues.push({
      path: ["supervision", "decisions", index, "id"],
      message: "A durable supervisor decision must belong to exactly one succeeded turn",
    });
  }
  return issues;
}

function validateWorkerStep(
  context: SupervisedStepValidationContext,
  index: number,
  step: SupervisedRunStep,
  metadata: WorkerStepMetadata,
): void {
  const workItem = context.workItems.get(metadata.workItemId);
  const template = context.templates.get(metadata.templateStepId);
  if (!workItem) {
    context.issues.push({
      path: ["steps", index, "snapshot", "supervision", "workItemId"],
      message: `Unknown supervised work item ID: ${metadata.workItemId}`,
    });
  }
  if (!template || workItem?.templateStepId !== metadata.templateStepId) {
    context.issues.push({
      path: ["steps", index, "snapshot", "supervision", "templateStepId"],
      message: `Unknown worker template step ID: ${metadata.templateStepId}`,
    });
  } else if (!supervisedStepMatchesRole(step, template)) {
    context.issues.push({
      path: ["steps", index, "snapshot"],
      message: "Worker step must match its frozen workflow template",
    });
  }
  if (context.stepsByAttemptId.has(metadata.attemptId)) {
    context.issues.push({
      path: ["steps", index, "snapshot", "supervision", "attemptId"],
      message: `Duplicate supervised attempt ID: ${metadata.attemptId}`,
    });
  }
  context.stepsByAttemptId.set(metadata.attemptId, step);
  if (workItem && !workItem.attemptIds.includes(metadata.attemptId)) {
    context.issues.push({
      path: ["steps", index, "snapshot", "supervision", "attemptId"],
      message: "Worker attempt must be listed by its supervised work item",
    });
  }
  if (workItem && !sameStrings(step.snapshot.inputArtifactIds ?? [], workItem.inputArtifactIds)) {
    context.issues.push({
      path: ["steps", index, "snapshot", "inputArtifactIds"],
      message: "Worker attempt inputs must match the frozen work item Artifact inputs",
    });
  }
  if (!step.snapshot.outputArtifact) {
    context.issues.push({
      path: ["steps", index, "snapshot", "outputArtifact"],
      message: "Worker attempts must preallocate an output Artifact",
    });
  }
  validateDistinctWorkerAgentId(context, index, step);
}

function validateDistinctWorkerAgentId(
  context: SupervisedStepValidationContext,
  index: number,
  step: SupervisedRunStep,
): void {
  if (!("plannedAgentId" in step.state)) return;
  if (context.seenWorkerAgentIds.has(step.state.plannedAgentId)) {
    context.issues.push({
      path: ["steps", index, "state", "plannedAgentId"],
      message: "Each supervised worker attempt must own a distinct agent ID",
    });
  }
  context.seenWorkerAgentIds.add(step.state.plannedAgentId);
}

function validateSupervisionSnapshot(run: TeamRunRecordShape): ContractIssue[] {
  const supervision = run.supervision!;
  const issues: ContractIssue[] = [];
  if (!run.assignmentSnapshot) {
    issues.push({
      path: ["supervision"],
      message: "Supervised Team Runs must be backed by an Assignment",
    });
  }

  const roles = new Map(run.teamSnapshot.roles.map((role) => [role.id, role]));
  const supervisorRole = roles.get(supervision.supervisor.roleId);
  if (
    !supervisorRole ||
    !supervisedStepMatchesRole({ snapshot: supervision.supervisor }, supervisorRole)
  ) {
    issues.push({
      path: ["supervision", "supervisor"],
      message: "Supervisor snapshot must match a frozen Team role",
    });
  }
  if (run.teamSnapshot.workflow.some((step) => step.roleId === supervision.supervisor.roleId)) {
    issues.push({
      path: ["supervision", "supervisor", "roleId"],
      message: "The supervisor role cannot also be a worker workflow role",
    });
  }
  if (supervision.workerTemplates.length !== run.teamSnapshot.workflow.length) {
    issues.push({
      path: ["supervision", "workerTemplates"],
      message: "Worker templates must match the frozen workflow length",
    });
  }
  for (const [index, template] of supervision.workerTemplates.entries()) {
    const workflowStep = run.teamSnapshot.workflow[index];
    const role = workflowStep ? roles.get(workflowStep.roleId) : undefined;
    if (
      !workflowStep ||
      template.stepId !== workflowStep.id ||
      !stepSnapshotMatchesRole(
        { snapshot: template, state: { status: "pending" } },
        workflowStep,
        role,
      )
    ) {
      issues.push({
        path: ["supervision", "workerTemplates", index],
        message: "Worker template must match its frozen Team role and workflow step",
      });
    }
  }

  if (supervision.workItems.length > supervision.limits.maxWorkItems) {
    issues.push({
      path: ["supervision", "workItems"],
      message: "Supervised work exceeds the frozen work-item limit",
    });
  }
  if (supervision.decisions.length > supervision.limits.maxSupervisorActions) {
    issues.push({
      path: ["supervision", "decisions"],
      message: "Supervisor decisions exceed the frozen action limit",
    });
  }

  issues.push(...validateSupervisionWorkItems(run));
  issues.push(...validateSupervisionDecisions(run));
  issues.push(...validateSupervisionHumanRequest(run));
  return issues;
}

function validateSupervisionWorkItems(run: TeamRunRecordShape): ContractIssue[] {
  const supervision = run.supervision!;
  const issues: ContractIssue[] = [];
  const templateIds = new Set(supervision.workerTemplates.map((template) => template.stepId));
  const workItemIds = new Set<string>();
  const attemptIds = new Set<string>();
  for (const [index, workItem] of supervision.workItems.entries()) {
    if (workItemIds.has(workItem.id)) {
      issues.push({
        path: ["supervision", "workItems", index, "id"],
        message: `Duplicate supervised work item ID: ${workItem.id}`,
      });
    }
    workItemIds.add(workItem.id);
    if (!templateIds.has(workItem.templateStepId)) {
      issues.push({
        path: ["supervision", "workItems", index, "templateStepId"],
        message: `Unknown worker template step ID: ${workItem.templateStepId}`,
      });
    }
    if (workItem.attemptIds.length > supervision.limits.maxAttemptsPerWorkItem) {
      issues.push({
        path: ["supervision", "workItems", index, "attemptIds"],
        message: "Work item attempts exceed the frozen attempt limit",
      });
    }
    for (const attemptId of workItem.attemptIds) {
      if (attemptIds.has(attemptId)) {
        issues.push({
          path: ["supervision", "workItems", index, "attemptIds"],
          message: `Duplicate supervised attempt ID: ${attemptId}`,
        });
      }
      attemptIds.add(attemptId);
    }
    if (
      workItem.acceptedAttemptId !== null &&
      !workItem.attemptIds.includes(workItem.acceptedAttemptId)
    ) {
      issues.push({
        path: ["supervision", "workItems", index, "acceptedAttemptId"],
        message: "Accepted attempt must belong to its supervised work item",
      });
    }
    if ((workItem.status === "succeeded") !== (workItem.acceptedAttemptId !== null)) {
      issues.push({
        path: ["supervision", "workItems", index, "status"],
        message: "Only a succeeded work item may own an accepted attempt",
      });
    }
  }
  return issues;
}

function validateSupervisionDecisions(run: TeamRunRecordShape): ContractIssue[] {
  const supervision = run.supervision!;
  const issues: ContractIssue[] = [];
  const workItems = new Map(supervision.workItems.map((workItem) => [workItem.id, workItem]));
  const attemptIds = new Set(supervision.workItems.flatMap((workItem) => workItem.attemptIds));
  const decisionIds = new Set<string>();
  const actionIds = new Set<string>();
  for (const [index, decision] of supervision.decisions.entries()) {
    if (decision.sequence !== index + 1) {
      issues.push({
        path: ["supervision", "decisions", index, "sequence"],
        message: "Supervisor decision sequences must be contiguous",
      });
    }
    if (decisionIds.has(decision.id)) {
      issues.push({
        path: ["supervision", "decisions", index, "id"],
        message: `Duplicate supervisor decision ID: ${decision.id}`,
      });
    }
    decisionIds.add(decision.id);
    if (actionIds.has(decision.actionId)) {
      issues.push({
        path: ["supervision", "decisions", index, "actionId"],
        message: `Duplicate supervisor action ID: ${decision.actionId}`,
      });
    }
    actionIds.add(decision.actionId);
    const workItem = decision.workItemId === null ? null : workItems.get(decision.workItemId);
    if (decision.workItemId !== null && !workItem) {
      issues.push({
        path: ["supervision", "decisions", index, "workItemId"],
        message: `Unknown supervised work item ID: ${decision.workItemId}`,
      });
    }
    if (decision.attemptId !== null && !attemptIds.has(decision.attemptId)) {
      issues.push({
        path: ["supervision", "decisions", index, "attemptId"],
        message: `Unknown supervised attempt ID: ${decision.attemptId}`,
      });
    } else if (
      decision.attemptId !== null &&
      workItem &&
      !workItem.attemptIds.includes(decision.attemptId)
    ) {
      issues.push({
        path: ["supervision", "decisions", index, "attemptId"],
        message: "Supervisor decision attempt must belong to its named work item",
      });
    }
  }
  return issues;
}

function validateSupervisionHumanRequest(run: TeamRunRecordShape): ContractIssue[] {
  const request = run.supervision!.humanRequest;
  if (!request) return [];
  const issues: ContractIssue[] = [];
  const actionIds = new Set<string>();
  for (const [index, action] of request.actions.entries()) {
    if (actionIds.has(action.id)) {
      issues.push({
        path: ["supervision", "humanRequest", "actions", index, "id"],
        message: `Duplicate human request action ID: ${action.id}`,
      });
    }
    actionIds.add(action.id);
  }
  if (request.resolution && !actionIds.has(request.resolution.actionId)) {
    issues.push({
      path: ["supervision", "humanRequest", "resolution", "actionId"],
      message: "Human request resolution must select a frozen action",
    });
  }
  if (request.resolution) {
    const action = request.actions.find(
      (candidate) => candidate.id === request.resolution!.actionId,
    );
    if (action?.requiresNote && request.resolution.note === null) {
      issues.push({
        path: ["supervision", "humanRequest", "resolution", "note"],
        message: "The selected human request action requires a note",
      });
    }
  }
  if (request.retirement && request.retirement.reason !== run.state.status) {
    issues.push({
      path: ["supervision", "humanRequest", "retirement", "reason"],
      message: "Human request retirement must match the terminal run status",
    });
  }
  const validRoleIds = new Set(run.teamSnapshot.roles.map((role) => role.id));
  const validAgentIds = new Set<string>([run.supervision!.supervisor.agentId]);
  const validStepIds = new Set<string>();
  const validArtifactIds = new Set<string>();
  for (const step of run.steps) {
    validStepIds.add(step.snapshot.stepId);
    if ("plannedAgentId" in step.state) validAgentIds.add(step.state.plannedAgentId);
    if ("agentId" in step.state && step.state.agentId) validAgentIds.add(step.state.agentId);
    if (step.state.status === "succeeded" && step.snapshot.outputArtifact) {
      validArtifactIds.add(step.snapshot.outputArtifact.id);
    }
  }
  validateHumanRequestReferences(request.roleIds, validRoleIds, "roleIds", issues);
  validateHumanRequestReferences(request.agentIds, validAgentIds, "agentIds", issues);
  validateHumanRequestReferences(request.stepIds, validStepIds, "stepIds", issues);
  validateHumanRequestReferences(request.artifactIds, validArtifactIds, "artifactIds", issues);
  return issues;
}

function validateHumanRequestReferences(
  values: readonly string[],
  validValues: ReadonlySet<string>,
  field: "roleIds" | "agentIds" | "stepIds" | "artifactIds",
  issues: ContractIssue[],
): void {
  for (const [index, value] of values.entries()) {
    if (validValues.has(value)) continue;
    issues.push({
      path: ["supervision", "humanRequest", field, index],
      message: `Human request references unknown run-local evidence: ${value}`,
    });
  }
}

function isPendingHumanRequest(
  request: NonNullable<TeamRunRecordShape["supervision"]>["humanRequest"],
): boolean {
  return Boolean(request && !request.resolution && !request.retirement);
}

function validateSupervisionAttempts(
  run: TeamRunRecordShape,
  stepsByAttemptId: Map<string, TeamRunRecordShape["steps"][number]>,
): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const availableArtifactIds = new Set<string>();
  const outputArtifactIds = new Set<string>();
  for (const [workIndex, workItem] of run.supervision!.workItems.entries()) {
    for (const [inputIndex, artifactId] of workItem.inputArtifactIds.entries()) {
      if (!availableArtifactIds.has(artifactId)) {
        issues.push({
          path: ["supervision", "workItems", workIndex, "inputArtifactIds", inputIndex],
          message: "Work item inputs must reference accepted earlier run-local Artifacts",
        });
      }
    }
    for (const [attemptIndex, attemptId] of workItem.attemptIds.entries()) {
      const step = stepsByAttemptId.get(attemptId);
      if (!step) {
        issues.push({
          path: ["supervision", "workItems", workIndex, "attemptIds", attemptIndex],
          message: `Supervised attempt has no Team Run step: ${attemptId}`,
        });
        continue;
      }
      const metadata = step.snapshot.supervision;
      if (metadata?.kind !== "worker") continue;
      if (metadata.attemptNumber !== attemptIndex + 1) {
        issues.push({
          path: ["steps", run.steps.indexOf(step), "snapshot", "supervision", "attemptNumber"],
          message: "Work item attempt numbers must be contiguous",
        });
      }
      const expectedParent = attemptIndex === 0 ? null : workItem.attemptIds[attemptIndex - 1]!;
      if (metadata.revisionParentAttemptId !== expectedParent) {
        issues.push({
          path: [
            "steps",
            run.steps.indexOf(step),
            "snapshot",
            "supervision",
            "revisionParentAttemptId",
          ],
          message: "Revision attempts must reference the immediately preceding attempt",
        });
      }
      const outputArtifactId = step.snapshot.outputArtifact?.id;
      if (outputArtifactId) {
        if (outputArtifactIds.has(outputArtifactId)) {
          issues.push({
            path: ["steps", run.steps.indexOf(step), "snapshot", "outputArtifact", "id"],
            message: "Each supervised attempt must own a distinct output Artifact ID",
          });
        }
        outputArtifactIds.add(outputArtifactId);
      }
    }
    if (workItem.acceptedAttemptId) {
      const acceptedStep = stepsByAttemptId.get(workItem.acceptedAttemptId);
      if (acceptedStep?.state.status !== "succeeded") {
        issues.push({
          path: ["supervision", "workItems", workIndex, "acceptedAttemptId"],
          message: "Accepted supervised attempts must have succeeded",
        });
      }
      const acceptedArtifactId = acceptedStep?.snapshot.outputArtifact?.id;
      if (acceptedArtifactId) availableArtifactIds.add(acceptedArtifactId);
    }
  }
  return issues;
}

function supervisedStepMatchesRole(
  step: {
    snapshot: Pick<
      TeamRunRecordShape["steps"][number]["snapshot"],
      "roleId" | "roleName" | "roleInstructions" | "resolvedLaunch"
    >;
  },
  role: {
    id?: string;
    roleId?: string;
    name?: string;
    roleName?: string;
    instructions?: string;
    roleInstructions?: string;
    profileId?: string;
    resolvedLaunch?: TeamRunRecordShape["steps"][number]["snapshot"]["resolvedLaunch"];
  },
): boolean {
  const roleId = role.id ?? role.roleId;
  const roleName = role.name ?? role.roleName;
  const roleInstructions = role.instructions ?? role.roleInstructions;
  const profileId = role.profileId ?? role.resolvedLaunch?.profileId;
  const launchMatches = role.resolvedLaunch
    ? equal(step.snapshot.resolvedLaunch, role.resolvedLaunch)
    : step.snapshot.resolvedLaunch.profileId === profileId;
  return (
    step.snapshot.roleId === roleId &&
    step.snapshot.roleName === roleName &&
    step.snapshot.roleInstructions === roleInstructions &&
    launchMatches
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateSupervisedRunLifecycle(run: TeamRunRecordShape): ContractIssue[] {
  const activeSteps = run.steps.filter((step) => ACTIVE_STEP_STATUSES.has(step.state.status));
  return [
    ...validateSupervisedActiveSteps(run, activeSteps),
    ...validateSupervisedAdmission(run),
    ...validateSupervisedHumanWait(run),
    ...validateSupervisedTerminalState(run, activeSteps),
  ];
}

function validateSupervisedActiveSteps(
  run: TeamRunRecordShape,
  activeSteps: SupervisedRunStep[],
): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const activeWorkers = activeSteps.filter((step) => step.snapshot.supervision?.kind === "worker");
  if (activeWorkers.length > run.supervision!.limits.maxActiveWorkers) {
    issues.push({
      path: ["steps"],
      message: "Active supervised workers exceed the frozen fan-out limit",
    });
  }
  if (activeSteps.length > 1) {
    issues.push({
      path: ["steps"],
      message: "The first supervised executor permits only one active agent",
    });
  }
  const requiredStepStatus = requiredCurrentStepStatus(run.state.status);
  if (requiredStepStatus && !activeSteps.some((step) => step.state.status === requiredStepStatus)) {
    issues.push({
      path: ["state", "status"],
      message: `Run status ${requiredStepStatus} requires a matching current step`,
    });
  }
  for (const step of activeSteps) {
    const requiredRunStatus = requiredRunStatusForCurrentStep(step.state.status);
    if (!requiredRunStatus || run.state.status === requiredRunStatus) continue;
    issues.push({
      path: ["steps", run.steps.indexOf(step), "state", "status"],
      message: `Supervised step status ${step.state.status} requires run status ${requiredRunStatus}`,
    });
  }
  return issues;
}

function validateSupervisedAdmission(run: TeamRunRecordShape): ContractIssue[] {
  const supervision = run.supervision!;
  const issues: ContractIssue[] = [];
  if (run.state.status === "queued") {
    const isCleanAdmission =
      supervision.phase === "queued" &&
      run.steps.length === 0 &&
      supervision.workItems.length === 0 &&
      supervision.decisions.length === 0 &&
      supervision.humanRequest === null;
    if (!isCleanAdmission) {
      issues.push({
        path: ["supervision"],
        message: "A queued supervised run must contain only its frozen admission snapshot",
      });
    }
  }
  if (supervision.phase === "queued" && run.state.status !== "queued") {
    issues.push({
      path: ["supervision", "phase"],
      message: "Queued supervision requires a queued run",
    });
  }
  return issues;
}

function validateSupervisedHumanWait(run: TeamRunRecordShape): ContractIssue[] {
  const supervision = run.supervision!;
  const issues: ContractIssue[] = [];
  if (supervision.phase === "awaiting_human") {
    if (run.state.status !== "running" || !isPendingHumanRequest(supervision.humanRequest)) {
      issues.push({
        path: ["supervision", "phase"],
        message: "Human-wait supervision requires a running run and unresolved request",
      });
    }
  }
  if (isPendingHumanRequest(supervision.humanRequest) && supervision.phase !== "awaiting_human") {
    issues.push({
      path: ["supervision", "humanRequest"],
      message: "An unresolved human request must keep supervision awaiting the human",
    });
  }
  return issues;
}

function validateSupervisedTerminalState(
  run: TeamRunRecordShape,
  activeSteps: SupervisedRunStep[],
): ContractIssue[] {
  const supervision = run.supervision!;
  const issues: ContractIssue[] = [];
  if (TERMINAL_RUN_STATUSES.has(run.state.status) && activeSteps.length > 0) {
    issues.push({
      path: ["state", "status"],
      message: "A terminal supervised run cannot contain an active step",
    });
  }
  const terminalPhaseByStatus: Partial<Record<TeamRunStatus, typeof supervision.phase>> = {
    succeeded: "completed",
    failed: "failed",
    canceled: "canceled",
    interrupted: "interrupted",
  };
  const expectedTerminalPhase = terminalPhaseByStatus[run.state.status];
  if (expectedTerminalPhase && supervision.phase !== expectedTerminalPhase) {
    issues.push({
      path: ["supervision", "phase"],
      message: `Terminal run status ${run.state.status} requires supervision phase ${expectedTerminalPhase}`,
    });
  }
  const terminalStatusByPhase: Partial<Record<typeof supervision.phase, TeamRunStatus>> = {
    completed: "succeeded",
    failed: "failed",
    canceled: "canceled",
    interrupted: "interrupted",
  };
  const expectedTerminalStatus = terminalStatusByPhase[supervision.phase];
  if (expectedTerminalStatus && run.state.status !== expectedTerminalStatus) {
    issues.push({
      path: ["supervision", "phase"],
      message: `Supervision phase ${supervision.phase} requires run status ${expectedTerminalStatus}`,
    });
  }
  if (run.state.status === "succeeded") {
    if (supervision.workItems.some((workItem) => workItem.status !== "succeeded")) {
      issues.push({
        path: ["state", "status"],
        message: "A succeeded supervised run requires every planned work item to succeed",
      });
    }
    if (isPendingHumanRequest(supervision.humanRequest)) {
      issues.push({
        path: ["state", "status"],
        message: "A succeeded supervised run cannot retain an unresolved human request",
      });
    }
  }
  if (
    run.state.status !== "succeeded" &&
    TERMINAL_RUN_STATUSES.has(run.state.status) &&
    supervision.workItems.some(
      (workItem) => workItem.status === "planned" || workItem.status === "active",
    )
  ) {
    issues.push({
      path: ["supervision", "workItems"],
      message: "A terminal supervised run cannot retain unfinished work items",
    });
  }
  return issues;
}

function validateRunLifecycle(run: TeamRunRecordShape): ContractIssue[] {
  if (run.supervision) return validateSupervisedRunLifecycle(run);
  const issues: ContractIssue[] = [];
  const stepStatuses = run.steps.map((step) => step.state.status);
  issues.push(...validateSequentialStepStatuses(stepStatuses));
  issues.push(...validateCanceledOrInterruptedOutcome(run, stepStatuses));
  const activeStepCount = stepStatuses.filter((status) => ACTIVE_STEP_STATUSES.has(status)).length;
  if (activeStepCount > 1) {
    issues.push({
      path: ["steps"],
      message: "A sequential Team Run cannot have more than one active step",
    });
  }
  const isTerminalRun = TERMINAL_RUN_STATUSES.has(run.state.status);
  if (isTerminalRun && activeStepCount > 0) {
    issues.push({
      path: ["state", "status"],
      message: "A terminal run cannot contain an active step",
    });
  }

  const requiredStepStatus = requiredCurrentStepStatus(run.state.status);
  if (requiredStepStatus && !stepStatuses.includes(requiredStepStatus)) {
    issues.push({
      path: ["state", "status"],
      message: `Run status ${requiredStepStatus} requires a matching current step`,
    });
  }
  if (run.state.status === "queued" && stepStatuses.some((status) => status !== "pending")) {
    issues.push({
      path: ["state", "status"],
      message: "A queued run can contain only pending steps",
    });
  }
  const hasRunningStep = stepStatuses.some(
    (status) => status === "creating" || status === "running",
  );
  if (run.state.status === "running" && !hasRunningStep) {
    issues.push({
      path: ["state", "status"],
      message: "A running run requires a creating or running step",
    });
  }
  const hasUnfinishedStep = stepStatuses.some((status) => status !== "succeeded");
  if (run.state.status === "succeeded" && hasUnfinishedStep) {
    issues.push({
      path: ["state", "status"],
      message: "A succeeded run requires every step to succeed",
    });
  }
  const hasFailedStep = stepStatuses.includes("failed");
  const hasPendingStep = stepStatuses.includes("pending");
  const isBoundaryFailure = stepStatuses.every(
    (status) => status === "succeeded" || status === "pending",
  );
  const hasValidFailedState = hasFailedStep || (hasPendingStep && isBoundaryFailure);
  if (run.state.status === "failed" && !hasValidFailedState) {
    issues.push({
      path: ["state", "status"],
      message: "A failed run requires a failed step or a preflight failure",
    });
  }
  return issues;
}

function validateCanceledOrInterruptedOutcome(
  run: TeamRunRecordShape,
  stepStatuses: TeamRunStepStatus[],
): ContractIssue[] {
  const status = run.state.status;
  if (status !== "canceled" && status !== "interrupted") return [];

  const allPending = stepStatuses.every((stepStatus) => stepStatus === "pending");
  if (run.state.startedAt === null) {
    if (allPending) return [];
    return [
      {
        path: ["state", "startedAt"],
        message: `A pre-start ${status} run can contain only pending steps`,
      },
    ];
  }

  const hasMatchingTerminalStep = stepStatuses.includes(status);
  const hasPendingStep = stepStatuses.includes("pending");
  const isStepBoundary = stepStatuses.every(
    (stepStatus) => stepStatus === "succeeded" || stepStatus === "pending",
  );
  if (hasMatchingTerminalStep || (hasPendingStep && isStepBoundary)) return [];
  return [
    {
      path: ["state", "status"],
      message: `A ${status} run requires a matching step or a pending workflow boundary`,
    },
  ];
}

function validateSequentialStepStatuses(statuses: TeamRunStepStatus[]): ContractIssue[] {
  let frontierIndex: number | null = null;
  for (const [index, status] of statuses.entries()) {
    if (status === "succeeded") {
      if (frontierIndex !== null) {
        return [
          {
            path: ["steps", index, "state", "status"],
            message: "Succeeded steps must form a workflow prefix",
          },
        ];
      }
      continue;
    }
    if (status === "pending") {
      frontierIndex ??= index;
      continue;
    }
    if (frontierIndex !== null) {
      return [
        {
          path: ["steps", index, "state", "status"],
          message: "Only the next workflow step may be active or terminal",
        },
      ];
    }
    frontierIndex = index;
  }
  return [];
}

function validateRunTimestamps(run: TeamRunRecordShape): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const createdAt = Date.parse(run.createdAt);
  const updatedAt = Date.parse(run.updatedAt);
  if (updatedAt < createdAt) {
    issues.push({ path: ["updatedAt"], message: "updatedAt cannot precede createdAt" });
  }
  validateStateTimestamps(run.state, ["state"], createdAt, updatedAt, issues);
  for (const [index, step] of run.steps.entries()) {
    validateStateTimestamps(step.state, ["steps", index, "state"], createdAt, updatedAt, issues);
  }
  if (run.supervision) {
    validateTimestampBounds(
      run.supervision.updatedAt,
      "updatedAt",
      ["supervision"],
      createdAt,
      updatedAt,
      issues,
    );
    let precedingDecisionAt: number | null = null;
    for (const [index, decision] of run.supervision.decisions.entries()) {
      const decisionAt = validateTimestampBounds(
        decision.createdAt,
        "createdAt",
        ["supervision", "decisions", index],
        createdAt,
        updatedAt,
        issues,
      );
      if (precedingDecisionAt !== null && decisionAt < precedingDecisionAt) {
        issues.push({
          path: ["supervision", "decisions", index, "createdAt"],
          message: "Supervisor decisions must be ordered by creation time",
        });
      }
      precedingDecisionAt = decisionAt;
    }
    const request = run.supervision.humanRequest;
    if (request) {
      const requestCreatedAt = validateTimestampBounds(
        request.createdAt,
        "createdAt",
        ["supervision", "humanRequest"],
        createdAt,
        updatedAt,
        issues,
      );
      if (request.resolution) {
        const resolvedAt = validateTimestampBounds(
          request.resolution.resolvedAt,
          "resolvedAt",
          ["supervision", "humanRequest", "resolution"],
          createdAt,
          updatedAt,
          issues,
        );
        if (resolvedAt < requestCreatedAt) {
          issues.push({
            path: ["supervision", "humanRequest", "resolution", "resolvedAt"],
            message: "Human request resolution cannot precede the request",
          });
        }
      }
      if (request.retirement) {
        const retiredAt = validateTimestampBounds(
          request.retirement.retiredAt,
          "retiredAt",
          ["supervision", "humanRequest", "retirement"],
          createdAt,
          updatedAt,
          issues,
        );
        if (retiredAt < requestCreatedAt) {
          issues.push({
            path: ["supervision", "humanRequest", "retirement", "retiredAt"],
            message: "Human request retirement cannot precede the request",
          });
        }
      }
    }
  }
  validateRunStepTimestampOrder(run, issues);
  return issues;
}

function validateRunStepTimestampOrder(run: TeamRunRecordShape, issues: ContractIssue[]): void {
  const runStartedAt =
    "startedAt" in run.state && run.state.startedAt !== null
      ? Date.parse(run.state.startedAt)
      : null;
  const runEndedAt = "endedAt" in run.state ? Date.parse(run.state.endedAt) : null;
  const runStopRequestedAt =
    "stopRequestedAt" in run.state ? Date.parse(run.state.stopRequestedAt) : null;
  let precedingStepEndedAt: number | null = null;

  for (const [index, step] of run.steps.entries()) {
    const path = ["steps", index, "state"];
    if ("startedAt" in step.state) {
      const stepStartedAt = Date.parse(step.state.startedAt);
      const overlapsPrecedingStep =
        precedingStepEndedAt !== null && stepStartedAt < precedingStepEndedAt;
      if (overlapsPrecedingStep) {
        issues.push({
          path: [...path, "startedAt"],
          message: "Step startedAt cannot precede the preceding step endedAt",
        });
      }
    }
    if (runStartedAt !== null) {
      if ("startedAt" in step.state && Date.parse(step.state.startedAt) < runStartedAt) {
        issues.push({
          path: [...path, "startedAt"],
          message: "Step startedAt cannot precede run startedAt",
        });
      }
    }
    if (runEndedAt !== null) {
      if ("endedAt" in step.state && Date.parse(step.state.endedAt) > runEndedAt) {
        issues.push({
          path: [...path, "endedAt"],
          message: "Step endedAt cannot follow run endedAt",
        });
      }
    }
    if (runStopRequestedAt !== null) {
      if (
        "stopRequestedAt" in step.state &&
        Date.parse(step.state.stopRequestedAt) < runStopRequestedAt
      ) {
        issues.push({
          path: [...path, "stopRequestedAt"],
          message: "Step stopRequestedAt cannot precede run stopRequestedAt",
        });
      }
    }
    if ("endedAt" in step.state) {
      precedingStepEndedAt = Date.parse(step.state.endedAt);
    }
  }
}

function validateStateTimestamps(
  state: PersistedTeamRunState | PersistedTeamRunStepState,
  path: (string | number)[],
  createdAt: number,
  updatedAt: number,
  issues: ContractIssue[],
): void {
  const stateStartedAt = "startedAt" in state ? state.startedAt : null;
  let startedAt: number | null = null;
  if (stateStartedAt !== null) {
    startedAt = validateTimestampBounds(
      stateStartedAt,
      "startedAt",
      path,
      createdAt,
      updatedAt,
      issues,
    );
  }
  if ("stopRequestedAt" in state) {
    const stopRequestedAt = validateTimestampBounds(
      state.stopRequestedAt,
      "stopRequestedAt",
      path,
      createdAt,
      updatedAt,
      issues,
    );
    if (startedAt !== null && stopRequestedAt < startedAt) {
      issues.push({
        path: [...path, "stopRequestedAt"],
        message: "stopRequestedAt cannot precede startedAt",
      });
    }
  }
  if (!("endedAt" in state)) return;
  const endedAt = validateTimestampBounds(
    state.endedAt,
    "endedAt",
    path,
    createdAt,
    updatedAt,
    issues,
  );
  if (startedAt !== null && endedAt < startedAt) {
    issues.push({ path: [...path, "endedAt"], message: "endedAt cannot precede startedAt" });
  }
}

type LifecycleTimestampField =
  | "createdAt"
  | "updatedAt"
  | "startedAt"
  | "stopRequestedAt"
  | "resolvedAt"
  | "retiredAt"
  | "endedAt";

function validateTimestampBounds(
  value: string,
  field: LifecycleTimestampField,
  path: (string | number)[],
  createdAt: number,
  updatedAt: number,
  issues: ContractIssue[],
): number {
  const timestamp = Date.parse(value);
  if (timestamp < createdAt) {
    issues.push({ path: [...path, field], message: `${field} cannot precede createdAt` });
  }
  if (timestamp > updatedAt) {
    issues.push({ path: [...path, field], message: `${field} cannot follow updatedAt` });
  }
  return timestamp;
}

export const PersistedTeamRunRecordSchema = PersistedTeamRunRecordBaseSchema.superRefine(
  (run, context) => {
    const issues = [
      ...validateRunIdentity(run),
      ...validateRunStepSnapshots(run),
      ...validateRunLifecycle(run),
      ...validateRunTimestamps(run),
    ];
    for (const issue of issues) {
      context.addIssue({ code: "custom", ...issue });
    }
  },
);

export type PersistedTeamDefinition = z.infer<typeof PersistedTeamDefinitionSchema>;
export type PersistedTeamRunRecord = z.infer<typeof PersistedTeamRunRecordSchema>;
export type PersistedTeamRunSupervision = z.infer<typeof PersistedTeamRunSupervisionSchema>;

const TEAM_RUN_TRANSITIONS: Readonly<Record<TeamRunStatus, ReadonlySet<TeamRunStatus>>> = {
  queued: new Set(["running", "failed", "canceled", "interrupted"]),
  running: new Set([
    "waiting_for_permission",
    "stopping",
    "succeeded",
    "failed",
    "canceled",
    "interrupted",
  ]),
  waiting_for_permission: new Set([
    "running",
    "stopping",
    "succeeded",
    "failed",
    "canceled",
    "interrupted",
  ]),
  stopping: new Set(["stop_failed", "succeeded", "failed", "canceled", "interrupted"]),
  stop_failed: new Set([
    "running",
    "waiting_for_permission",
    "stopping",
    "succeeded",
    "failed",
    "canceled",
    "interrupted",
  ]),
  succeeded: new Set(),
  failed: new Set(),
  canceled: new Set(),
  interrupted: new Set(),
};

const TEAM_RUN_STEP_TRANSITIONS: Readonly<
  Record<TeamRunStepStatus, ReadonlySet<TeamRunStepStatus>>
> = {
  pending: new Set(["creating"]),
  creating: new Set(["running", "stopping", "failed", "canceled", "interrupted"]),
  running: new Set([
    "waiting_for_permission",
    "stopping",
    "succeeded",
    "failed",
    "canceled",
    "interrupted",
  ]),
  waiting_for_permission: new Set([
    "running",
    "stopping",
    "succeeded",
    "failed",
    "canceled",
    "interrupted",
  ]),
  stopping: new Set(["stop_failed", "succeeded", "failed", "canceled", "interrupted"]),
  stop_failed: new Set([
    "running",
    "waiting_for_permission",
    "stopping",
    "succeeded",
    "failed",
    "canceled",
    "interrupted",
  ]),
  succeeded: new Set(),
  failed: new Set(),
  canceled: new Set(),
  interrupted: new Set(),
};

export function canTransitionTeamRun(from: TeamRunStatus, to: TeamRunStatus): boolean {
  return from === to || TEAM_RUN_TRANSITIONS[from].has(to);
}

export function canTransitionTeamRunStep(from: TeamRunStepStatus, to: TeamRunStepStatus): boolean {
  return from === to || TEAM_RUN_STEP_TRANSITIONS[from].has(to);
}

export function isActiveTeamRunStatus(status: TeamRunStatus): boolean {
  return !TERMINAL_RUN_STATUSES.has(status);
}

export function isTerminalTeamRunStatus(status: TeamRunStatus): boolean {
  return !isActiveTeamRunStatus(status);
}

export function isTeamRunSupervisionDecisionBoundary(run: PersistedTeamRunRecord): boolean {
  if (!run.supervision) return false;
  if (run.state.status === "queued") return run.supervision.phase === "queued";
  if (run.state.status !== "running") return false;
  if (run.supervision.phase !== "planning" && run.supervision.phase !== "working") return false;
  return !run.steps.some((step) => ACTIVE_STEP_STATUSES.has(step.state.status));
}

export function generateTeamId(): string {
  return `team_${randomBytes(8).toString("hex")}`;
}

export function generateTeamRunId(): string {
  return `trun_${randomBytes(8).toString("hex")}`;
}

export function generateTeamRoleId(): string {
  return `role_${randomBytes(8).toString("hex")}`;
}

export function generateTeamWorkflowStepId(): string {
  return `step_${randomBytes(8).toString("hex")}`;
}
