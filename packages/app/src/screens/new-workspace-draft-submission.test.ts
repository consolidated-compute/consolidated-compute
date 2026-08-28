import { describe, expect, test } from "vitest";

import { resolveWorkspaceDraftSubmissionConfig } from "./new-workspace-draft-submission";

describe("new Workspace draft submission", () => {
  test("carries profile provider options into the pending auto-submit config", () => {
    expect(
      resolveWorkspaceDraftSubmissionConfig({
        draftId: "draft_profile",
        workspaceDirectory: "/repo/worktree",
        provider: "codex",
        composerState: {
          selectedMode: "workspace-write",
          effectiveModelId: "gpt-5.6",
          effectiveThinkingOptionId: "high",
          featureValues: { fast_mode: true },
          selectedProviderOptions: {
            sandbox_mode: "workspace-write",
            approval_policy: "on-request",
          },
        },
      }),
    ).toEqual({
      cwd: "/repo/worktree",
      provider: "codex",
      modeId: "workspace-write",
      model: "gpt-5.6",
      thinkingOptionId: "high",
      featureValues: { fast_mode: true },
      providerOptions: {
        sandbox_mode: "workspace-write",
        approval_policy: "on-request",
      },
      target: { kind: "draft", draftId: "draft_profile" },
    });
  });
});
