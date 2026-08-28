import { describe, expect, it } from "vitest";
import type { AssignmentArtifactDto } from "@getpaseo/protocol/assignment/types";
import {
  artifactsForRun,
  assignmentArtifactIssues,
  assignmentArtifactListQueryKey,
  assignmentArtifactsShouldPoll,
  flattenAssignmentArtifactPages,
  loadNextTeamRunArtifactPage,
} from "./artifact-data";

const artifact = (id: string, teamRunId: string): AssignmentArtifactDto => ({
  id,
  assignmentId: "asgn_0123456789abcdef",
  assignmentRevision: 2,
  kind: "plan",
  title: "Plan",
  mediaType: "text/markdown",
  content: "Plan content",
  includedBytes: 12,
  originalBytes: 12,
  truncated: false,
  producer: {
    kind: "team_run_step",
    teamRunId,
    stepId: "plan",
    roleId: "planner",
    agentId: "00000000-0000-4000-8000-000000000001",
    turnId: null,
  },
  createdAt: "2026-08-27T12:00:00.000Z",
});

describe("Assignment Artifact data", () => {
  it("qualifies run-scoped Artifact caches by host, Assignment, and Team Run", () => {
    expect(assignmentArtifactListQueryKey("host-1", "assignment-1", "run-1")).toEqual([
      "assignmentArtifacts",
      "host-1",
      "assignment-1",
      "run",
      "run-1",
      "list",
    ]);
  });

  it("polls only while the owning Assignment or Team Run can produce Artifacts", () => {
    expect(assignmentArtifactsShouldPoll({})).toBe(true);
    expect(assignmentArtifactsShouldPoll({ assignmentStatus: "open" })).toBe(true);
    expect(assignmentArtifactsShouldPoll({ assignmentStatus: "completed" })).toBe(false);
    expect(assignmentArtifactsShouldPoll({ assignmentStatus: "canceled" })).toBe(false);
    expect(assignmentArtifactsShouldPoll({ teamRunId: "run-1", runIsActive: true })).toBe(true);
    expect(assignmentArtifactsShouldPoll({ teamRunId: "run-1", runIsActive: false })).toBe(false);
  });

  it("deduplicates paginated Artifacts and filters exact run provenance", () => {
    const pages = [
      { artifacts: [artifact("a", "run-1")], nextCursor: "next", issues: [] },
      {
        artifacts: [artifact("a", "run-1"), artifact("b", "run-2")],
        nextCursor: null,
        issues: [],
      },
    ];
    const flattened = flattenAssignmentArtifactPages(pages);
    expect(flattened.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(artifactsForRun(flattened, "run-1").map((entry) => entry.id)).toEqual(["a"]);
  });

  it("deduplicates collection diagnostics across pages", () => {
    const issue = {
      collection: "artifacts" as const,
      fileName: "bad.json",
      kind: "invalid_record" as const,
      message: "bad",
    };
    expect(
      assignmentArtifactIssues([
        { artifacts: [], nextCursor: "next", issues: [issue] },
        { artifacts: [], nextCursor: null, issues: [issue] },
      ]),
    ).toEqual([issue]);
  });

  it("skips unrelated Artifact pages before returning the target run", async () => {
    const issue = {
      collection: "artifacts" as const,
      fileName: "bad.json",
      kind: "invalid_record" as const,
      message: "bad",
    };
    const cursors: Array<string | null> = [];

    const page = await loadNextTeamRunArtifactPage({
      teamRunId: "run-1",
      cursor: null,
      loadPage: async (cursor) => {
        cursors.push(cursor);
        return cursor === null
          ? { artifacts: [artifact("other", "run-2")], nextCursor: "page-2", issues: [issue] }
          : { artifacts: [artifact("target", "run-1")], nextCursor: "page-3", issues: [] };
      },
    });

    expect(cursors).toEqual([null, "page-2"]);
    expect(page).toEqual({
      artifacts: [artifact("target", "run-1")],
      nextCursor: "page-3",
      issues: [issue],
    });
  });

  it("exhausts unrelated Artifact pages before returning an empty result", async () => {
    const cursors: Array<string | null> = [];

    const page = await loadNextTeamRunArtifactPage({
      teamRunId: "run-1",
      cursor: null,
      loadPage: async (cursor) => {
        cursors.push(cursor);
        return cursor === null
          ? { artifacts: [artifact("other-1", "run-2")], nextCursor: "page-2", issues: [] }
          : { artifacts: [artifact("other-2", "run-3")], nextCursor: null, issues: [] };
      },
    });

    expect(cursors).toEqual([null, "page-2"]);
    expect(page).toEqual({ artifacts: [], nextCursor: null, issues: [] });
  });
});
