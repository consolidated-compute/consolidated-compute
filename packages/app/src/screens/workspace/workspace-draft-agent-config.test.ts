import { describe, expect, it } from "vitest";
import {
  buildWorkspaceDraftAgentConfig,
  resolveWorkspaceDraftProviderOptions,
} from "./workspace-draft-agent-config";

describe("workspace-draft-agent-config", () => {
  it("builds chat-only config for workspace draft agents", () => {
    expect(
      buildWorkspaceDraftAgentConfig({
        provider: "codex",
        cwd: "/tmp/project",
        modeId: "auto",
        model: "gpt-5.4",
        thinkingOptionId: "high",
        providerOptions: {
          sandbox: { mode: "workspace-write" },
          approvalPolicy: "on-request",
        },
      }),
    ).toEqual({
      provider: "codex",
      cwd: "/tmp/project",
      modeId: "auto",
      model: "gpt-5.4",
      thinkingOptionId: "high",
      providerOptions: {
        sandbox: { mode: "workspace-write" },
        approvalPolicy: "on-request",
      },
    });
  });
});

describe("workspace draft provider options", () => {
  it("uses the pending auto-submit options instead of the live form state", () => {
    expect(
      resolveWorkspaceDraftProviderOptions({
        autoSubmitConfig: { providerOptions: { sandbox_mode: "read-only" } },
        selectedProviderOptions: { sandbox_mode: "workspace-write" },
      }),
    ).toEqual({ sandbox_mode: "read-only" });
  });
});
