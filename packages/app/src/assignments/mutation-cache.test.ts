import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { AssignmentDto } from "@getpaseo/protocol/assignment/types";
import { assignmentListQueryKey, assignmentQueryKey, type AssignmentListData } from "./data";
import { applyAssignmentMutation } from "./mutation-cache";

const assignment: AssignmentDto = {
  id: "asgn_0123456789abcdef",
  revision: 2,
  title: "Updated Assignment",
  objective: "Preserve the mutation result",
  workItem: null,
  state: { status: "open" },
  createdAt: "2026-08-27T10:00:00.000Z",
  updatedAt: "2026-08-27T12:00:00.000Z",
};

describe("Assignment mutation cache coordination", () => {
  it("updates only the owning host list and host-qualified detail", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const owningList = assignmentListQueryKey("host-a");
    const otherList = assignmentListQueryKey("host-b");
    const issue = {
      collection: "records" as const,
      fileName: "broken.json",
      kind: "invalid_record" as const,
      message: "broken",
    };
    queryClient.setQueryData<AssignmentListData>(owningList, {
      assignments: [{ ...assignment, revision: 1, title: "Old" }],
      issues: [issue],
    });
    queryClient.setQueryData<AssignmentListData>(otherList, {
      assignments: [{ ...assignment, title: "Other host" }],
      issues: [],
    });

    await applyAssignmentMutation(queryClient, "host-a", assignment);

    expect(queryClient.getQueryData<AssignmentListData>(owningList)).toEqual({
      assignments: [assignment],
      issues: [issue],
    });
    expect(queryClient.getQueryData(assignmentQueryKey("host-a", assignment.id))).toEqual(
      assignment,
    );
    expect(queryClient.getQueryData<AssignmentListData>(otherList)?.assignments[0]?.title).toBe(
      "Other host",
    );
    expect(queryClient.getQueryState(owningList)?.isInvalidated).toBe(true);
  });
});
