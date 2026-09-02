import { describe, expect, it } from "vitest";
import { TEAM_SUPERVISION_HUMAN_REQUEST_NOTE_MAX_CHARS } from "@getpaseo/protocol/team/types";
import {
  openTeamSupervisionResponseForm,
  type OpenTeamSupervisionResponseFormInput,
} from "./supervision-response-form-model";

function input(): OpenTeamSupervisionResponseFormInput {
  return {
    serverId: "host-a",
    runId: "run-a",
    request: {
      id: "human-review",
      revision: 3,
      kind: "supervisor_escalation",
      title: "Review the proposed exception",
      detail: "Choose whether the Team should continue.",
      actions: [
        { id: "continue", label: "Continue", requiresNote: true },
        { id: "cancel", label: "Cancel", requiresNote: false },
      ],
      roleIds: ["supervisor"],
      agentIds: ["11111111-1111-4111-8111-111111111111"],
      stepIds: ["supervisor-turn-1"],
      artifactIds: [],
      createdAt: "2026-09-01T12:00:00.000Z",
    },
  };
}

describe("Team supervision response form model", () => {
  it("freezes the request revision and retry identity into a bounded response", () => {
    const model = openTeamSupervisionResponseForm(input(), {
      generateIdempotencyKey: () => "response-key",
    });
    expect(model.getState()).toMatchObject({
      validationIssue: "action_required",
      canSubmit: false,
    });

    model.setAction("continue", { label: "Continue" });
    expect(model.getState().validationIssue).toBe("note_required");
    model.setNote("  Proceed with the bounded plan.  ");

    expect(model.getState()).toMatchObject({
      canSubmit: true,
      submission: {
        serverId: "host-a",
        runId: "run-a",
        humanRequestId: "human-review",
        expectedRevision: 3,
        actionId: "continue",
        note: "Proceed with the bounded plan.",
        idempotencyKey: "response-key",
      },
    });
  });

  it("allows a note-free action and rejects oversized notes or settled requests", () => {
    const model = openTeamSupervisionResponseForm(input());
    model.setAction("cancel", { label: "Cancel" });
    expect(model.getState().submission).toMatchObject({ actionId: "cancel", note: null });

    model.setNote("x".repeat(TEAM_SUPERVISION_HUMAN_REQUEST_NOTE_MAX_CHARS + 1));
    expect(model.getState()).toMatchObject({
      validationIssue: "note_too_long",
      canSubmit: false,
      submission: null,
    });

    const settledInput = input();
    settledInput.request.resolution = {
      actionId: "cancel",
      note: null,
      resolvedAt: "2026-09-01T12:01:00.000Z",
    };
    const settled = openTeamSupervisionResponseForm(settledInput);
    settled.setAction("cancel", { label: "Cancel" });
    expect(settled.getState().validationIssue).toBe("request_settled");
  });

  it("retains the selected display independently of the action catalog", () => {
    const model = openTeamSupervisionResponseForm(input());
    model.setAction("continue", { label: "Continue now", description: "Captured display" });
    model.setSubmitError("The request changed on the host");

    expect(model.getState()).toMatchObject({
      selectedActionId: "continue",
      selectedActionDisplay: { label: "Continue now", description: "Captured display" },
      submitError: "The request changed on the host",
    });
  });
});
