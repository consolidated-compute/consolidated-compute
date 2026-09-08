import { afterEach, describe, expect, it } from "vitest";
import { useAddProjectFlowStore } from "./add-project-flow-store";

describe("Assignment Add Project context", () => {
  afterEach(() => useAddProjectFlowStore.getState().close());

  it("carries the originating Assignment and host, then clears both for an ordinary flow", () => {
    const store = useAddProjectFlowStore.getState();
    store.openForAssignment({ serverId: "assignment-host", assignmentId: "assignment-1" });
    expect(useAddProjectFlowStore.getState().request).toMatchObject({
      preferredHostId: "assignment-host",
      assignmentId: "assignment-1",
    });
    store.close();
    expect(useAddProjectFlowStore.getState().request).toBeNull();
    store.open("ordinary-host");
    expect(useAddProjectFlowStore.getState().request).toEqual({
      id: expect.any(Number),
      preferredHostId: "ordinary-host",
    });
  });
});
