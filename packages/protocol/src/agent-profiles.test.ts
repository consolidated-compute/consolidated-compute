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
});
