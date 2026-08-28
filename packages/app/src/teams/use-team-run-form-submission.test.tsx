/**
 * @vitest-environment jsdom
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamRunFormModel } from "./run-form-model";
import { useTeamRunFormSubmission } from "./use-team-run-form-submission";

const { startMutation } = vi.hoisted(() => ({
  startMutation: {
    isPending: false,
    mutateAsync: vi.fn(),
  },
}));

vi.mock("./use-team-run-mutations", () => ({
  useTeamRunMutations: () => ({ start: startMutation }),
}));

describe("useTeamRunFormSubmission", () => {
  const submission = {
    serverId: "host-a",
    teamId: "team-1",
    expectedRevision: 1,
    idempotencyKey: "admission-1",
    objective: "Ship it",
    workspaceId: "workspace-1",
    securityPreviewFingerprint: "preview-1",
  };
  const setSubmitError = vi.fn();
  const model = {
    getState: vi.fn(() => ({ submission })),
    setSubmitError,
  } as unknown as TeamRunFormModel;

  beforeEach(() => {
    startMutation.isPending = false;
    startMutation.mutateAsync.mockReset();
    setSubmitError.mockReset();
  });

  afterEach(cleanup);

  it("refreshes the security preview after admission rejects its fingerprint", async () => {
    startMutation.mutateAsync.mockRejectedValue(
      Object.assign(new Error("Security preview changed"), {
        code: "team_security_preview_stale",
      }),
    );
    const refreshSecurityPreview = vi.fn();
    const { result } = renderHook(() =>
      useTeamRunFormSubmission(model, vi.fn(), refreshSecurityPreview),
    );

    act(() => result.current.startPress());

    await waitFor(() => expect(refreshSecurityPreview).toHaveBeenCalledOnce());
    expect(setSubmitError).toHaveBeenCalledOnce();
    expect(setSubmitError).toHaveBeenCalledWith(null);
  });

  it("keeps unrelated admission failures in the submission error state", async () => {
    startMutation.mutateAsync.mockRejectedValue(new Error("Host disconnected"));
    const refreshSecurityPreview = vi.fn();
    const { result } = renderHook(() =>
      useTeamRunFormSubmission(model, vi.fn(), refreshSecurityPreview),
    );

    act(() => result.current.startPress());

    await waitFor(() => expect(setSubmitError).toHaveBeenCalledTimes(2));
    expect(setSubmitError).toHaveBeenLastCalledWith("Host disconnected");
    expect(refreshSecurityPreview).not.toHaveBeenCalled();
  });
});
