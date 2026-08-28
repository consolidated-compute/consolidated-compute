import { describe, expect, it } from "vitest";
import {
  assertAgentProfilePatchesSupported,
  supportsAgentProfileProviderOptions,
  supportsAgentProfiles,
} from "./capabilities";

describe("agent profile capabilities", () => {
  it("keeps established profile support independent of provider-option patches", () => {
    expect(supportsAgentProfiles(undefined)).toBe(false);
    expect(supportsAgentProfiles({ agentProfiles: true })).toBe(false);
    expect(supportsAgentProfiles({ agentConfigApply: true })).toBe(false);
    expect(supportsAgentProfiles({ agentProfiles: true, agentConfigApply: true })).toBe(true);
  });

  it("gates only the new provider-option patch semantics", () => {
    const legacyFeatures = { agentProfiles: true, agentConfigApply: true };
    expect(supportsAgentProfileProviderOptions(legacyFeatures)).toBe(false);
    expect(() =>
      assertAgentProfilePatchesSupported(legacyFeatures, [
        { id: "reviewer", name: "Reviewer", provider: "codex" },
      ]),
    ).not.toThrow();
    expect(() =>
      assertAgentProfilePatchesSupported(legacyFeatures, [
        {
          id: "reviewer",
          name: "Reviewer",
          provider: "claude",
          providerOptions: null,
        },
      ]),
    ).toThrow("requires updating this Paseo host");

    const currentFeatures = { ...legacyFeatures, agentProfileProviderOptions: true };
    expect(supportsAgentProfileProviderOptions(currentFeatures)).toBe(true);
    expect(() =>
      assertAgentProfilePatchesSupported(currentFeatures, [
        {
          id: "reviewer",
          name: "Reviewer",
          provider: "claude",
          providerOptions: null,
        },
      ]),
    ).not.toThrow();
  });
});
