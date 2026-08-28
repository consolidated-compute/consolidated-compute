import { describe, expect, test } from "vitest";

import { buildCreateAgentOptions } from "./workspace-setup-dialog-model";

describe("Workspace setup dialog model", () => {
  test("carries profile provider options into agent creation", () => {
    expect(
      buildCreateAgentOptions({
        composerState: {
          modeOptions: [{ id: "workspace-write" }],
          selectedMode: "workspace-write",
          effectiveModelId: "gpt-5.6",
          effectiveThinkingOptionId: "high",
          selectedProviderOptions: {
            sandbox_mode: "workspace-write",
            approval_policy: "on-request",
          },
        },
        text: "Implement the change",
        attachments: [],
        encodedImages: null,
        workspaceDirectory: "/repo/worktree",
        workspaceId: "workspace_1",
        provider: "codex",
      }),
    ).toMatchObject({
      provider: "codex",
      cwd: "/repo/worktree",
      workspaceId: "workspace_1",
      providerOptions: {
        sandbox_mode: "workspace-write",
        approval_policy: "on-request",
      },
    });
  });
});
