import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";
import { AssignmentArtifactDtoSchema, AssignmentDtoSchema } from "./assignment/types.js";

const assignment = {
  id: "asgn_0123456789abcdef",
  revision: 2,
  title: "Expose Assignment APIs",
  objective: "Publish the durable Assignment contract.",
  workItem: {
    sourceId: "github",
    sourceLabel: "GitHub",
    resourceType: "issue",
    resourceId: "consolidated-compute#70",
    identifier: "#70",
    title: "Assignment RPC and SDK APIs",
    url: "https://github.com/consolidated-compute/consolidated-compute/issues/70",
  },
  state: { status: "open" as const },
  createdAt: "2026-08-27T12:00:00.000Z",
  updatedAt: "2026-08-27T12:01:00.000Z",
};

const artifact = {
  id: "aart_0123456789abcdef",
  assignmentId: assignment.id,
  assignmentRevision: 2,
  kind: "team_step_output",
  title: "Builder output",
  mediaType: "text/markdown" as const,
  content: "Implemented the Assignment API.",
  includedBytes: 31,
  originalBytes: 31,
  truncated: false,
  producer: {
    kind: "team_run_step" as const,
    teamRunId: "trun_0123456789abcdef",
    stepId: "implement",
    roleId: "builder",
    agentId: "11111111-1111-4111-8111-111111111111",
    turnId: "turn_1",
  },
  createdAt: "2026-08-27T12:02:00.000Z",
};

describe("Assignment wire contracts", () => {
  test("keeps Assignment DTOs distinct from chat artifacts", () => {
    expect(AssignmentDtoSchema.parse(assignment)).toEqual(assignment);
    expect(AssignmentArtifactDtoSchema.parse(artifact)).toEqual(artifact);
  });

  test("requires non-empty patches and bounds artifact pages", () => {
    const patchRequest = {
      type: "assignment.patch.request",
      requestId: "request_patch",
      assignmentId: assignment.id,
      expectedRevision: 2,
    } as const;

    expect(() => SessionInboundMessageSchema.parse({ ...patchRequest, patch: {} })).toThrow();
    expect(
      SessionInboundMessageSchema.parse({ ...patchRequest, patch: { title: "Narrow API" } }),
    ).toMatchObject({ patch: { title: "Narrow API" } });
    expect(() =>
      SessionInboundMessageSchema.parse({
        type: "assignment.artifact.list.request",
        requestId: "request_list",
        assignmentId: assignment.id,
        limit: 101,
      }),
    ).toThrow();
  });

  test("parses the Assignment-backed Team Run start without changing objective starts", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "assignment.team_run.start.request",
        requestId: "request_start",
        teamId: "team_delivery",
        expectedRevision: 3,
        idempotencyKey: "assignment-run-1",
        assignmentId: assignment.id,
        expectedAssignmentRevision: 2,
        workspaceId: "workspace_delivery",
      }),
    ).toMatchObject({
      type: "assignment.team_run.start.request",
      assignmentId: assignment.id,
    });

    expect(
      SessionInboundMessageSchema.parse({
        type: "team.run.start.request",
        requestId: "legacy_start",
        teamId: "team_delivery",
        expectedRevision: 3,
        idempotencyKey: "objective-run-1",
        objective: "Keep the existing contract.",
        workspaceId: "workspace_delivery",
      }),
    ).toMatchObject({ type: "team.run.start.request", objective: "Keep the existing contract." });
  });

  test("parses correlated Assignment and Artifact responses", () => {
    expect(
      SessionOutboundMessageSchema.parse({
        type: "assignment.list.response",
        payload: {
          requestId: "request_list",
          assignments: [assignment],
          issues: [
            {
              collection: "records",
              fileName: "broken.json",
              kind: "invalid_record",
              message: "Invalid record",
            },
          ],
        },
      }),
    ).toMatchObject({
      payload: {
        assignments: [{ id: assignment.id }],
        issues: [{ fileName: "broken.json", kind: "invalid_record" }],
      },
    });
    expect(
      SessionOutboundMessageSchema.parse({
        type: "assignment.artifact.list.response",
        payload: { requestId: "request_artifacts", artifacts: [artifact], nextCursor: null },
      }),
    ).toMatchObject({ payload: { artifacts: [{ id: artifact.id }] } });
  });

  test("keeps the Assignment capability optional and ignorable by old peers", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "server_1",
        features: { teams: true, assignments: true },
      }).features,
    ).toEqual({ teams: true, assignments: true });

    const LegacyServerInfoSchema = z.object({
      status: z.literal("server_info"),
      serverId: z.string(),
      features: z.object({ teams: z.boolean().optional() }).optional(),
    });
    expect(
      LegacyServerInfoSchema.parse({
        status: "server_info",
        serverId: "server_1",
        features: { teams: true, assignments: true },
      }),
    ).toEqual({ status: "server_info", serverId: "server_1", features: { teams: true } });
  });
});
