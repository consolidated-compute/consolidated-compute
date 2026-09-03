import { describe, expect, it } from "vitest";
import { resolveAssignmentTeamCatalogStatus } from "./schedule-assignment-team-catalog";

describe("Assignment Team schedule catalog adapter", () => {
  it("does not publish ready until every host-local source is ready", () => {
    expect(
      resolveAssignmentTeamCatalogStatus({
        supported: true,
        assignmentsStatus: "ready",
        teamsStatus: "ready",
        workspacesHydrated: false,
      }),
    ).toBe("loading");
    expect(
      resolveAssignmentTeamCatalogStatus({
        supported: true,
        assignmentsStatus: "ready",
        teamsStatus: "ready",
        workspacesHydrated: true,
      }),
    ).toBe("ready");
  });

  it("keeps unsupported and failed hosts distinct from loading", () => {
    expect(
      resolveAssignmentTeamCatalogStatus({
        supported: false,
        assignmentsStatus: "ready",
        teamsStatus: "ready",
        workspacesHydrated: true,
      }),
    ).toBe("unsupported");
    expect(
      resolveAssignmentTeamCatalogStatus({
        supported: true,
        assignmentsStatus: "error",
        teamsStatus: "ready",
        workspacesHydrated: true,
      }),
    ).toBe("error");
  });
});
