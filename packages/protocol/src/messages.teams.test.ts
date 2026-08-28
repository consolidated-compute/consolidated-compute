import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";
import {
  TeamDefinitionDtoSchema,
  TeamResolvedLaunchDtoSchema,
  TeamRunDtoSchema,
  TeamRunStepDtoSchema,
  TeamRunStepSnapshotDtoSchema,
} from "./team/types.js";

const team = {
  id: "team_1",
  revision: 3,
  name: "Ship safely",
  instructions: "Keep the changes narrow.",
  roles: [
    {
      id: "builder",
      name: "Builder",
      instructions: "Implement the plan.",
      profileId: "codex-builder",
    },
  ],
  workflow: [{ id: "implement", roleId: "builder", instructions: null }],
  createdAt: "2026-08-26T12:00:00.000Z",
  updatedAt: "2026-08-26T12:00:00.000Z",
};

const run = {
  id: "run_1",
  teamId: "team_1",
  teamRevision: 3,
  idempotencyKey: "caller-key-1",
  teamSnapshot: team,
  objective: "Implement the RPC contract.",
  workspace: {
    workspaceId: "workspace_1",
    projectId: "project_1",
    cwd: "/repo",
    displayName: "main",
  },
  steps: [
    {
      snapshot: {
        stepId: "implement",
        roleId: "builder",
        roleName: "Builder",
        roleInstructions: "Implement the plan.",
        stepInstructions: null,
        resolvedLaunch: {
          profileId: "codex-builder",
          provider: "codex",
          model: "gpt-5.6-sol",
          modeId: "default",
          thinkingOptionId: "high",
          featureValues: { fast_mode: false },
          providerOptions: {
            sandbox_mode: "workspace-write",
            approval_policy: "on-request",
          },
        },
      },
      state: { status: "pending" as const },
    },
  ],
  state: { status: "queued" as const },
  createdAt: "2026-08-26T12:01:00.000Z",
  updatedAt: "2026-08-26T12:01:00.000Z",
};

describe("Team wire contracts", () => {
  test("keeps role authoring profile-backed instead of duplicating launch settings", () => {
    const parsed = TeamDefinitionDtoSchema.parse({
      ...team,
      roles: [
        {
          ...team.roles[0],
          provider: "codex",
          model: "gpt-5.6-sol",
          modeId: "default",
          thinkingOptionId: "high",
          featureValues: { fast_mode: true },
        },
      ],
    });

    expect(parsed.roles[0]).toEqual(team.roles[0]);
  });

  test("carries the frozen resolved profile facts only in Team Run history", () => {
    expect(TeamRunDtoSchema.parse({ ...run, serverId: "must-not-cross-the-wire" })).toEqual(run);
  });

  test("keeps frozen provider options compatible with old Team Run payloads and clients", () => {
    const LegacyResolvedLaunchSchema = TeamResolvedLaunchDtoSchema.omit({
      providerOptions: true,
    });
    const LegacyStepSnapshotSchema = TeamRunStepSnapshotDtoSchema.extend({
      resolvedLaunch: LegacyResolvedLaunchSchema,
    });
    const LegacyStepSchema = TeamRunStepDtoSchema.extend({ snapshot: LegacyStepSnapshotSchema });
    const LegacyRunSchema = TeamRunDtoSchema.extend({ steps: z.array(LegacyStepSchema) });
    const { providerOptions: _providerOptions, ...legacyResolvedLaunch } =
      run.steps[0].snapshot.resolvedLaunch;
    const legacyRun = {
      ...run,
      steps: [
        {
          ...run.steps[0],
          snapshot: { ...run.steps[0].snapshot, resolvedLaunch: legacyResolvedLaunch },
        },
      ],
    };

    expect(TeamRunDtoSchema.parse(legacyRun)).toEqual(legacyRun);
    expect(LegacyRunSchema.parse(run)).toEqual(legacyRun);
  });

  test("keeps Assignment-backed run fields optional for old run payloads and ignorable by old clients", () => {
    expect(TeamRunDtoSchema.parse(run)).toEqual(run);

    const assignmentRun = {
      ...run,
      assignmentId: "asgn_0123456789abcdef",
      assignmentRevision: 1,
      assignmentSnapshot: {
        id: "asgn_0123456789abcdef",
        revision: 1,
        title: "Ship the RPC",
        objective: run.objective,
        workItem: null,
        state: { status: "open" as const },
        createdAt: run.createdAt,
        updatedAt: run.createdAt,
      },
      steps: [
        {
          ...run.steps[0],
          snapshot: {
            ...run.steps[0].snapshot,
            inputArtifactIds: [],
            outputArtifact: {
              id: "aart_0123456789abcdef",
              kind: "team_step_output" as const,
              title: "Builder output",
              mediaType: "text/markdown" as const,
            },
          },
        },
      ],
    };
    expect(TeamRunDtoSchema.parse(assignmentRun)).toEqual(assignmentRun);

    const LegacyStepSnapshotSchema = TeamRunStepSnapshotDtoSchema.omit({
      inputArtifactIds: true,
      outputArtifact: true,
    });
    const LegacyStepSchema = TeamRunStepDtoSchema.extend({ snapshot: LegacyStepSnapshotSchema });
    const LegacyRunSchema = TeamRunDtoSchema.omit({
      assignmentId: true,
      assignmentRevision: true,
      assignmentSnapshot: true,
    }).extend({ steps: z.array(LegacyStepSchema) });
    expect(LegacyRunSchema.parse(assignmentRun)).toEqual(run);
  });

  test("requires Team updates to include at least one authored field", () => {
    const request = {
      type: "team.update.request",
      requestId: "request_update",
      teamId: "team_1",
      expectedRevision: 3,
    } as const;

    expect(() => SessionInboundMessageSchema.parse({ ...request, patch: {} })).toThrow();
    expect(
      SessionInboundMessageSchema.parse({ ...request, patch: { name: "Ship carefully" } }),
    ).toMatchObject({ patch: { name: "Ship carefully" } });
  });

  test("accepts bounded namespaced Team Run list requests", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "team.run.list.request",
        requestId: "request_1",
        teamId: "team_1",
        limit: 100,
      }),
    ).toMatchObject({ type: "team.run.list.request", limit: 100 });

    expect(() =>
      SessionInboundMessageSchema.parse({
        type: "team.run.list.request",
        requestId: "request_2",
        limit: 101,
      }),
    ).toThrow();
  });

  test("parses correlated Team responses without unsolicited updates", () => {
    expect(
      SessionOutboundMessageSchema.parse({
        type: "team.run.start.response",
        payload: { requestId: "request_1", run },
      }),
    ).toMatchObject({
      type: "team.run.start.response",
      payload: { requestId: "request_1", run: { id: "run_1" } },
    });
  });

  test("keeps the Team capability optional for old peers", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "server_1",
        features: { agentProfiles: true },
      }).features,
    ).toEqual({ agentProfiles: true });

    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "server_1",
        features: { agentProfiles: true, teams: true },
      }).features,
    ).toEqual({ agentProfiles: true, teams: true });
  });

  test("lets a legacy server-info schema ignore the new Team capability", () => {
    const LegacyServerInfoSchema = z.object({
      status: z.literal("server_info"),
      serverId: z.string(),
      features: z.object({ agentProfiles: z.boolean().optional() }).optional(),
    });

    expect(
      LegacyServerInfoSchema.parse({
        status: "server_info",
        serverId: "server_1",
        features: { agentProfiles: true, teams: true },
      }),
    ).toEqual({
      status: "server_info",
      serverId: "server_1",
      features: { agentProfiles: true },
    });
  });
});
