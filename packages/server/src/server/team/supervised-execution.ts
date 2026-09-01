import { z } from "zod";

import {
  PersistedTeamEntityIdSchema,
  TEAM_SUPERVISION_DECISION_SUMMARY_MAX_CHARS,
  type PersistedTeamRunRecord,
  type PersistedTeamRunSupervision,
} from "./model.js";
import type {
  TeamRunSupervisionDecision,
  TeamRunSupervisionDecisionCommitContext,
  TeamRunSupervisionUpdate,
} from "./repository.js";

const SummarySchema = z
  .string()
  .min(1)
  .max(TEAM_SUPERVISION_DECISION_SUMMARY_MAX_CHARS)
  .refine((value) => value.trim().length > 0, "Must contain non-whitespace characters");

const PlannedWorkItemSchema = z
  .object({
    id: PersistedTeamEntityIdSchema,
    templateStepId: PersistedTeamEntityIdSchema,
  })
  .strict();

const SupervisorActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("plan"),
      actionId: PersistedTeamEntityIdSchema,
      summary: SummarySchema,
      workItems: z.array(PlannedWorkItemSchema).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("dispatch"),
      actionId: PersistedTeamEntityIdSchema,
      summary: SummarySchema,
      workItemId: PersistedTeamEntityIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("escalate"),
      actionId: PersistedTeamEntityIdSchema,
      summary: SummarySchema,
      workItemId: PersistedTeamEntityIdSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("complete"),
      actionId: PersistedTeamEntityIdSchema,
      summary: SummarySchema,
    })
    .strict(),
]);

export type TeamSupervisorAction = z.infer<typeof SupervisorActionSchema>;

export interface TeamSupervisorActionSchemaOptions {
  dispatchArtifactIssues?: ReadonlyMap<string, string>;
}

export function createTeamSupervisorActionSchema(
  run: PersistedTeamRunRecord & { supervision: PersistedTeamRunSupervision },
  options: TeamSupervisorActionSchemaOptions = {},
): z.ZodType<TeamSupervisorAction> {
  return SupervisorActionSchema.superRefine((action, context) => {
    const supervision = run.supervision;
    if (supervision.decisions.length >= supervision.limits.maxSupervisorActions) {
      context.addIssue({ code: "custom", path: ["kind"], message: "Action limit reached" });
    }
    if (supervision.decisions.some((decision) => decision.actionId === action.actionId)) {
      context.addIssue({
        code: "custom",
        path: ["actionId"],
        message: "Action ID has already been committed",
      });
    }

    if (action.kind === "plan") validatePlanAction(run, action, context);
    if (action.kind === "dispatch") validateDispatchAction(run, action, context, options);
    if (action.kind === "escalate") validateEscalationAction(run, action, context);
    if (action.kind === "complete") validateCompleteAction(run, context);
  });
}

function validatePlanAction(
  run: PersistedTeamRunRecord & { supervision: PersistedTeamRunSupervision },
  action: Extract<TeamSupervisorAction, { kind: "plan" }>,
  context: z.core.$RefinementCtx<TeamSupervisorAction>,
): void {
  const supervision = run.supervision;
  if (
    supervision.workItems.length > 0 ||
    supervision.decisions.some((item) => item.kind === "plan")
  ) {
    context.addIssue({ code: "custom", path: ["kind"], message: "Work has already been planned" });
  }
  if (action.workItems.length > supervision.limits.maxWorkItems) {
    context.addIssue({
      code: "custom",
      path: ["workItems"],
      message: `Plan exceeds the ${supervision.limits.maxWorkItems} work-item limit`,
    });
  }
  const templateIds = new Set(supervision.workerTemplates.map((template) => template.stepId));
  const seenWorkItemIds = new Set<string>();
  const seenTemplateIds = new Set<string>();
  for (const [index, workItem] of action.workItems.entries()) {
    if (seenWorkItemIds.has(workItem.id)) {
      context.addIssue({
        code: "custom",
        path: ["workItems", index, "id"],
        message: "Work-item IDs must be unique",
      });
    }
    seenWorkItemIds.add(workItem.id);
    if (!templateIds.has(workItem.templateStepId)) {
      context.addIssue({
        code: "custom",
        path: ["workItems", index, "templateStepId"],
        message: "Work item must use a frozen worker template",
      });
    }
    if (seenTemplateIds.has(workItem.templateStepId)) {
      context.addIssue({
        code: "custom",
        path: ["workItems", index, "templateStepId"],
        message: "A worker template may appear only once in the initial plan",
      });
    }
    seenTemplateIds.add(workItem.templateStepId);
  }
}

function validateDispatchAction(
  run: PersistedTeamRunRecord & { supervision: PersistedTeamRunSupervision },
  action: Extract<TeamSupervisorAction, { kind: "dispatch" }>,
  context: z.core.$RefinementCtx<TeamSupervisorAction>,
  options: TeamSupervisorActionSchemaOptions,
): void {
  const workItem = run.supervision.workItems.find((item) => item.id === action.workItemId);
  if (!workItem) {
    context.addIssue({
      code: "custom",
      path: ["workItemId"],
      message: "Dispatch must name a planned work item",
    });
    return;
  }
  if (workItem.status !== "planned") {
    context.addIssue({
      code: "custom",
      path: ["workItemId"],
      message: "Only a planned work item can be dispatched",
    });
  }
  if (workItem.attemptIds.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["workItemId"],
      message: "Revision attempts are not available in this executor",
    });
  }
  const workItemIndex = run.supervision.workItems.indexOf(workItem);
  const unfinishedPredecessor = run.supervision.workItems
    .slice(0, workItemIndex)
    .find((candidate) => candidate.status !== "succeeded");
  if (unfinishedPredecessor) {
    context.addIssue({
      code: "custom",
      path: ["workItemId"],
      message: `Dispatch requires preceding work item ${unfinishedPredecessor.id} to succeed`,
    });
  }
  const artifactIssue = options.dispatchArtifactIssues?.get(workItem.id);
  if (artifactIssue) {
    context.addIssue({
      code: "custom",
      path: ["workItemId"],
      message: `Dispatch Artifact inputs are unavailable: ${artifactIssue}`,
    });
  }
}

function validateEscalationAction(
  run: PersistedTeamRunRecord & { supervision: PersistedTeamRunSupervision },
  action: Extract<TeamSupervisorAction, { kind: "escalate" }>,
  context: z.core.$RefinementCtx<TeamSupervisorAction>,
): void {
  if (run.supervision.humanRequest !== null) {
    context.addIssue({
      code: "custom",
      path: ["kind"],
      message: "This run already contains a human request",
    });
  }
  if (
    action.workItemId !== null &&
    !run.supervision.workItems.some((item) => item.id === action.workItemId)
  ) {
    context.addIssue({
      code: "custom",
      path: ["workItemId"],
      message: "Escalation references an unknown work item",
    });
  }
}

function validateCompleteAction(
  run: PersistedTeamRunRecord & { supervision: PersistedTeamRunSupervision },
  context: z.core.$RefinementCtx<TeamSupervisorAction>,
): void {
  if (
    run.supervision.workItems.length === 0 ||
    run.supervision.workItems.some((workItem) => workItem.status !== "succeeded")
  ) {
    context.addIssue({
      code: "custom",
      path: ["kind"],
      message: "Complete requires every planned work item to have succeeded",
    });
  }
}

export function composeTeamSupervisorPrompt(
  run: PersistedTeamRunRecord & { supervision: PersistedTeamRunSupervision },
  options: TeamSupervisorActionSchemaOptions = {},
): string {
  const templates = run.supervision.workerTemplates.map(
    (template) =>
      `- ${template.stepId}: role=${template.roleName}; instructions=${JSON.stringify(template.stepInstructions)}`,
  );
  const workItems = run.supervision.workItems.map((workItem) => {
    const artifactIssue = options.dispatchArtifactIssues?.get(workItem.id);
    return `- ${workItem.id}: template=${workItem.templateStepId}; status=${workItem.status}; attempts=${workItem.attemptIds.join(",") || "none"}; dispatch=${artifactIssue ? `blocked(${JSON.stringify(artifactIssue)})` : "available"}`;
  });
  const decisions = run.supervision.decisions.map(
    (decision) =>
      `- ${decision.sequence}. ${decision.kind}; actionId=${decision.actionId}; summary=${JSON.stringify(decision.summary)}`,
  );
  const humanResolution = run.supervision.humanRequest?.resolution;
  const resolvedHumanRequest = humanResolution
    ? [
        "## Resolved human request",
        `Request: ${JSON.stringify(run.supervision.humanRequest!.detail)}`,
        `Action: ${humanResolution.actionId}`,
        `Note: ${humanResolution.note === null ? "none" : JSON.stringify(humanResolution.note)}`,
      ].join("\n")
    : null;
  return [
    `## Team\nName: ${run.teamSnapshot.name}\n\n${run.teamSnapshot.instructions}`,
    `## Supervisor role\nName: ${run.supervision.supervisor.roleName}\n\n${run.supervision.supervisor.roleInstructions}`,
    `## Assignment objective\n${run.objective}`,
    `## Frozen worker templates\n${templates.join("\n")}`,
    `## Durable work ledger\n${workItems.length > 0 ? workItems.join("\n") : "No work has been planned."}`,
    `## Prior durable decisions\n${decisions.length > 0 ? decisions.join("\n") : "No decisions have been committed."}`,
    ...(resolvedHumanRequest ? [resolvedHumanRequest] : []),
    [
      "## Decision rules",
      "Return exactly one action. Do not create agents or invoke delegation tools yourself.",
      "Use plan once to map one or more unique work-item IDs to frozen template step IDs. Plan order is execution and Artifact handoff order.",
      "Use dispatch for the first unfinished planned work item. The daemon creates that worker from its frozen template and supplies every accepted preceding output Artifact.",
      "Use escalate when a human decision is required. Use complete only after every planned work item succeeded.",
      `Limits: workItems=${run.supervision.limits.maxWorkItems}; activeWorkers=${run.supervision.limits.maxActiveWorkers}; actions=${run.supervision.limits.maxSupervisorActions}; delegationDepth=${run.supervision.limits.maxDelegationDepth}.`,
    ].join("\n"),
  ].join("\n\n");
}

export interface NormalizeTeamSupervisorDecisionInput {
  run: PersistedTeamRunRecord & { supervision: PersistedTeamRunSupervision };
  action: TeamSupervisorAction;
  decisionId: string;
  attemptId: string | null;
  createdAt: string;
}

export function normalizeTeamSupervisorDecision(
  input: NormalizeTeamSupervisorDecisionInput,
): TeamRunSupervisionDecision {
  const base = {
    id: input.decisionId,
    sequence: input.run.supervision.decisions.length + 1,
    actionId: input.action.actionId,
    summary: input.action.summary.trim(),
    createdAt: input.createdAt,
  };
  if (input.action.kind === "dispatch") {
    if (input.attemptId === null) throw new Error("Dispatch requires a preallocated attempt ID");
    return {
      ...base,
      kind: "dispatch",
      workItemId: input.action.workItemId,
      attemptId: input.attemptId,
    };
  }
  if (input.action.kind === "escalate") {
    const workItemId = input.action.workItemId;
    const workItem =
      workItemId === null
        ? null
        : input.run.supervision.workItems.find((item) => item.id === workItemId);
    return {
      ...base,
      kind: "escalate",
      workItemId,
      attemptId: workItem?.attemptIds.at(-1) ?? null,
    };
  }
  return {
    ...base,
    kind: input.action.kind,
    workItemId: null,
    attemptId: null,
  };
}

export interface BuildTeamSupervisionDecisionUpdateInput {
  run: PersistedTeamRunRecord & { supervision: PersistedTeamRunSupervision };
  action: TeamSupervisorAction;
  decision: TeamRunSupervisionDecision;
  context: TeamRunSupervisionDecisionCommitContext;
  workerAgentId: string | null;
  humanRequestId: string | null;
  timestamp: string;
}

export function buildTeamSupervisionDecisionUpdate(
  input: BuildTeamSupervisionDecisionUpdateInput,
): TeamRunSupervisionUpdate {
  const supervisorStepIndex = input.run.steps.findIndex((step) => {
    const metadata = step.snapshot.supervision;
    return (
      metadata?.kind === "supervisor" &&
      metadata.decisionId === input.decision.id &&
      (step.state.status === "running" || step.state.status === "waiting_for_permission")
    );
  });
  const supervisorStep = input.run.steps[supervisorStepIndex];
  if (
    !supervisorStep ||
    !("plannedAgentId" in supervisorStep.state) ||
    !("agentId" in supervisorStep.state) ||
    supervisorStep.state.agentId === null
  ) {
    throw new Error(`Supervisor decision ${input.decision.id} has no active persisted turn`);
  }
  const steps = input.run.steps.slice();
  steps[supervisorStepIndex] = {
    ...supervisorStep,
    state: {
      status: "succeeded",
      plannedAgentId: supervisorStep.state.plannedAgentId,
      agentId: supervisorStep.state.agentId,
      startedAt: supervisorStep.state.startedAt,
      endedAt: input.timestamp,
    },
  };

  let phase: PersistedTeamRunSupervision["phase"] = "planning";
  let state: PersistedTeamRunRecord["state"] = input.run.state;
  let workItems = input.run.supervision.workItems;
  let humanRequest = input.run.supervision.humanRequest;

  if (input.action.kind === "plan") {
    workItems = input.action.workItems.map((workItem) => ({
      ...workItem,
      inputArtifactIds: [],
      attemptIds: [],
      acceptedAttemptId: null,
      status: "planned" as const,
    }));
  }
  if (input.action.kind === "dispatch") {
    const workItemId = input.action.workItemId;
    const inputArtifactIds = resolveSupervisedWorkItemInputArtifactIds(input.run, workItemId);
    appendDispatchedWorker(input, steps, inputArtifactIds);
    workItems = input.run.supervision.workItems.map((workItem) =>
      workItem.id === workItemId
        ? {
            ...workItem,
            inputArtifactIds,
            attemptIds: [...workItem.attemptIds, input.decision.attemptId!],
            status: "active" as const,
          }
        : workItem,
    );
    phase = "working";
  }
  if (input.action.kind === "escalate") {
    if (input.humanRequestId === null) throw new Error("Escalation requires a human request ID");
    phase = "awaiting_human";
    humanRequest = {
      id: input.humanRequestId,
      revision: 1,
      kind: "supervisor_escalation",
      title: "Supervisor needs input",
      detail: input.action.summary.trim(),
      actions: [
        { id: "continue", label: "Continue", requiresNote: true },
        { id: "cancel", label: "Cancel run", requiresNote: false },
      ],
      roleIds: [input.run.supervision.supervisor.roleId],
      agentIds: [input.run.supervision.supervisor.agentId],
      stepIds: [],
      artifactIds: [],
      createdAt: input.timestamp,
    };
  }
  if (input.action.kind === "complete") {
    phase = "completed";
    state = {
      status: "succeeded",
      startedAt: requireRunStartedAt(input.run),
      endedAt: input.timestamp,
    };
  }

  return {
    steps,
    state,
    supervision: {
      ...input.run.supervision,
      revision: input.run.supervision.revision + 1,
      phase,
      workItems,
      decisions: [...input.run.supervision.decisions, input.decision],
      humanRequest,
      updatedAt: input.timestamp,
    },
  };
}

function appendDispatchedWorker(
  input: BuildTeamSupervisionDecisionUpdateInput,
  steps: PersistedTeamRunRecord["steps"],
  inputArtifactIds: string[],
): void {
  if (
    input.action.kind !== "dispatch" ||
    input.decision.kind !== "dispatch" ||
    input.workerAgentId === null ||
    input.context.outputArtifactId === null
  ) {
    throw new Error("Dispatch requires preallocated worker, attempt, and Artifact IDs");
  }
  const workItemId = input.action.workItemId;
  const workItem = input.run.supervision.workItems.find((item) => item.id === workItemId);
  const template = input.run.supervision.workerTemplates.find(
    (item) => item.stepId === workItem?.templateStepId,
  );
  if (!workItem || !template) throw new Error("Dispatch references an unknown frozen work item");
  steps.push({
    snapshot: {
      ...template,
      stepId: `worker_${input.decision.attemptId}`,
      inputArtifactIds,
      outputArtifact: {
        id: input.context.outputArtifactId,
        kind: "team_step_output",
        title: `${template.roleName} output`,
        mediaType: "text/markdown",
      },
      supervision: {
        kind: "worker",
        workItemId: workItem.id,
        attemptId: input.decision.attemptId,
        attemptNumber: workItem.attemptIds.length + 1,
        templateStepId: template.stepId,
        revisionParentAttemptId: null,
      },
    },
    state: {
      status: "creating",
      plannedAgentId: input.workerAgentId,
      startedAt: input.timestamp,
    },
  });
}

export function resolveSupervisedWorkItemInputArtifactIds(
  run: PersistedTeamRunRecord & { supervision: PersistedTeamRunSupervision },
  workItemId: string,
): string[] {
  const workItemIndex = run.supervision.workItems.findIndex((item) => item.id === workItemId);
  if (workItemIndex < 0) throw new Error(`Unknown supervised work item ${workItemId}`);
  return run.supervision.workItems.slice(0, workItemIndex).map((workItem) => {
    if (workItem.status !== "succeeded" || workItem.acceptedAttemptId === null) {
      throw new Error(`Preceding work item ${workItem.id} has no accepted attempt`);
    }
    const acceptedStep = run.steps.find(
      (step) =>
        step.snapshot.supervision?.kind === "worker" &&
        step.snapshot.supervision.attemptId === workItem.acceptedAttemptId,
    );
    const outputArtifactId = acceptedStep?.snapshot.outputArtifact?.id;
    if (acceptedStep?.state.status !== "succeeded" || !outputArtifactId) {
      throw new Error(`Preceding work item ${workItem.id} has no accepted output Artifact`);
    }
    return outputArtifactId;
  });
}

export function composeSupervisedWorkerContext(
  run: PersistedTeamRunRecord & { supervision: PersistedTeamRunSupervision },
  workItemId: string,
): string {
  const plan = run.supervision.decisions.find((decision) => decision.kind === "plan");
  return [
    `Work item: ${workItemId}`,
    `Durable supervisor plan: ${plan?.summary ?? "No plan summary was recorded."}`,
    "Complete only this frozen workflow step. Do not delegate or create other agents.",
  ].join("\n");
}

function requireRunStartedAt(run: PersistedTeamRunRecord): string {
  if (!("startedAt" in run.state) || run.state.startedAt === null) {
    throw new Error(`Supervised Team Run ${run.id} has no start timestamp`);
  }
  return run.state.startedAt;
}
