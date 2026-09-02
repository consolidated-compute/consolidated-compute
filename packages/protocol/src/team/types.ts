import { z } from "zod";
import { AssignmentDtoSchema } from "../assignment/types.js";

export const TEAM_NAME_MAX_CHARS = 120;
export const TEAM_ROLE_NAME_MAX_CHARS = 80;
export const TEAM_INSTRUCTIONS_MAX_CHARS = 32_000;
export const TEAM_AGENT_PROFILE_ID_MAX_CHARS = 512;
export const TEAM_MAX_ROLES = 12;
export const TEAM_MAX_WORKFLOW_STEPS = 24;
export const TEAM_OBJECTIVE_MAX_CHARS = 32_000;
export const TEAM_SECURITY_SUMMARY_MAX_CHARS = 240;
export const TEAM_SUPERVISION_STATUS_MAX_CHARS = 64;
export const TEAM_SUPERVISION_EVENT_DETAIL_MAX_CHARS = 8_192;
export const TEAM_SUPERVISION_EVENT_KIND_MAX_CHARS = 128;
export const TEAM_SUPERVISION_EVENT_TITLE_MAX_CHARS = 256;
export const TEAM_SUPERVISION_HUMAN_REQUEST_DETAIL_MAX_CHARS = 8_192;
export const TEAM_SUPERVISION_HUMAN_REQUEST_NOTE_MAX_CHARS = 4_096;
export const TEAM_SUPERVISION_HUMAN_REQUEST_TITLE_MAX_CHARS = 256;
export const TEAM_SUPERVISION_MAX_EVENT_REFERENCES = 256;
export const TEAM_SUPERVISION_MAX_HUMAN_ACTIONS = 8;

export const TeamSecurityFactDtoSchema = z.object({
  status: z.enum(["enforced", "policy_only", "unavailable"]),
  summary: z.string().min(1).max(TEAM_SECURITY_SUMMARY_MAX_CHARS),
});

export const TeamSecurityPostureDtoSchema = z.object({
  source: z.object({ provider: z.string().min(1).max(128) }),
  filesystemWrite: TeamSecurityFactDtoSchema,
  networkAccess: TeamSecurityFactDtoSchema,
  toolShell: TeamSecurityFactDtoSchema,
  nativeDelegation: TeamSecurityFactDtoSchema.optional(),
});

export const TeamResolvedLaunchDtoSchema = z.object({
  profileId: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  modeId: z.string().nullable(),
  thinkingOptionId: z.string().nullable(),
  featureValues: z.record(z.string(), z.unknown()),
  securityPosture: TeamSecurityPostureDtoSchema.optional(),
});

export const TeamRoleDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  instructions: z.string(),
  profileId: z.string(),
});

export const TeamWorkflowStepDtoSchema = z.object({
  id: z.string(),
  roleId: z.string(),
  instructions: z.string().nullable(),
});

export const TeamDefinitionInputDtoSchema = z.object({
  name: z.string(),
  instructions: z.string(),
  roles: z.array(TeamRoleDtoSchema),
  workflow: z.array(TeamWorkflowStepDtoSchema),
});

const TeamDefinitionPatchFieldsDtoSchema = TeamDefinitionInputDtoSchema.partial();

export const TeamDefinitionPatchDtoSchema = z.union([
  TeamDefinitionPatchFieldsDtoSchema.extend({ name: TeamDefinitionInputDtoSchema.shape.name }),
  TeamDefinitionPatchFieldsDtoSchema.extend({
    instructions: TeamDefinitionInputDtoSchema.shape.instructions,
  }),
  TeamDefinitionPatchFieldsDtoSchema.extend({ roles: TeamDefinitionInputDtoSchema.shape.roles }),
  TeamDefinitionPatchFieldsDtoSchema.extend({
    workflow: TeamDefinitionInputDtoSchema.shape.workflow,
  }),
]);

export const TeamDefinitionDtoSchema = TeamDefinitionInputDtoSchema.extend({
  id: z.string(),
  revision: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const TeamRunWorkspaceDtoSchema = z.object({
  workspaceId: z.string(),
  projectId: z.string(),
  cwd: z.string(),
  displayName: z.string(),
});

export const TeamRunPreviewFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const TeamRunPreviewRoleDtoSchema = z.object({
  roleId: z.string(),
  roleName: z.string(),
  resolvedLaunch: TeamResolvedLaunchDtoSchema,
});

export const TeamRunPreviewDtoSchema = z.object({
  workspace: TeamRunWorkspaceDtoSchema,
  roles: z.array(TeamRunPreviewRoleDtoSchema),
  fingerprint: TeamRunPreviewFingerprintSchema,
});

export const TeamRunSupervisionStartDtoSchema = z.object({
  supervisorRoleId: z.string(),
});

export const TeamRunSupervisionSummaryDtoSchema = z.object({
  status: z.string().min(1).max(TEAM_SUPERVISION_STATUS_MAX_CHARS),
  supervisorRoleId: z.string(),
  supervisorAgentId: z.string(),
  completedWorkItems: z.number().int().nonnegative(),
  totalWorkItems: z.number().int().nonnegative(),
  pendingHumanRequest: z
    .object({
      id: z.string(),
      kind: z.string(),
      title: z.string().min(1).max(TEAM_SUPERVISION_HUMAN_REQUEST_TITLE_MAX_CHARS),
      revision: z.number().int().positive(),
    })
    .optional(),
  updatedAt: z.string(),
});

export const TeamRunSupervisionHumanActionDtoSchema = z.object({
  id: z.string(),
  label: z.string().min(1).max(128),
  description: z.string().min(1).max(512).optional(),
  requiresNote: z.boolean(),
});

export const TeamRunSupervisionHumanRequestDtoSchema = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
  kind: z.string().min(1).max(128),
  title: z.string().min(1).max(TEAM_SUPERVISION_HUMAN_REQUEST_TITLE_MAX_CHARS),
  detail: z.string().min(1).max(TEAM_SUPERVISION_HUMAN_REQUEST_DETAIL_MAX_CHARS),
  actions: z
    .array(TeamRunSupervisionHumanActionDtoSchema)
    .min(1)
    .max(TEAM_SUPERVISION_MAX_HUMAN_ACTIONS),
  roleIds: z.array(z.string()).max(TEAM_MAX_ROLES),
  agentIds: z.array(z.string()).max(TEAM_SUPERVISION_MAX_EVENT_REFERENCES),
  stepIds: z.array(z.string()).max(TEAM_SUPERVISION_MAX_EVENT_REFERENCES),
  artifactIds: z.array(z.string()).max(TEAM_MAX_WORKFLOW_STEPS),
  createdAt: z.string(),
  resolution: z
    .object({
      actionId: z.string(),
      note: z.string().min(1).max(TEAM_SUPERVISION_HUMAN_REQUEST_NOTE_MAX_CHARS).nullable(),
      resolvedAt: z.string(),
    })
    .optional(),
  retirement: z
    .object({
      reason: z.enum(["failed", "canceled", "interrupted"]),
      retiredAt: z.string(),
    })
    .optional(),
});

export const TeamRunSupervisionStateDtoSchema = z.object({
  runId: z.string(),
  revision: z.number().int().positive(),
  status: z.string().min(1).max(TEAM_SUPERVISION_STATUS_MAX_CHARS),
  supervisorRoleId: z.string(),
  supervisorAgentId: z.string(),
  completedWorkItems: z.number().int().nonnegative(),
  totalWorkItems: z.number().int().nonnegative(),
  humanRequest: TeamRunSupervisionHumanRequestDtoSchema.nullable(),
  updatedAt: z.string(),
});

export const TeamRunSupervisionEventDtoSchema = z.object({
  id: z.string(),
  sequence: z.number().int().positive(),
  kind: z.string().min(1).max(TEAM_SUPERVISION_EVENT_KIND_MAX_CHARS),
  title: z.string().min(1).max(TEAM_SUPERVISION_EVENT_TITLE_MAX_CHARS),
  detail: z.string().min(1).max(TEAM_SUPERVISION_EVENT_DETAIL_MAX_CHARS).optional(),
  decisionId: z.string().nullable(),
  actionId: z.string().nullable(),
  workItemId: z.string().nullable(),
  attemptId: z.string().nullable(),
  humanRequestId: z.string().nullable(),
  roleIds: z.array(z.string()).max(TEAM_MAX_ROLES),
  agentIds: z.array(z.string()).max(TEAM_SUPERVISION_MAX_EVENT_REFERENCES),
  stepIds: z.array(z.string()).max(TEAM_SUPERVISION_MAX_EVENT_REFERENCES),
  artifactIds: z.array(z.string()).max(TEAM_SUPERVISION_MAX_EVENT_REFERENCES),
  createdAt: z.string(),
});

export const TeamRunStepSnapshotDtoSchema = z.object({
  stepId: z.string(),
  roleId: z.string(),
  roleName: z.string(),
  roleInstructions: z.string(),
  stepInstructions: z.string().nullable(),
  resolvedLaunch: TeamResolvedLaunchDtoSchema,
  inputArtifactIds: z.array(z.string()).optional(),
  outputArtifact: z
    .object({
      id: z.string(),
      kind: z.literal("team_step_output"),
      title: z.string(),
      mediaType: z.literal("text/markdown"),
    })
    .optional(),
});

export const TeamRunStepUsageDtoSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.enum(["reported", "partial"]),
    inputTokens: z.number().nonnegative().optional(),
    cachedInputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    totalCostUsd: z.number().nonnegative().optional(),
    contextWindowMaxTokens: z.number().nonnegative().optional(),
    contextWindowUsedTokens: z.number().nonnegative().optional(),
  }),
  z.object({ status: z.literal("unavailable") }),
]);

export const TeamRunUnattendedPolicyDtoSchema = z.object({
  source: z.object({
    type: z.enum(["schedule", "hub"]),
    scopeId: z.string(),
  }),
  executionWindow: z.discriminatedUnion("type", [
    z.object({ type: z.literal("schedule") }),
    z.object({
      type: z.literal("event"),
      opensAt: z.string(),
      closesAt: z.string(),
    }),
  ]),
  maxRuntimeMs: z.number().int().positive(),
  deadlineAt: z.string(),
  maxActiveRunsOnHost: z.number().int().positive(),
  maxActiveRunsForSource: z.number().int().positive(),
  launchAllowlist: z.array(
    z.object({
      provider: z.string(),
      models: z.array(z.string().nullable()),
    }),
  ),
});

export const TeamRunTerminationDtoSchema = z.object({
  reason: z.enum(["cancel", "workspace", "shutdown", "deadline"]),
  requestedAt: z.string(),
});

export const TeamRunUsageDtoSchema = z.object({
  status: z.enum(["reported", "partial", "unavailable"]),
  reportedSteps: z.number().int().nonnegative(),
  unavailableSteps: z.number().int().nonnegative(),
  inputTokens: z.number().nonnegative().optional(),
  cachedInputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  totalCostUsd: z.number().nonnegative().optional(),
});

const PendingStepStateDtoSchema = z.object({ status: z.literal("pending") });
const CreatingStepStateDtoSchema = z.object({
  status: z.literal("creating"),
  plannedAgentId: z.string(),
  startedAt: z.string(),
});
const RunningStepStateDtoSchema = z.object({
  status: z.literal("running"),
  plannedAgentId: z.string(),
  agentId: z.string(),
  startedAt: z.string(),
});
const WaitingForPermissionStepStateDtoSchema = z.object({
  status: z.literal("waiting_for_permission"),
  plannedAgentId: z.string(),
  agentId: z.string(),
  startedAt: z.string(),
});
const StoppingStepStateDtoSchema = z.object({
  status: z.literal("stopping"),
  plannedAgentId: z.string(),
  agentId: z.string().nullable(),
  startedAt: z.string(),
  stopRequestedAt: z.string(),
});
const SucceededStepStateDtoSchema = z.object({
  status: z.literal("succeeded"),
  plannedAgentId: z.string(),
  agentId: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  usage: TeamRunStepUsageDtoSchema.optional(),
});
const FailedStepStateDtoSchema = z.object({
  status: z.literal("failed"),
  plannedAgentId: z.string(),
  agentId: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string(),
  error: z.string(),
});
const CanceledStepStateDtoSchema = z.object({
  status: z.literal("canceled"),
  plannedAgentId: z.string(),
  agentId: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string(),
});
const InterruptedStepStateDtoSchema = z.object({
  status: z.literal("interrupted"),
  plannedAgentId: z.string(),
  agentId: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string(),
  error: z.string(),
});
const StopFailedStepStateDtoSchema = z.object({
  status: z.literal("stop_failed"),
  plannedAgentId: z.string(),
  agentId: z.string(),
  startedAt: z.string(),
  stopRequestedAt: z.string(),
  error: z.string(),
});

export const TeamRunStepStateDtoSchema = z.discriminatedUnion("status", [
  PendingStepStateDtoSchema,
  CreatingStepStateDtoSchema,
  RunningStepStateDtoSchema,
  WaitingForPermissionStepStateDtoSchema,
  StoppingStepStateDtoSchema,
  SucceededStepStateDtoSchema,
  FailedStepStateDtoSchema,
  CanceledStepStateDtoSchema,
  InterruptedStepStateDtoSchema,
  StopFailedStepStateDtoSchema,
]);

export const TeamRunStepDtoSchema = z.object({
  snapshot: TeamRunStepSnapshotDtoSchema,
  state: TeamRunStepStateDtoSchema,
});

const QueuedRunStateDtoSchema = z.object({ status: z.literal("queued") });
const RunningRunStateDtoSchema = z.object({
  status: z.literal("running"),
  startedAt: z.string(),
});
const WaitingForPermissionRunStateDtoSchema = z.object({
  status: z.literal("waiting_for_permission"),
  startedAt: z.string(),
});
const StoppingRunStateDtoSchema = z.object({
  status: z.literal("stopping"),
  startedAt: z.string(),
  stopRequestedAt: z.string(),
});
const SucceededRunStateDtoSchema = z.object({
  status: z.literal("succeeded"),
  startedAt: z.string(),
  endedAt: z.string(),
});
const FailedRunStateDtoSchema = z.object({
  status: z.literal("failed"),
  startedAt: z.string(),
  endedAt: z.string(),
  error: z.string(),
});
const CanceledRunStateDtoSchema = z.object({
  status: z.literal("canceled"),
  startedAt: z.string().nullable(),
  endedAt: z.string(),
});
const InterruptedRunStateDtoSchema = z.object({
  status: z.literal("interrupted"),
  startedAt: z.string().nullable(),
  endedAt: z.string(),
  error: z.string(),
});
const StopFailedRunStateDtoSchema = z.object({
  status: z.literal("stop_failed"),
  startedAt: z.string(),
  stopRequestedAt: z.string(),
  error: z.string(),
});

export const TeamRunStateDtoSchema = z.discriminatedUnion("status", [
  QueuedRunStateDtoSchema,
  RunningRunStateDtoSchema,
  WaitingForPermissionRunStateDtoSchema,
  StoppingRunStateDtoSchema,
  SucceededRunStateDtoSchema,
  FailedRunStateDtoSchema,
  CanceledRunStateDtoSchema,
  InterruptedRunStateDtoSchema,
  StopFailedRunStateDtoSchema,
]);

export const TeamRunDtoSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  teamRevision: z.number().int(),
  idempotencyKey: z.string(),
  teamSnapshot: TeamDefinitionDtoSchema,
  objective: z.string(),
  assignmentId: z.string().optional(),
  assignmentRevision: z.number().int().optional(),
  assignmentSnapshot: AssignmentDtoSchema.optional(),
  workspace: TeamRunWorkspaceDtoSchema,
  steps: z.array(TeamRunStepDtoSchema),
  supervision: TeamRunSupervisionSummaryDtoSchema.optional(),
  unattendedPolicy: TeamRunUnattendedPolicyDtoSchema.optional(),
  termination: TeamRunTerminationDtoSchema.optional(),
  usage: TeamRunUsageDtoSchema.optional(),
  state: TeamRunStateDtoSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type TeamResolvedLaunchDto = z.infer<typeof TeamResolvedLaunchDtoSchema>;
export type TeamRunPreviewDto = z.infer<typeof TeamRunPreviewDtoSchema>;
export type TeamRunPreviewRoleDto = z.infer<typeof TeamRunPreviewRoleDtoSchema>;
export type TeamRunSupervisionStartDto = z.infer<typeof TeamRunSupervisionStartDtoSchema>;
export type TeamRunSupervisionSummaryDto = z.infer<typeof TeamRunSupervisionSummaryDtoSchema>;
export type TeamRunSupervisionHumanActionDto = z.infer<
  typeof TeamRunSupervisionHumanActionDtoSchema
>;
export type TeamRunSupervisionHumanRequestDto = z.infer<
  typeof TeamRunSupervisionHumanRequestDtoSchema
>;
export type TeamRunSupervisionStateDto = z.infer<typeof TeamRunSupervisionStateDtoSchema>;
export type TeamRunSupervisionEventDto = z.infer<typeof TeamRunSupervisionEventDtoSchema>;
export type TeamSecurityFactDto = z.infer<typeof TeamSecurityFactDtoSchema>;
export type TeamSecurityPostureDto = z.infer<typeof TeamSecurityPostureDtoSchema>;
export type TeamRoleDto = z.infer<typeof TeamRoleDtoSchema>;
export type TeamWorkflowStepDto = z.infer<typeof TeamWorkflowStepDtoSchema>;
export type TeamDefinitionInputDto = z.infer<typeof TeamDefinitionInputDtoSchema>;
export type TeamDefinitionPatchDto = z.infer<typeof TeamDefinitionPatchDtoSchema>;
export type TeamDefinitionDto = z.infer<typeof TeamDefinitionDtoSchema>;
export type TeamRunWorkspaceDto = z.infer<typeof TeamRunWorkspaceDtoSchema>;
export type TeamRunStepSnapshotDto = z.infer<typeof TeamRunStepSnapshotDtoSchema>;
export type TeamRunStepUsageDto = z.infer<typeof TeamRunStepUsageDtoSchema>;
export type TeamRunUnattendedPolicyDto = z.infer<typeof TeamRunUnattendedPolicyDtoSchema>;
export type TeamRunTerminationDto = z.infer<typeof TeamRunTerminationDtoSchema>;
export type TeamRunUsageDto = z.infer<typeof TeamRunUsageDtoSchema>;
export type TeamRunStepStateDto = z.infer<typeof TeamRunStepStateDtoSchema>;
export type TeamRunStepDto = z.infer<typeof TeamRunStepDtoSchema>;
export type TeamRunStateDto = z.infer<typeof TeamRunStateDtoSchema>;
export type TeamRunDto = z.infer<typeof TeamRunDtoSchema>;
