import { randomBytes } from "node:crypto";

import { z } from "zod";

export const TEAM_NAME_MAX_CHARS = 120;
export const TEAM_ROLE_NAME_MAX_CHARS = 80;
export const TEAM_INSTRUCTIONS_MAX_CHARS = 32_000;
export const TEAM_OBJECTIVE_MAX_CHARS = 32_000;
export const TEAM_ERROR_MAX_CHARS = 4_096;
export const TEAM_IDEMPOTENCY_KEY_MAX_CHARS = 256;
export const TEAM_PROVIDER_ID_MAX_CHARS = 128;
export const TEAM_MODEL_ID_MAX_CHARS = 256;
export const TEAM_ENTITY_ID_MAX_CHARS = 128;
export const TEAM_MAX_ROLES = 12;
export const TEAM_MAX_WORKFLOW_STEPS = 24;
export const TEAM_HANDOFF_MAX_BYTES = 4_096;

function nonBlankStringSchema(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0, "Must contain non-whitespace characters");
}

const EntityIdSchema = z
  .string()
  .min(1)
  .max(TEAM_ENTITY_ID_MAX_CHARS)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const WorkspaceRegistryIdSchema = nonBlankStringSchema(8_192);
const TimestampSchema = z.string().datetime({ offset: true });
const ErrorSchema = nonBlankStringSchema(TEAM_ERROR_MAX_CHARS);

export const PersistedTeamLaunchPreferenceSchema = z
  .object({
    provider: nonBlankStringSchema(TEAM_PROVIDER_ID_MAX_CHARS),
    model: nonBlankStringSchema(TEAM_MODEL_ID_MAX_CHARS).nullable(),
  })
  .strict();

export const PersistedTeamRoleSchema = z
  .object({
    id: EntityIdSchema,
    name: nonBlankStringSchema(TEAM_ROLE_NAME_MAX_CHARS),
    instructions: nonBlankStringSchema(TEAM_INSTRUCTIONS_MAX_CHARS),
    launch: PersistedTeamLaunchPreferenceSchema,
  })
  .strict();

export const PersistedTeamWorkflowStepSchema = z
  .object({
    id: EntityIdSchema,
    roleId: EntityIdSchema,
    instructions: nonBlankStringSchema(TEAM_INSTRUCTIONS_MAX_CHARS).nullable(),
  })
  .strict();

export const PersistedTeamDefinitionSchema = z
  .object({
    id: EntityIdSchema,
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

export const PersistedTeamRunStepSnapshotSchema = z
  .object({
    stepId: EntityIdSchema,
    roleId: EntityIdSchema,
    roleName: nonBlankStringSchema(TEAM_ROLE_NAME_MAX_CHARS),
    roleInstructions: nonBlankStringSchema(TEAM_INSTRUCTIONS_MAX_CHARS),
    stepInstructions: nonBlankStringSchema(TEAM_INSTRUCTIONS_MAX_CHARS).nullable(),
    acceptedLaunch: PersistedTeamLaunchPreferenceSchema,
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
    agentId: z.guid(),
    startedAt: TimestampSchema,
  })
  .strict();
const WaitingForPermissionStepStateSchema = z
  .object({
    status: z.literal("waiting_for_permission"),
    agentId: z.guid(),
    startedAt: TimestampSchema,
  })
  .strict();
const StoppingStepStateSchema = z
  .object({
    status: z.literal("stopping"),
    agentId: z.guid(),
    startedAt: TimestampSchema,
    stopRequestedAt: TimestampSchema,
  })
  .strict();
const SucceededStepStateSchema = z
  .object({
    status: z.literal("succeeded"),
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
    agentId: z.guid(),
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
    agentId: z.guid(),
    startedAt: TimestampSchema,
    stopRequestedAt: TimestampSchema,
    error: ErrorSchema,
  })
  .strict();

export const PersistedTeamRunStepStateSchema = z.discriminatedUnion("status", [
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
]);

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

const PersistedTeamRunRecordBaseSchema = z
  .object({
    id: EntityIdSchema,
    teamId: EntityIdSchema,
    teamRevision: z.number().int().positive(),
    idempotencyKey: nonBlankStringSchema(TEAM_IDEMPOTENCY_KEY_MAX_CHARS),
    teamSnapshot: PersistedTeamDefinitionSchema,
    objective: nonBlankStringSchema(TEAM_OBJECTIVE_MAX_CHARS),
    workspace: PersistedTeamRunWorkspaceSnapshotSchema,
    steps: z.array(PersistedTeamRunStepSchema).min(1).max(TEAM_MAX_WORKFLOW_STEPS),
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
  if (run.steps.length !== run.teamSnapshot.workflow.length) {
    issues.push({ path: ["steps"], message: "Run steps must match the frozen workflow length" });
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
  const providerMatches = step.snapshot.acceptedLaunch.provider === role.launch.provider;
  const modelMatches =
    role.launch.model === null || step.snapshot.acceptedLaunch.model === role.launch.model;
  return identityMatches && instructionsMatch && providerMatches && modelMatches;
}

function validateRunStepSnapshots(run: TeamRunRecordShape): ContractIssue[] {
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

function validateRunLifecycle(run: TeamRunRecordShape): ContractIssue[] {
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
  return issues;
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

type LifecycleTimestampField = "startedAt" | "stopRequestedAt" | "endedAt";

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
  creating: new Set(["running", "stopping", "failed", "interrupted"]),
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
