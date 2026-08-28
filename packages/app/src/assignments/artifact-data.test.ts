import { describe, expect, it } from "vitest";
import type { AssignmentArtifactDto } from "@getpaseo/protocol/assignment/types";
import {
  artifactsForRun,
  assignmentArtifactIssues,
  flattenAssignmentArtifactPages,
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
});
