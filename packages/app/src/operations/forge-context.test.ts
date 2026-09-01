import { describe, expect, it } from "vitest";
import type { WorkspaceSummary } from "@/utils/projects";
import { formatOperationsChangeRequestLabel, selectOperationsForgeContext } from "./forge-context";

function workspace(
  input: Partial<Pick<WorkspaceSummary, "forge" | "forgeRuntime">> = {},
): Pick<WorkspaceSummary, "forge" | "forgeRuntime"> {
  return input;
}

function pullRequest(
  overrides: Partial<
    NonNullable<NonNullable<WorkspaceSummary["forgeRuntime"]>["pullRequest"]>
  > = {},
) {
  return {
    number: 42,
    url: "https://github.com/acme/repo/pull/42",
    title: "Surface cached forge context",
    state: "open",
    baseRefName: "main",
    headRefName: "feature/operations",
    isMerged: false,
    ...overrides,
  };
}

describe("selectOperationsForgeContext", () => {
  it("distinguishes missing forge facts from a snapshot with no change request", () => {
    expect(selectOperationsForgeContext({ workspace: workspace(), isLastKnown: false })).toEqual({
      kind: "unknown",
    });
    expect(
      selectOperationsForgeContext({
        workspace: workspace({
          forge: "github",
          forgeRuntime: { featuresEnabled: true, error: null },
        }),
        isLastKnown: false,
      }),
    ).toEqual({ kind: "unknown" });
    expect(
      selectOperationsForgeContext({
        workspace: workspace({
          forge: "github",
          forgeRuntime: { featuresEnabled: true, pullRequest: null, error: null },
        }),
        isLastKnown: false,
      }),
    ).toEqual({ kind: "none" });
  });

  it.each([
    ["open", false, "open"],
    ["closed", false, "closed"],
    ["closed", true, "merged"],
  ] as const)("normalizes %s change requests", (state, isMerged, expected) => {
    const context = selectOperationsForgeContext({
      workspace: workspace({
        forge: "github",
        forgeRuntime: {
          pullRequest: pullRequest({ state, isMerged }),
          error: null,
        },
      }),
      isLastKnown: false,
    });

    expect(context).toMatchObject({
      kind: "change_request",
      changeRequest: { number: 42, state: expected },
    });
  });

  it("preserves checks that require action", () => {
    const context = selectOperationsForgeContext({
      workspace: workspace({
        forge: "github",
        forgeRuntime: {
          pullRequest: pullRequest({
            checks: [
              {
                name: "Deploy",
                status: "pending",
                traits: ["manual", "action_required"],
                url: null,
              },
            ],
          }),
          error: null,
        },
      }),
      isLastKnown: false,
    });

    expect(context).toMatchObject({
      kind: "change_request",
      changeRequest: { checksStatus: "actionRequired" },
    });
  });

  it.each([
    ["pending", "pending"],
    ["failure", "failure"],
    ["success", "success"],
  ] as const)("summarizes %s checks with the shared checks selector", (status, expected) => {
    const context = selectOperationsForgeContext({
      workspace: workspace({
        forge: "github",
        forgeRuntime: {
          pullRequest: pullRequest({
            checks: [{ name: "CI", status, url: null }],
            checksStatus: status,
            reviewDecision: "approved",
          }),
          error: null,
        },
      }),
      isLastKnown: false,
    });

    expect(context).toMatchObject({
      kind: "change_request",
      changeRequest: { checksStatus: expected, reviewDecision: "approved" },
    });
  });

  it("marks all mutable change-request facts unknown for stale host data", () => {
    const context = selectOperationsForgeContext({
      workspace: workspace({
        forge: "github",
        forgeRuntime: {
          pullRequest: pullRequest({ checksStatus: "success", reviewDecision: "approved" }),
          error: null,
        },
      }),
      isLastKnown: true,
    });

    expect(context).toEqual({
      kind: "change_request",
      changeRequest: {
        forge: "github",
        number: 42,
        url: "https://github.com/acme/repo/pull/42",
        state: "unknown",
        checksStatus: "unknown",
        reviewDecision: "unknown",
      },
    });
  });

  it("does not treat a stale no-change-request snapshot as current absence", () => {
    expect(
      selectOperationsForgeContext({
        workspace: workspace({
          forge: "github",
          forgeRuntime: { pullRequest: null, error: null },
        }),
        isLastKnown: true,
      }),
    ).toEqual({ kind: "unknown" });
  });

  it("treats an errored forge snapshot as unknown", () => {
    expect(
      selectOperationsForgeContext({
        workspace: workspace({
          forge: "github",
          forgeRuntime: {
            pullRequest: null,
            error: { message: "forge unavailable" },
          },
        }),
        isLastKnown: false,
      }),
    ).toEqual({ kind: "unknown" });
  });
});

describe("formatOperationsChangeRequestLabel", () => {
  it.each([
    ["github", "PR #8"],
    ["gitlab", "MR !8"],
    ["gitea", "PR #8"],
    ["forgejo", "PR #8"],
  ])("uses %s change-request vocabulary", (forge, expected) => {
    expect(formatOperationsChangeRequestLabel({ forge, number: 8 })).toBe(expected);
  });
});
