import { describe, expect, it, vi } from "vitest";
import type { AssignmentDto } from "@getpaseo/protocol/assignment/types";
import { openAssignmentForm } from "./form-model";

it("seeds a bounded external Work Item without implicitly importing its body as an objective", () => {
  const workItem = {
    sourceId: "github",
    sourceLabel: "GitHub",
    resourceType: "issue",
    resourceId: "github.com:R_1:I_1",
    identifier: "#1",
    title: "x".repeat(512),
    url: "https://github.com/org/project/issues/1",
  };
  const model = openAssignmentForm({
    mode: "create",
    hosts: [{ serverId: "laptop", label: "Laptop" }],
    initialWorkItem: workItem,
  });
  expect(model.getState()).toMatchObject({
    title: "x".repeat(120),
    objective: "",
    workItem,
    canSubmit: false,
    validationIssue: "objective_required",
  });
  model.setObjective("Operator intent");
  expect(model.getState().submission).toEqual({
    kind: "create",
    serverId: "laptop",
    assignment: { title: "x".repeat(120), objective: "Operator intent", workItem },
  });
  model.setHost("desktop", "Desktop");
  expect(model.getState().workItem).toBeNull();
});

const existing: AssignmentDto = {
  id: "asgn_0123456789abcdef",
  revision: 4,
  title: "Existing Assignment",
  objective: "Preserve this draft",
  workItem: {
    sourceId: "github",
    sourceLabel: "GitHub",
    resourceType: "issue",
    resourceId: "owner/repo#71",
    identifier: "#71",
    title: "Assignment surfaces",
    url: "https://github.com/owner/repo/issues/71",
  },
  state: { status: "open" },
  createdAt: "2026-08-27T10:00:00.000Z",
  updatedAt: "2026-08-27T11:00:00.000Z",
};

describe("Assignment form model", () => {
  it("creates a host-qualified submission and owns the selected display", () => {
    const model = openAssignmentForm({
      mode: "create",
      hosts: [
        { serverId: "host-1", label: "Laptop" },
        { serverId: "host-2", label: "Desktop" },
      ],
    });
    model.setHost("host-2", "My desktop");
    model.setTitle("Ship Assignment UI");
    model.setObjective("Build the complete user flow");
    model.applyHosts([{ serverId: "host-2", label: "Renamed host" }]);
    expect(model.getState()).toMatchObject({
      selectedServerId: "host-2",
      selectedHostDisplay: "My desktop",
      canSubmit: true,
      submission: {
        kind: "create",
        serverId: "host-2",
        assignment: {
          title: "Ship Assignment UI",
          objective: "Build the complete user flow",
          workItem: null,
        },
      },
    });
  });

  it("seeds every edit value and preserves input while recovering a stale revision", () => {
    const model = openAssignmentForm({
      mode: "edit",
      hosts: [{ serverId: "host-1", label: "Laptop" }],
      selectedServerId: "host-1",
      assignment: existing,
    });
    model.setTitle("Locally edited title");
    model.setObjective("Locally edited objective");
    model.applyRemoteRevision(5);
    expect(model.getState()).toMatchObject({
      title: "Locally edited title",
      objective: "Locally edited objective",
      workItem: existing.workItem,
      expectedRevision: 5,
      revisionRecovered: true,
      submission: {
        kind: "update",
        serverId: "host-1",
        assignmentId: existing.id,
        expectedRevision: 5,
      },
    });
  });

  it("enforces daemon limits and valid bounded Work Item snapshots", () => {
    const model = openAssignmentForm({
      mode: "create",
      hosts: [{ serverId: "host-1", label: "Laptop" }],
    });
    model.setTitle("x".repeat(121));
    model.setObjective("Objective");
    expect(model.getState().validationIssue).toBe("title_too_long");
    model.setTitle("Assignment");
    model.setObjective("x".repeat(32_001));
    expect(model.getState().validationIssue).toBe("objective_too_long");
    model.setObjective("Objective");
    model.setWorkItem({ ...existing.workItem!, url: "file:///tmp/issue" });
    expect(model.getState().validationIssue).toBe("work_item_invalid");
  });

  it("stops publishing after close", () => {
    const model = openAssignmentForm({
      mode: "create",
      hosts: [{ serverId: "host-1", label: "Laptop" }],
    });
    const listener = vi.fn();
    model.subscribe(listener);
    model.close();
    model.setTitle("Ignored");
    expect(listener).not.toHaveBeenCalled();
  });
});
