import {
  ASSIGNMENT_OBJECTIVE_MAX_CHARS,
  ASSIGNMENT_TITLE_MAX_CHARS,
  type AssignmentDto,
  type AssignmentInputDto,
  type AssignmentWorkItemReferenceDto,
} from "@getpaseo/protocol/assignment/types";
import { isValidAssignmentWorkItem } from "./work-item-validation";

export interface AssignmentFormHostOption {
  serverId: string;
  label: string;
}

export type AssignmentFormMode = "create" | "edit";

export type AssignmentFormValidationIssue =
  | "host_required"
  | "title_required"
  | "title_too_long"
  | "objective_required"
  | "objective_too_long"
  | "work_item_invalid";

export type AssignmentFormSubmission =
  | { kind: "create"; serverId: string; assignment: AssignmentInputDto }
  | {
      kind: "update";
      serverId: string;
      assignmentId: string;
      expectedRevision: number;
      patch: AssignmentInputDto;
    };

export interface AssignmentFormState {
  mode: AssignmentFormMode;
  hosts: AssignmentFormHostOption[];
  selectedServerId: string | null;
  selectedHostDisplay: string | null;
  assignmentId: string | null;
  expectedRevision: number | null;
  title: string;
  objective: string;
  workItem: AssignmentWorkItemReferenceDto | null;
  validationIssue: AssignmentFormValidationIssue | null;
  canSubmit: boolean;
  submission: AssignmentFormSubmission | null;
  submitError: string | null;
  revisionRecovered: boolean;
}

export interface AssignmentFormSnapshot {
  mode: AssignmentFormMode;
  hosts: readonly AssignmentFormHostOption[];
  selectedServerId?: string | null;
  assignment?: AssignmentDto;
}

export interface AssignmentFormModel {
  getState: () => AssignmentFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  applyHosts: (hosts: readonly AssignmentFormHostOption[]) => void;
  applyRemoteRevision: (revision: number) => void;
  setHost: (serverId: string, display: string) => void;
  setTitle: (title: string) => void;
  setObjective: (objective: string) => void;
  setWorkItem: (workItem: AssignmentWorkItemReferenceDto | null) => void;
  setSubmitError: (error: string | null) => void;
}

function validationIssue(state: AssignmentFormState): AssignmentFormValidationIssue | null {
  if (!state.selectedServerId) return "host_required";
  if (!state.title.trim()) return "title_required";
  if (state.title.length > ASSIGNMENT_TITLE_MAX_CHARS) return "title_too_long";
  if (!state.objective.trim()) return "objective_required";
  if (state.objective.length > ASSIGNMENT_OBJECTIVE_MAX_CHARS) return "objective_too_long";
  if (state.workItem && !isValidAssignmentWorkItem(state.workItem)) return "work_item_invalid";
  return null;
}

function resolveInitialHost(snapshot: AssignmentFormSnapshot): AssignmentFormHostOption | null {
  const selectedServerId = snapshot.selectedServerId ?? null;
  if (selectedServerId) {
    return (
      snapshot.hosts.find((host) => host.serverId === selectedServerId) ?? {
        serverId: selectedServerId,
        label: selectedServerId,
      }
    );
  }
  return snapshot.hosts.length === 1 ? snapshot.hosts[0]! : null;
}

export function openAssignmentForm(snapshot: AssignmentFormSnapshot): AssignmentFormModel {
  if (snapshot.mode === "edit" && !snapshot.assignment) {
    throw new Error("Edit Assignment forms require an Assignment snapshot");
  }
  const assignment = snapshot.assignment ?? null;
  const initialHost = resolveInitialHost(snapshot);
  let closed = false;
  const listeners = new Set<() => void>();
  let state: AssignmentFormState = {
    mode: snapshot.mode,
    hosts: [...snapshot.hosts],
    selectedServerId: initialHost?.serverId ?? null,
    selectedHostDisplay: initialHost?.label ?? null,
    assignmentId: assignment?.id ?? null,
    expectedRevision: assignment?.revision ?? null,
    title: assignment?.title ?? "",
    objective: assignment?.objective ?? "",
    workItem: assignment?.workItem ?? null,
    validationIssue: null,
    canSubmit: false,
    submission: null,
    submitError: null,
    revisionRecovered: false,
  };

  const publish = (next: AssignmentFormState): void => {
    if (closed) return;
    const issue = validationIssue(next);
    const assignmentInput = {
      title: next.title.trim(),
      objective: next.objective.trim(),
      workItem: next.workItem,
    } satisfies AssignmentInputDto;
    let submission: AssignmentFormSubmission | null = null;
    if (issue === null && next.selectedServerId) {
      if (next.mode === "create") {
        submission = {
          kind: "create",
          serverId: next.selectedServerId,
          assignment: assignmentInput,
        };
      } else if (next.assignmentId && next.expectedRevision) {
        submission = {
          kind: "update",
          serverId: next.selectedServerId,
          assignmentId: next.assignmentId,
          expectedRevision: next.expectedRevision,
          patch: assignmentInput,
        };
      }
    }
    state = {
      ...next,
      validationIssue: issue,
      canSubmit: submission !== null,
      submission,
    };
    listeners.forEach((listener) => listener());
  };

  publish(state);

  return {
    getState: () => state,
    subscribe: (listener) => {
      if (closed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {
      closed = true;
      listeners.clear();
    },
    applyHosts: (hosts) => {
      const nextHosts = [...hosts];
      const selectedStillPresent = nextHosts.some(
        (host) => host.serverId === state.selectedServerId,
      );
      publish({
        ...state,
        hosts: nextHosts,
        selectedServerId:
          state.mode === "edit" || selectedStillPresent ? state.selectedServerId : null,
        selectedHostDisplay:
          state.mode === "edit" || selectedStillPresent ? state.selectedHostDisplay : null,
      });
    },
    applyRemoteRevision: (revision) => {
      if (state.mode !== "edit" || revision <= 0 || revision === state.expectedRevision) return;
      publish({ ...state, expectedRevision: revision, revisionRecovered: true, submitError: null });
    },
    setHost: (serverId, display) => {
      if (state.mode === "edit") return;
      publish({
        ...state,
        selectedServerId: serverId,
        selectedHostDisplay: display,
        workItem: state.selectedServerId === serverId ? state.workItem : null,
        submitError: null,
        revisionRecovered: false,
      });
    },
    setTitle: (title) => publish({ ...state, title, submitError: null, revisionRecovered: false }),
    setObjective: (objective) =>
      publish({ ...state, objective, submitError: null, revisionRecovered: false }),
    setWorkItem: (workItem) =>
      publish({ ...state, workItem, submitError: null, revisionRecovered: false }),
    setSubmitError: (submitError) => publish({ ...state, submitError }),
  };
}
