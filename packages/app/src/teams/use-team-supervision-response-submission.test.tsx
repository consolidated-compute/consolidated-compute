/**
 * @vitest-environment jsdom
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamSupervisionResponseFormModel } from "./supervision-response-form-model";
import { useTeamSupervisionResponseSubmission } from "./use-team-supervision-response-submission";

const { respondMutation } = vi.hoisted(() => ({
  respondMutation: {
    isPending: false,
    mutateAsync: vi.fn(),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("./use-team-run-supervision-mutations", () => ({
  useTeamRunSupervisionMutations: () => ({ respond: respondMutation }),
}));

describe("useTeamSupervisionResponseSubmission", () => {
  const submission = {
    serverId: "host-a",
    runId: "run-a",
    humanRequestId: "human-a",
    expectedRevision: 3,
    actionId: "continue",
    note: "Proceed",
    idempotencyKey: "response-a",
  };
  const setSubmitError = vi.fn();
  const model = {
    getState: vi.fn(() => ({ submission })),
    setSubmitError,
  } as unknown as TeamSupervisionResponseFormModel;

  beforeEach(() => {
    respondMutation.isPending = false;
    respondMutation.mutateAsync.mockReset();
    setSubmitError.mockReset();
  });

  afterEach(cleanup);

  it("refreshes a stale durable request without dismissing preserved input", async () => {
    respondMutation.mutateAsync.mockRejectedValue(
      Object.assign(new Error("Request changed"), {
        code: "team_run_supervision_human_request_revision_conflict",
      }),
    );
    const onResponded = vi.fn();
    const onConflict = vi.fn();
    const { result } = renderHook(() =>
      useTeamSupervisionResponseSubmission(model, onResponded, onConflict),
    );

    act(() => result.current.submitPress());

    await waitFor(() => expect(onConflict).toHaveBeenCalledOnce());
    expect(onResponded).not.toHaveBeenCalled();
    expect(setSubmitError).toHaveBeenLastCalledWith("teams.runs.supervision.response.conflict");
  });

  it("ignores a late success after the response sheet unmounts", async () => {
    let resolveResponse: (() => void) | undefined;
    respondMutation.mutateAsync.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveResponse = resolve;
      }),
    );
    const onResponded = vi.fn();
    const { result, unmount } = renderHook(() =>
      useTeamSupervisionResponseSubmission(model, onResponded, vi.fn()),
    );

    act(() => result.current.submitPress());
    unmount();
    await act(async () => resolveResponse?.());

    expect(onResponded).not.toHaveBeenCalled();
  });
});
