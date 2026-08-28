import { describe, expect, it } from "vitest";
import { loadNextAssignmentRunPage } from "./run-data";

describe("Assignment Team Run data", () => {
  it("skips unrelated pages before returning Assignment runs", async () => {
    const cursors: Array<string | null> = [];
    const pages = new Map([
      [null, { runs: [{ id: "other", assignmentId: "assignment-2" }], nextCursor: "page-2" }],
      ["page-2", { runs: [{ id: "target", assignmentId: "assignment-1" }], nextCursor: "page-3" }],
    ]);

    const page = await loadNextAssignmentRunPage({
      assignmentId: "assignment-1",
      cursor: null,
      loadPage: async (cursor) => {
        cursors.push(cursor);
        const result = pages.get(cursor);
        if (!result) throw new Error(`Unexpected cursor: ${cursor}`);
        return result;
      },
    });

    expect(cursors).toEqual([null, "page-2"]);
    expect(page).toEqual({
      runs: [{ id: "target", assignmentId: "assignment-1" }],
      nextCursor: "page-3",
    });
  });

  it("exhausts unrelated pages before returning an empty result", async () => {
    const cursors: Array<string | null> = [];

    const page = await loadNextAssignmentRunPage({
      assignmentId: "assignment-1",
      cursor: null,
      loadPage: async (cursor) => {
        cursors.push(cursor);
        return cursor === null
          ? { runs: [{ id: "other-1", assignmentId: "assignment-2" }], nextCursor: "page-2" }
          : { runs: [{ id: "other-2", assignmentId: "assignment-3" }], nextCursor: null };
      },
    });

    expect(cursors).toEqual([null, "page-2"]);
    expect(page).toEqual({ runs: [], nextCursor: null });
  });
});
