import { describe, expect, test } from "vitest";

import { materializeAgentProfile } from "./agent-profiles.js";
import {
  AgentProfilePatchSchema,
  AgentProfileSchema,
  MutableDaemonConfigPatchSchema,
} from "./messages.js";

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
        providerOptions: {
          approvalPolicy: "on-request",
          sandbox: { networkAccess: false, writableRoots: ["/repo"] },
        },
      }),
    ).toEqual({
      provider: "codex",
      modelId: "gpt-5.6",
      modeId: "plan",
      thinkingOptionId: "high",
      featureValues: { web_search: true },
      providerOptions: {
        approvalPolicy: "on-request",
        sandbox: { networkAccess: false, writableRoots: ["/repo"] },
      },
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
      providerOptions: {},
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
      providerOptions: {},
    });
  });
});

describe("Agent Profile provider options", () => {
  const legacyProfile = {
    id: "reviewer",
    name: "Reviewer",
    provider: "codex",
  };

  test("accepts old read profiles without provider options", () => {
    expect(AgentProfileSchema.parse(legacyProfile)).toEqual(legacyProfile);
  });

  test("accepts JSON-safe provider options on read profiles", () => {
    const providerOptions = {
      approvalPolicy: "on-request",
      retries: 2,
      enabled: true,
      nullable: null,
      writableRoots: ["/repo", "/tmp/output"],
      sandbox: { networkAccess: false },
    };

    expect(AgentProfileSchema.parse({ ...legacyProfile, providerOptions })).toEqual({
      ...legacyProfile,
      providerOptions,
    });
  });

  test("rejects non-JSON and null provider option containers on read profiles", () => {
    expect(
      AgentProfileSchema.safeParse({
        ...legacyProfile,
        providerOptions: { unsafe: undefined },
      }).success,
    ).toBe(false);
    expect(AgentProfileSchema.safeParse({ ...legacyProfile, providerOptions: null }).success).toBe(
      false,
    );
  });

  test("reserves null for explicit clears in config patches", () => {
    expect(AgentProfilePatchSchema.parse(legacyProfile)).toEqual(legacyProfile);
    expect(AgentProfilePatchSchema.parse({ ...legacyProfile, providerOptions: null })).toEqual({
      ...legacyProfile,
      providerOptions: null,
    });
    expect(
      MutableDaemonConfigPatchSchema.parse({
        agentProfiles: [{ ...legacyProfile, providerOptions: null }],
      }),
    ).toEqual({ agentProfiles: [{ ...legacyProfile, providerOptions: null }] });
  });
});
