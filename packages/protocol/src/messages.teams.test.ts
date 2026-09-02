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
  TeamRunSupervisionStartDtoSchema,
  TeamSecurityPostureDtoSchema,
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
            writable_root: "/private/path-sentinel",
            proxy_url: "https://proxy-sentinel.invalid",
            socket_path: "/private/socket-sentinel",
            tls_key_path: "/private/tls-key-sentinel",
          },
          securityPosture: {
            source: { provider: "codex" },
            filesystemWrite: {
              status: "policy_only" as const,
              summary: "Codex applies a filesystem sandbox, but broader access may be approved.",
            },
            networkAccess: {
              status: "unavailable" as const,
              summary: "Codex network enforcement is not proved by the frozen launch.",
            },
            toolShell: {
              status: "policy_only" as const,
              summary: "Codex applies provider approval policy to tool and shell use.",
            },
            nativeDelegation: {
              status: "enforced" as const,
              summary: "Codex native multi-agent delegation is disabled for this launch.",
            },
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

const { providerOptions: _providerOptions, ...publicResolvedLaunch } =
  run.steps[0].snapshot.resolvedLaunch;
const publicRun = {
  ...run,
  steps: [
    {
      ...run.steps[0],
      snapshot: { ...run.steps[0].snapshot, resolvedLaunch: publicResolvedLaunch },
    },
  ],
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
    expect(TeamRunDtoSchema.parse({ ...run, serverId: "must-not-cross-the-wire" })).toEqual(
      publicRun,
    );
  });

  test("keeps raw frozen provider options server-side", () => {
    const parsed = TeamRunDtoSchema.parse(run);
    expect(parsed).toEqual(publicRun);
    expect(parsed.steps[0]?.snapshot.resolvedLaunch).not.toHaveProperty("providerOptions");
    expect(JSON.stringify(parsed)).not.toMatch(
      /path-sentinel|proxy-sentinel|socket-sentinel|tls-key-sentinel/u,
    );
  });

  test("keeps Assignment-backed run fields optional for old run payloads and ignorable by old clients", () => {
    expect(TeamRunDtoSchema.parse(run)).toEqual(publicRun);

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
    const publicAssignmentRun = {
      ...assignmentRun,
      steps: [
        {
          ...assignmentRun.steps[0],
          snapshot: {
            ...assignmentRun.steps[0].snapshot,
            resolvedLaunch: publicResolvedLaunch,
          },
        },
      ],
    };
    expect(TeamRunDtoSchema.parse(assignmentRun)).toEqual(publicAssignmentRun);

    const LegacyResolvedLaunchSchema = TeamResolvedLaunchDtoSchema.omit({
      securityPosture: true,
    });
    const LegacyStepSnapshotSchema = TeamRunStepSnapshotDtoSchema.omit({
      inputArtifactIds: true,
      outputArtifact: true,
    }).extend({ resolvedLaunch: LegacyResolvedLaunchSchema });
    const LegacyStepSchema = TeamRunStepDtoSchema.extend({ snapshot: LegacyStepSnapshotSchema });
    const LegacyRunSchema = TeamRunDtoSchema.omit({
      assignmentId: true,
      assignmentRevision: true,
      assignmentSnapshot: true,
    }).extend({ steps: z.array(LegacyStepSchema) });
    expect(LegacyRunSchema.parse(assignmentRun)).toEqual({
      ...publicRun,
      steps: [
        {
          ...publicRun.steps[0],
          snapshot: {
            ...publicRun.steps[0].snapshot,
            resolvedLaunch: LegacyResolvedLaunchSchema.parse(publicResolvedLaunch),
          },
        },
      ],
    });
  });

  test("keeps security posture optional for historical Team Runs", () => {
    const { securityPosture: _securityPosture, ...legacyResolvedLaunch } = publicResolvedLaunch;
    const legacyRun = {
      ...publicRun,
      steps: [
        {
          ...publicRun.steps[0],
          snapshot: {
            ...publicRun.steps[0].snapshot,
            resolvedLaunch: legacyResolvedLaunch,
          },
        },
      ],
    };

    expect(TeamRunDtoSchema.parse(legacyRun)).toEqual(legacyRun);
  });

  test("keeps native delegation posture optional and ignorable by old clients", () => {
    const posture = publicResolvedLaunch.securityPosture!;
    const { nativeDelegation: _nativeDelegation, ...legacyPosture } = posture;
    expect(TeamSecurityPostureDtoSchema.parse(legacyPosture)).toEqual(legacyPosture);

    const LegacySecurityPostureSchema = TeamSecurityPostureDtoSchema.omit({
      nativeDelegation: true,
    });
    expect(LegacySecurityPostureSchema.parse(posture)).toEqual(legacyPosture);
  });

  test("keeps compact supervision summaries optional and forward-readable", () => {
    const supervisedRun = {
      ...publicRun,
      steps: [],
      supervision: {
        status: "future_supervision_phase",
        supervisorRoleId: "supervisor",
        supervisorAgentId: "00000000-0000-4000-8000-000000000401",
        completedWorkItems: 1,
        totalWorkItems: 2,
        pendingHumanRequest: {
          id: "human_review",
          kind: "policy_exception",
          title: "Choose the bounded next action",
          revision: 2,
        },
        updatedAt: run.updatedAt,
      },
    };

    expect(TeamRunDtoSchema.parse(supervisedRun)).toEqual(supervisedRun);
    expect(TeamRunSupervisionStartDtoSchema.parse({ supervisorRoleId: "supervisor" })).toEqual({
      supervisorRoleId: "supervisor",
    });

    const LegacyRunSchema = TeamRunDtoSchema.omit({ supervision: true });
    expect(LegacyRunSchema.parse(supervisedRun)).toEqual({
      ...publicRun,
      steps: [],
    });
    expect(TeamRunDtoSchema.parse(publicRun)).toEqual(publicRun);
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

  test("parses sanitized Team Run previews and optional admission fingerprints", () => {
    const fingerprint = "a".repeat(64);
    expect(
      SessionInboundMessageSchema.parse({
        type: "team.run.preview.request",
        requestId: "request_preview",
        teamId: team.id,
        expectedRevision: team.revision,
        workspaceId: run.workspace.workspaceId,
      }),
    ).toMatchObject({ type: "team.run.preview.request", teamId: team.id });

    const parsed = SessionOutboundMessageSchema.parse({
      type: "team.run.preview.response",
      payload: {
        requestId: "request_preview",
        preview: {
          workspace: run.workspace,
          roles: [
            {
              roleId: team.roles[0].id,
              roleName: team.roles[0].name,
              resolvedLaunch: run.steps[0].snapshot.resolvedLaunch,
            },
          ],
          fingerprint,
        },
      },
    });
    expect(parsed).toMatchObject({
      type: "team.run.preview.response",
      payload: { preview: { fingerprint, roles: [{ roleId: "builder" }] } },
    });
    expect(JSON.stringify(parsed)).not.toMatch(/path-sentinel|proxy-sentinel/u);

    expect(
      SessionInboundMessageSchema.parse({
        type: "team.run.start.request",
        requestId: "request_start",
        teamId: team.id,
        expectedRevision: team.revision,
        idempotencyKey: "previewed-start",
        objective: "Use the accepted preview.",
        workspaceId: run.workspace.workspaceId,
        expectedPreviewFingerprint: fingerprint,
      }),
    ).toMatchObject({ expectedPreviewFingerprint: fingerprint });
  });

  test("parses durable supervision state, event pagination, and responses", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "team.run.supervision.human_request.respond.request",
        requestId: "request_respond",
        runId: run.id,
        humanRequestId: "human_1",
        expectedRevision: 2,
        actionId: "continue",
        note: "Proceed.",
        idempotencyKey: "response_1",
      }),
    ).toMatchObject({ expectedRevision: 2, actionId: "continue" });
    expect(() =>
      SessionInboundMessageSchema.parse({
        type: "team.run.supervision.human_request.respond.request",
        requestId: "request_blank_note",
        runId: run.id,
        humanRequestId: "human_1",
        expectedRevision: 2,
        actionId: "continue",
        note: " \n\t ",
        idempotencyKey: "response_blank_note",
      }),
    ).toThrow();

    const event = {
      id: "event_1",
      sequence: 1,
      kind: "decision.escalate",
      title: "Supervisor requested human input",
      detail: "Choose the next action.",
      decisionId: "decision_1",
      actionId: "action_1",
      workItemId: null,
      attemptId: null,
      humanRequestId: "human_1",
      roleIds: ["supervisor"],
      agentIds: ["agent_1"],
      stepIds: [],
      artifactIds: [],
      createdAt: "2026-08-26T12:00:00.000Z",
    };
    expect(
      SessionOutboundMessageSchema.parse({
        type: "team.run.supervision.events.list.response",
        payload: { requestId: "request_events", events: [event], nextCursor: null },
      }),
    ).toMatchObject({ payload: { events: [{ kind: "decision.escalate" }] } });

    const supervision = {
      runId: run.id,
      revision: 3,
      status: "awaiting_human",
      supervisorRoleId: "supervisor",
      supervisorAgentId: "agent_1",
      completedWorkItems: 0,
      totalWorkItems: 1,
      humanRequest: {
        id: "human_1",
        revision: 1,
        kind: "supervisor_escalation",
        title: "Supervisor needs input",
        detail: "Choose the next action.",
        actions: [{ id: "continue", label: "Continue", requiresNote: false }],
        roleIds: ["supervisor"],
        agentIds: ["agent_1"],
        stepIds: [],
        artifactIds: [],
        createdAt: "2026-08-26T12:00:00.000Z",
      },
      updatedAt: "2026-08-26T12:00:00.000Z",
    };
    expect(
      SessionOutboundMessageSchema.parse({
        type: "team.run.supervision.get.response",
        payload: { requestId: "request_state", supervision },
      }),
    ).toMatchObject({ payload: { supervision: { status: "awaiting_human" } } });
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
        features: {
          agentProfiles: true,
          teams: true,
          teamSecurity: true,
          teamRunPreview: true,
          teamSupervision: true,
          teamSupervisionAdmission: "available",
        },
      }).features,
    ).toEqual({
      agentProfiles: true,
      teams: true,
      teamSecurity: true,
      teamRunPreview: true,
      teamSupervision: true,
      teamSupervisionAdmission: "available",
    });
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
        features: {
          agentProfiles: true,
          teams: true,
          teamSecurity: true,
          teamRunPreview: true,
          teamSupervision: true,
          teamSupervisionAdmission: "authentication_required",
        },
      }),
    ).toEqual({
      status: "server_info",
      serverId: "server_1",
      features: { agentProfiles: true },
    });
  });
});
