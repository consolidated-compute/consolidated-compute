import { describe, expect, it } from "vitest";
import {
  resolveVisualRelationshipPresentation,
  resolveVisualStatePresentation,
  shouldRunVisualWorkingClock,
} from "./presentation";

describe("Visual presentation", () => {
  it("gives every canonical state a distinct non-color semantic", () => {
    const presentations = Object.fromEntries(
      (["needs_input", "failed", "running", "attention", "done"] as const).map((state) => [
        state,
        resolveVisualStatePresentation({ state, isLastKnown: false }),
      ]),
    );

    expect(presentations).toEqual({
      needs_input: { icon: "needs_input", emphasis: "urgent", canAnimate: false, isMuted: false },
      failed: { icon: "failed", emphasis: "critical", canAnimate: false, isMuted: false },
      running: { icon: "running", emphasis: "active", canAnimate: true, isMuted: false },
      attention: { icon: "attention", emphasis: "notice", canAnimate: false, isMuted: false },
      done: { icon: "done", emphasis: "quiet", canAnimate: false, isMuted: false },
    });
    expect(new Set(Object.values(presentations).map(({ icon }) => icon)).size).toBe(5);
  });

  it("freezes and mutes last-known running state", () => {
    expect(resolveVisualStatePresentation({ state: "running", isLastKnown: true })).toEqual({
      icon: "running",
      emphasis: "quiet",
      canAnimate: false,
      isMuted: true,
    });
  });

  it("runs the shared clock only for a focused live working scene without reduced motion", () => {
    const liveRunning = { state: "running", isLastKnown: false } as const;
    const staleRunning = { state: "running", isLastKnown: true } as const;

    expect(
      shouldRunVisualWorkingClock({ nodes: [liveRunning], isFocused: true, reduceMotion: false }),
    ).toBe(true);
    expect(
      shouldRunVisualWorkingClock({ nodes: [liveRunning], isFocused: false, reduceMotion: false }),
    ).toBe(false);
    expect(
      shouldRunVisualWorkingClock({ nodes: [liveRunning], isFocused: true, reduceMotion: true }),
    ).toBe(false);
    expect(
      shouldRunVisualWorkingClock({ nodes: [staleRunning], isFocused: true, reduceMotion: false }),
    ).toBe(false);
  });

  it("keeps every relationship class explicit", () => {
    expect(
      Object.fromEntries(
        (["nested", "provider", "cross_workspace", "missing", "cycle"] as const).map((kind) => [
          kind,
          resolveVisualRelationshipPresentation(kind),
        ]),
      ),
    ).toEqual({
      nested: { icon: "nested", labelKey: "visual.relationship.nested" },
      provider: { icon: "provider", labelKey: "visual.relationship.provider" },
      cross_workspace: {
        icon: "cross_workspace",
        labelKey: "operations.relationship.crossWorkspace",
      },
      missing: { icon: "missing", labelKey: "operations.relationship.missing" },
      cycle: { icon: "cycle", labelKey: "operations.relationship.cycle" },
    });
  });
});
