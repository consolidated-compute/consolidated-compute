import { describe, expect, test } from "vitest";

import { materializeAgentProfile } from "./agent-profiles.js";

describe("materializeAgentProfile", () => {
  test("normalizes the complete reusable launch bundle", () => {
    expect(
      materializeAgentProfile({
        id: "reviewer",
        name: "Reviewer",
        provider: " codex ",
        model: " gpt-5.6 ",
        modeId: " plan ",
        thinkingOptionId: " high ",
        featureValues: { web_search: true },
      }),
    ).toEqual({
      provider: "codex",
      modelId: "gpt-5.6",
      modeId: "plan",
      thinkingOptionId: "high",
      featureValues: { web_search: true },
    });
  });

  test("normalizes omitted and blank optional settings", () => {
    expect(
      materializeAgentProfile({
        id: "reviewer",
        name: "Reviewer",
        provider: "codex",
        model: "   ",
      }),
    ).toEqual({
      provider: "codex",
      modelId: "",
      modeId: "",
      thinkingOptionId: "",
      featureValues: {},
    });
  });

  test("normalizes legacy OpenCode full access into its canonical launch settings", () => {
    expect(
      materializeAgentProfile({
        id: "legacy-opencode",
        name: "Legacy OpenCode",
        provider: "opencode",
        modeId: "full-access",
        featureValues: { auto_accept: false, custom: "kept" },
      }),
    ).toEqual({
      provider: "opencode",
      modelId: "",
      modeId: "build",
      thinkingOptionId: "",
      featureValues: { auto_accept: true, custom: "kept" },
    });
  });
});
