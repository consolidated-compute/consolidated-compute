import type { TeamRunSupervisionHumanRequestDto } from "@getpaseo/protocol/team/types";
import { TEAM_SUPERVISION_HUMAN_REQUEST_NOTE_MAX_CHARS } from "@getpaseo/protocol/team/types";
import type { TeamRunFormDisplay } from "./run-form-model";

export type TeamSupervisionResponseValidationIssue =
  | "action_required"
  | "action_unavailable"
  | "note_required"
  | "note_too_long"
  | "request_settled";

export interface TeamSupervisionResponseSubmission {
  serverId: string;
  runId: string;
  humanRequestId: string;
  expectedRevision: number;
  actionId: string;
  note: string | null;
  idempotencyKey: string;
}

export interface TeamSupervisionResponseFormState {
  request: TeamRunSupervisionHumanRequestDto;
  selectedActionId: string | null;
  selectedActionDisplay: TeamRunFormDisplay | null;
  note: string;
  validationIssue: TeamSupervisionResponseValidationIssue | null;
  canSubmit: boolean;
  submission: TeamSupervisionResponseSubmission | null;
  submitError: string | null;
}

export interface TeamSupervisionResponseFormModel {
  getState: () => TeamSupervisionResponseFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  setAction: (actionId: string, display: TeamRunFormDisplay) => void;
  setNote: (note: string) => void;
  setSubmitError: (error: string | null) => void;
}

export interface OpenTeamSupervisionResponseFormInput {
  serverId: string;
  runId: string;
  request: TeamRunSupervisionHumanRequestDto;
}

interface OpenTeamSupervisionResponseFormOptions {
  generateIdempotencyKey?: () => string;
}

function generateIdempotencyKey(): string {
  return `team-supervision-response-${crypto.randomUUID()}`;
}

function validationIssue(
  state: TeamSupervisionResponseFormState,
): TeamSupervisionResponseValidationIssue | null {
  if (state.request.resolution || state.request.retirement) return "request_settled";
  if (!state.selectedActionId) return "action_required";
  const action = state.request.actions.find((candidate) => candidate.id === state.selectedActionId);
  if (!action) return "action_unavailable";
  if (state.note.length > TEAM_SUPERVISION_HUMAN_REQUEST_NOTE_MAX_CHARS) return "note_too_long";
  if (action.requiresNote && !state.note.trim()) return "note_required";
  return null;
}

export function openTeamSupervisionResponseForm(
  input: OpenTeamSupervisionResponseFormInput,
  options: OpenTeamSupervisionResponseFormOptions = {},
): TeamSupervisionResponseFormModel {
  const idempotencyKey = (options.generateIdempotencyKey ?? generateIdempotencyKey)();
  let closed = false;
  const listeners = new Set<() => void>();
  let state: TeamSupervisionResponseFormState = {
    request: input.request,
    selectedActionId: null,
    selectedActionDisplay: null,
    note: "",
    validationIssue: null,
    canSubmit: false,
    submission: null,
    submitError: null,
  };

  const publish = (next: TeamSupervisionResponseFormState): void => {
    if (closed) return;
    const issue = validationIssue(next);
    const note = next.note.trim();
    state = {
      ...next,
      validationIssue: issue,
      canSubmit: issue === null,
      submission:
        issue === null && next.selectedActionId
          ? {
              serverId: input.serverId,
              runId: input.runId,
              humanRequestId: input.request.id,
              expectedRevision: input.request.revision,
              actionId: next.selectedActionId,
              note: note || null,
              idempotencyKey,
            }
          : null,
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
    setAction: (selectedActionId, selectedActionDisplay) => {
      if (!state.request.actions.some((action) => action.id === selectedActionId)) return;
      publish({ ...state, selectedActionId, selectedActionDisplay, submitError: null });
    },
    setNote: (note) => publish({ ...state, note, submitError: null }),
    setSubmitError: (submitError) => publish({ ...state, submitError }),
  };
}
