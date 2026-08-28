import { describe, expect, it } from "vitest";
import type { AssignmentDto } from "@getpaseo/protocol/assignment/types";
import {
  assignmentListQueryKey,
  assignmentKey,
  assignmentQueryKey,
  qualifyAssignments,
  resolveAssignmentHostState,
  upsertAssignment,
} from "./data";

const assignment = (id: string, updatedAt = "2026-08-27T12:00:00.000Z"): AssignmentDto => ({
  id,
  revision: 1,
  title: `Assignment ${id}`,
  objective: "Deliver the requested change",
  workItem: null,
  state: { status: "open" },
  createdAt: "2026-08-27T11:00:00.000Z",
  updatedAt,
});

describe("Assignment aggregate data", () => {
  it("qualifies identity by host without delimiter collisions", () => {
    expect(assignmentKey("host:a", "b")).not.toBe(assignmentKey("host", "a:b"));
    expect(
      qualifyAssignments({ serverId: "host:a", serverName: "Laptop" }, [assignment("b")]),
    ).toMatchObject([
      {
        id: "b",
        serverId: "host:a",
        serverName: "Laptop",
        key: '["host:a","b"]',
      },
    ]);
  });

  it("qualifies list and detail caches by host", () => {
    expect(assignmentListQueryKey("host-a")).not.toEqual(assignmentListQueryKey("host-b"));
    expect(assignmentQueryKey("host-a", "same-id")).not.toEqual(
      assignmentQueryKey("host-b", "same-id"),
    );
  });

  it("keeps healthy records and diagnostics in a ready host", () => {
    const issue = {
      collection: "records" as const,
      fileName: "broken.json",
      kind: "invalid_record" as const,
      message: "Invalid JSON",
    };
    expect(
      resolveAssignmentHostState({
        serverId: "host-1",
        serverName: "Laptop",
        connectionStatus: "online",
        assignmentsFeature: true,
        query: {
          data: { assignments: [assignment("asgn_1")], issues: [issue] },
          isLoading: false,
          isError: false,
          error: null,
        },
        connectionError: null,
      }),
    ).toMatchObject({
      status: "ready",
      canAuthor: true,
      assignments: [{ id: "asgn_1" }],
      issues: [issue],
    });
  });

  it("distinguishes connecting, unsupported, offline, and query errors", () => {
    const base = {
      serverId: "host-1",
      serverName: "Laptop",
      assignmentsFeature: true,
      query: { data: undefined, isLoading: false, isError: false, error: null },
      connectionError: null,
    };
    expect(resolveAssignmentHostState({ ...base, connectionStatus: "connecting" }).status).toBe(
      "connecting",
    );
    expect(
      resolveAssignmentHostState({
        ...base,
        connectionStatus: "online",
        assignmentsFeature: false,
      }).status,
    ).toBe("unsupported");
    expect(
      resolveAssignmentHostState({
        ...base,
        connectionStatus: "offline",
        connectionError: "closed",
      }),
    ).toMatchObject({ status: "offline", error: "closed" });
    expect(
      resolveAssignmentHostState({
        ...base,
        connectionStatus: "online",
        query: { data: undefined, isLoading: false, isError: true, error: new Error("boom") },
      }),
    ).toMatchObject({ status: "error", error: "boom" });
  });

  it("retains last-known records while a host is offline", () => {
    expect(
      resolveAssignmentHostState({
        serverId: "host-1",
        serverName: "Laptop",
        connectionStatus: "offline",
        assignmentsFeature: true,
        query: {
          data: { assignments: [assignment("asgn_cached")], issues: [] },
          isLoading: false,
          isError: false,
          error: null,
        },
        connectionError: "closed",
      }),
    ).toMatchObject({ status: "offline", canAuthor: false, assignments: [{ id: "asgn_cached" }] });
  });

  it("upserts newest snapshots in updated order", () => {
    expect(
      upsertAssignment(
        [assignment("older", "2026-08-27T12:00:00.000Z")],
        assignment("newer", "2026-08-27T13:00:00.000Z"),
      ).map((entry) => entry.id),
    ).toEqual(["newer", "older"]);
  });
});
