import { isAbsolute } from "node:path";

import { describe, expect, test } from "vitest";

import {
  ASSIGNMENT_ARTIFACT_CONTENT_MAX_BYTES,
  ASSIGNMENT_OBJECTIVE_MAX_CHARS,
  generateAssignmentArtifactId,
  generateAssignmentId,
  PersistedAssignmentArtifactRecordSchema,
  PersistedAssignmentRecordSchema,
  type PersistedAssignmentArtifactRecord,
  type PersistedAssignmentRecord,
} from "./model.js";

const timestamp = "2026-08-27T12:00:00.000Z";
const laterTimestamp = "2026-08-27T13:00:00.000Z";

function createAssignment(): PersistedAssignmentRecord {
  return {
    id: "asgn_0123456789abcdef",
    revision: 3,
    title: "Implement durable assignments",
    objective: "Add the smallest durable execution-intent contract.",
    workItem: {
      sourceId: "github",
      sourceLabel: "GitHub",
      resourceType: "issue",
      resourceId: "consolidated-compute/consolidated-compute#5",
      identifier: "#5",
      title: "v0.3: Add Assignments and explicit Artifacts",
      url: "https://github.com/consolidated-compute/consolidated-compute/issues/5",
    },
    state: { status: "open" },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function createArtifact(): PersistedAssignmentArtifactRecord {
  const content = "## Plan\n\nDefine the contract before persistence.";
  const includedBytes = Buffer.byteLength(content, "utf8");
  return {
    id: "aart_fedcba9876543210",
    assignmentId: "asgn_0123456789abcdef",
    assignmentRevision: 3,
    kind: "plan",
    title: "Implementation plan",
    mediaType: "text/markdown",
    content,
    includedBytes,
    originalBytes: includedBytes,
    truncated: false,
    producer: {
      kind: "team_run_step",
      teamRunId: "trun_0123456789abcdef",
      stepId: "step_plan",
      roleId: "role_planner",
      agentId: "9f44cd43-89a5-4371-af49-679bfbf8d1d7",
      turnId: "turn-plan",
    },
    createdAt: timestamp,
  };
}

describe("Assignment contract", () => {
  test("accepts revisioned execution intent with a bounded Work Item reference", () => {
    const assignment = createAssignment();

    expect(PersistedAssignmentRecordSchema.parse(assignment)).toEqual(assignment);
    expect(
      PersistedAssignmentRecordSchema.safeParse({ ...assignment, workItem: null }).success,
    ).toBe(true);
  });

  test("keeps external Work Items as strict references rather than tracker mirrors", () => {
    const assignment = createAssignment();
    const withTrackerState = {
      ...assignment,
      workItem: {
        ...assignment.workItem,
        body: "Do not persist this.",
        status: "open",
      },
    };
    const mirrored = PersistedAssignmentRecordSchema.safeParse(withTrackerState);

    expect(mirrored.success).toBe(false);
    if (!assignment.workItem) return;
    const nonHttp = PersistedAssignmentRecordSchema.safeParse({
      ...assignment,
      workItem: { ...assignment.workItem, url: "file:///tmp/issue.json" },
    });
    expect(nonHttp.success).toBe(false);
  });

  test("rejects blank and oversized execution intent", () => {
    const assignment = createAssignment();
    assignment.title = "   ";
    assignment.objective = "x".repeat(ASSIGNMENT_OBJECTIVE_MAX_CHARS + 1);

    const result = PersistedAssignmentRecordSchema.safeParse(assignment);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([["title"], ["objective"]]),
    );
  });

  test("requires terminal lifecycle timestamps to close the current revision", () => {
    const assignment = createAssignment();
    assignment.state = { status: "completed", completedAt: laterTimestamp };
    assignment.updatedAt = laterTimestamp;
    expect(PersistedAssignmentRecordSchema.safeParse(assignment).success).toBe(true);

    assignment.updatedAt = timestamp;
    const staleUpdate = PersistedAssignmentRecordSchema.safeParse(assignment);
    expect(staleUpdate.success).toBe(false);
    if (staleUpdate.success) return;
    expect(staleUpdate.error.issues.map((issue) => issue.message)).toContain(
      "updatedAt must match the terminal lifecycle timestamp",
    );

    assignment.state = { status: "canceled", canceledAt: "2026-08-27T11:00:00.000Z" };
    const beforeCreation = PersistedAssignmentRecordSchema.safeParse(assignment);
    expect(beforeCreation.success).toBe(false);
    if (beforeCreation.success) return;
    expect(beforeCreation.error.issues.map((issue) => issue.message)).toContain(
      "Lifecycle timestamp cannot precede createdAt",
    );
  });
});

describe("Assignment Artifact contract", () => {
  test("accepts one immutable bounded result with exact Team step provenance", () => {
    const artifact = createArtifact();

    expect(PersistedAssignmentArtifactRecordSchema.parse(artifact)).toEqual(artifact);
  });

  test("rejects update fields and invalid producer facts", () => {
    const artifact = createArtifact();
    const mutable = PersistedAssignmentArtifactRecordSchema.safeParse({
      ...artifact,
      revision: 2,
      updatedAt: laterTimestamp,
    });
    expect(mutable.success).toBe(false);

    artifact.producer.agentId = "not-a-guid";
    artifact.producer.stepId = "../step";
    const invalidProducer = PersistedAssignmentArtifactRecordSchema.safeParse(artifact);
    expect(invalidProducer.success).toBe(false);
  });

  test("uses open bounded kind tokens rather than a closed semantic enum", () => {
    const artifact = createArtifact();
    artifact.kind = "architecture.decision";
    expect(PersistedAssignmentArtifactRecordSchema.safeParse(artifact).success).toBe(true);

    artifact.kind = "Architecture decision";
    expect(PersistedAssignmentArtifactRecordSchema.safeParse(artifact).success).toBe(false);
  });

  test("enforces content limits in UTF-8 bytes and rejects empty output", () => {
    const artifact = createArtifact();
    artifact.content = "🙂".repeat(ASSIGNMENT_ARTIFACT_CONTENT_MAX_BYTES / 4 + 1);
    artifact.includedBytes = Buffer.byteLength(artifact.content, "utf8");
    artifact.originalBytes = artifact.includedBytes;

    const oversized = PersistedAssignmentArtifactRecordSchema.safeParse(artifact);
    expect(oversized.success).toBe(false);
    if (oversized.success) return;
    expect(oversized.error.issues.map((issue) => issue.message)).toContain(
      `Content exceeds ${ASSIGNMENT_ARTIFACT_CONTENT_MAX_BYTES} UTF-8 bytes`,
    );

    artifact.content = "   ";
    artifact.includedBytes = Buffer.byteLength(artifact.content, "utf8");
    artifact.originalBytes = artifact.includedBytes;
    expect(PersistedAssignmentArtifactRecordSchema.safeParse(artifact).success).toBe(false);
  });

  test("requires byte and truncation metadata to describe the stored content", () => {
    const artifact = createArtifact();
    artifact.includedBytes += 1;
    artifact.originalBytes += 10;

    const result = PersistedAssignmentArtifactRecordSchema.safeParse(artifact);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        "includedBytes must equal the UTF-8 byte length of content",
        "truncated must be true when originalBytes exceeds includedBytes",
      ]),
    );
  });
});

describe("Assignment IDs", () => {
  test("generates daemon-local path-safe IDs", () => {
    expect(generateAssignmentId()).toMatch(/^asgn_[0-9a-f]{16}$/);
    expect(generateAssignmentArtifactId()).toMatch(/^aart_[0-9a-f]{16}$/);
    expect(isAbsolute(generateAssignmentId())).toBe(false);
    expect(isAbsolute(generateAssignmentArtifactId())).toBe(false);
  });
});
