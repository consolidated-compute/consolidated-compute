import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { describe, expect, test } from "vitest";

import type {
  AgentFeature,
  AgentModelDefinition,
  AgentPromptInput,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent/agent-sdk-types.js";
import type { CreateAgentFromMcpInput } from "../agent/create-agent/create.js";
import { projectUnavailableProviderSecurityPosture } from "../agent/provider-security-posture.js";
import { createPersistedWorkspaceRecord } from "../workspace-registry.js";
import {
  PersistedTeamDefinitionSchema,
  PersistedTeamRunRecordSchema,
  type PersistedTeamDefinition,
  type PersistedTeamRunRecord,
} from "./model.js";
import {
  TEAM_ID_LABEL,
  TEAM_ROLE_ID_LABEL,
  TEAM_RUN_ID_LABEL,
  TEAM_STEP_ID_LABEL,
  TeamExecutionPreflightError,
  TeamStepStreamEndedError,
  composeTeamStepPrompt,
  createTeamHandoff,
  executeTeamStep,
  preflightTeamRun,
  type AcceptedTeamRunFacts,
  type TeamAgentStream,
  type TeamFeatureCatalog,
  type TeamProviderCatalog,
  type TeamRunPreflightDependencies,
  type TeamStepExecutionDependencies,
  type TeamStepExecutionEvent,
  type TeamWorkspaceStore,
} from "./execution.js";

const firstTimestamp = "2026-08-25T12:00:00.000Z";
const plannedAgentId = "00000000-0000-4000-8000-000000000301";

function createDefinition(): PersistedTeamDefinition {
  return PersistedTeamDefinitionSchema.parse({
    id: "team_delivery",
    revision: 1,
    name: "Delivery Team",
    instructions: "Deliver the objective and review the result.",
    roles: [
      {
        id: "role_builder",
        name: "Builder",
        instructions: "Implement the requested change.",
        profileId: "profile_builder",
      },
      {
        id: "role_reviewer",
        name: "Reviewer",
        instructions: "Review the implementation.",
        profileId: "profile_reviewer",
      },
    ],
    workflow: [
      { id: "step_build", roleId: "role_builder", instructions: null },
      {
        id: "step_review",
        roleId: "role_reviewer",
        instructions: "Report only actionable defects.",
      },
    ],
    createdAt: firstTimestamp,
    updatedAt: firstTimestamp,
  });
}

function createProfiles(): AgentProfile[] {
  return [
    {
      id: "profile_builder",
      name: "Codex Builder",
      provider: " codex ",
      model: " latest ",
      modeId: " workspace-write ",
      thinkingOptionId: " high ",
      featureValues: { fast_mode: true },
      providerOptions: {
        sandbox_mode: "workspace-write",
        approval_policy: "on-request",
      },
    },
    {
      id: "profile_reviewer",
      name: "Claude Reviewer",
      provider: "claude",
    },
  ];
}

function createWorkspace() {
  return createPersistedWorkspaceRecord({
    workspaceId: "wks_team_test",
    projectId: "prj_team_test",
    cwd: "/repo/worktree",
    kind: "worktree",
    displayName: "feature/teams",
    title: "Team workspace",
    createdAt: firstTimestamp,
    updatedAt: firstTimestamp,
  });
}

class MemoryWorkspaceStore implements TeamWorkspaceStore {
  reads: string[] = [];

  constructor(public workspace: ReturnType<typeof createWorkspace> | null) {}

  async get(workspaceId: string) {
    this.reads.push(workspaceId);
    return this.workspace;
  }
}

interface CatalogRead {
  cwd: string | null | undefined;
  provider: string;
  wait: boolean | undefined;
}

class MemoryProviderCatalog implements TeamProviderCatalog {
  readonly refreshes: Array<{ cwd: string; providers: string[] }> = [];
  readonly reads: CatalogRead[] = [];
  readonly models = new Map<string, AgentModelDefinition[]>();
  readonly errors = new Map<string, Error>();
  readonly createConfigErrors = new Map<string, Error>();
  readonly createConfigReads: Array<{
    cwd: string | null | undefined;
    provider: string;
    requestedMode: string | undefined;
    featureValues: Record<string, unknown> | undefined;
  }> = [];
  readonly modes = new Map<string, string[]>();
  readonly configurationReads: Array<{
    cwd?: string;
    provider: string;
    model?: string;
    modeId?: string;
    thinkingOptionId?: string;
    providerOptions?: AgentSessionConfig["providerOptions"];
  }> = [];
  readonly configurationIssues = new Map<
    string,
    Array<{ path: Array<string | number>; message: string }>
  >();
  readonly normalizedProviderOptions = new Map<string, AgentSessionConfig["providerOptions"]>();
  readonly securityPostureReads: Array<
    Parameters<TeamProviderCatalog["projectSecurityPosture"]>[0]
  > = [];

  constructor() {
    this.models.set("codex", [
      {
        provider: "codex",
        id: "gpt-5.6",
        label: "GPT-5.6",
        aliases: ["latest"],
        thinkingOptions: [{ id: "high", label: "High" }],
      },
    ]);
    this.modes.set("codex", ["workspace-write"]);
    this.modes.set("claude", []);
    this.models.set("claude", [
      { provider: "claude", id: "sonnet", label: "Sonnet", isDefault: true },
    ]);
  }

  async refreshSnapshotForCwd(input: { cwd: string; providers?: string[] }): Promise<void> {
    this.refreshes.push({ cwd: input.cwd, providers: input.providers ?? [] });
  }

  async listModels(input: {
    cwd?: string | null;
    provider: string;
    wait?: boolean;
  }): Promise<AgentModelDefinition[]> {
    this.reads.push(input);
    const error = this.errors.get(input.provider);
    if (error) throw error;
    return this.models.get(input.provider) ?? [];
  }

  async resolveCreateConfig(input: Parameters<TeamProviderCatalog["resolveCreateConfig"]>[0]) {
    this.createConfigReads.push({
      cwd: input.cwd,
      provider: input.provider,
      requestedMode: input.requestedMode,
      featureValues: input.featureValues,
    });
    const error = this.createConfigErrors.get(input.provider);
    if (error) throw error;
    if (input.requestedMode && !this.modes.get(input.provider)?.includes(input.requestedMode)) {
      throw new Error(`Invalid mode '${input.requestedMode}' for provider '${input.provider}'`);
    }
    return { modeId: input.requestedMode, featureValues: input.featureValues };
  }

  async validateAndNormalizeAgentConfiguration(input: {
    cwd?: string;
    provider: string;
    model?: string;
    modeId?: string;
    thinkingOptionId?: string;
    providerOptions?: AgentSessionConfig["providerOptions"];
  }) {
    this.configurationReads.push(input);
    const issues = this.configurationIssues.get(input.provider) ?? [];
    return {
      issues,
      providerOptions:
        issues.length === 0
          ? (this.normalizedProviderOptions.get(input.provider) ?? input.providerOptions)
          : undefined,
    };
  }

  projectSecurityPosture(input: Parameters<TeamProviderCatalog["projectSecurityPosture"]>[0]) {
    this.securityPostureReads.push(input);
    return projectUnavailableProviderSecurityPosture(input);
  }
}

class MemoryAgentProfileConfigStore {
  agentProfiles = createProfiles();

  get() {
    return { agentProfiles: this.agentProfiles };
  }
}

class MemoryFeatureCatalog implements TeamFeatureCatalog {
  readonly reads: AgentSessionConfig[] = [];
  readonly features = new Map<string, AgentFeature[]>([
    [
      "codex",
      [
        { type: "toggle", id: "fast_mode", label: "Fast", value: false },
        {
          type: "select",
          id: "approval_policy",
          label: "Approval policy",
          value: null,
          options: [
            { id: "ask", label: "Ask" },
            { id: "never", label: "Never" },
          ],
        },
      ],
    ],
    ["claude", []],
  ]);
  readonly errors = new Map<string, Error>();

  async listDraftFeatures(config: AgentSessionConfig): Promise<AgentFeature[]> {
    this.reads.push(config);
    const error = this.errors.get(config.provider);
    if (error) throw error;
    return this.features.get(config.provider) ?? [];
  }
}

class MemoryAgentStream implements TeamAgentStream {
  readonly calls: Array<{ agentId: string; prompt: AgentPromptInput }> = [];
  events: AgentStreamEvent[] = [];
  finalResponse: string | null = null;
  finalResponseReads = 0;

  async *streamAgent(agentId: string, prompt: AgentPromptInput): AsyncGenerator<AgentStreamEvent> {
    this.calls.push({ agentId, prompt });
    for (const event of this.events) yield event;
  }

  async getLastAssistantMessage(agentId: string): Promise<string | null> {
    expect(agentId).toBe(plannedAgentId);
    this.finalResponseReads += 1;
    return this.finalResponse;
  }
}

interface ExecutionHarness {
  workspaceStore: MemoryWorkspaceStore;
  providerCatalog: MemoryProviderCatalog;
  featureCatalog: MemoryFeatureCatalog;
  daemonConfigStore: MemoryAgentProfileConfigStore;
  agentStream: MemoryAgentStream;
  creations: CreateAgentFromMcpInput[];
  preflightDependencies: TeamRunPreflightDependencies;
  executionDependencies: TeamStepExecutionDependencies;
}

function createHarness(): ExecutionHarness {
  const workspaceStore = new MemoryWorkspaceStore(createWorkspace());
  const providerCatalog = new MemoryProviderCatalog();
  const featureCatalog = new MemoryFeatureCatalog();
  const daemonConfigStore = new MemoryAgentProfileConfigStore();
  const agentStream = new MemoryAgentStream();
  const creations: CreateAgentFromMcpInput[] = [];
  const preflightDependencies = {
    workspaceRegistry: workspaceStore,
    providerCatalog,
    featureCatalog,
    daemonConfigStore,
  };
  return {
    workspaceStore,
    providerCatalog,
    featureCatalog,
    daemonConfigStore,
    agentStream,
    creations,
    preflightDependencies,
    executionDependencies: {
      workspaceRegistry: workspaceStore,
      providerCatalog,
      featureCatalog,
      createAgent: async (input) => {
        creations.push(input);
      },
      agentManager: agentStream,
    },
  };
}

function createRun(
  definition: PersistedTeamDefinition,
  accepted: AcceptedTeamRunFacts,
): PersistedTeamRunRecord {
  return PersistedTeamRunRecordSchema.parse({
    id: "trun_team_test",
    teamId: definition.id,
    teamRevision: definition.revision,
    idempotencyKey: "team-start-1",
    teamSnapshot: definition,
    objective: "Ship the safe Team execution seam.",
    workspace: accepted.workspace,
    steps: accepted.steps,
    state: { status: "queued" },
    createdAt: firstTimestamp,
    updatedAt: firstTimestamp,
  });
}

async function collectEvents(
  events: AsyncIterable<TeamStepExecutionEvent>,
): Promise<TeamStepExecutionEvent[]> {
  const collected: TeamStepExecutionEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("Team Run preflight", () => {
  test("resolves host profiles and freezes their complete launch facts", async () => {
    const harness = createHarness();
    const definition = createDefinition();

    const accepted = await preflightTeamRun(harness.preflightDependencies, {
      definition,
      workspaceId: "wks_team_test",
    });

    expect(accepted.workspace).toEqual({
      workspaceId: "wks_team_test",
      projectId: "prj_team_test",
      cwd: "/repo/worktree",
      displayName: "Team workspace",
    });
    expect(accepted.steps.map((step) => step.snapshot.resolvedLaunch)).toEqual([
      {
        profileId: "profile_builder",
        provider: "codex",
        model: "gpt-5.6",
        modeId: "workspace-write",
        thinkingOptionId: "high",
        featureValues: { fast_mode: true },
        providerOptions: {
          sandbox_mode: "workspace-write",
          approval_policy: "on-request",
        },
        securityPosture: projectUnavailableProviderSecurityPosture({
          provider: "codex",
          modeId: "workspace-write",
          providerOptions: {
            sandbox_mode: "workspace-write",
            approval_policy: "on-request",
          },
        }),
      },
      {
        profileId: "profile_reviewer",
        provider: "claude",
        model: "sonnet",
        modeId: null,
        thinkingOptionId: null,
        featureValues: {},
        providerOptions: {},
        securityPosture: projectUnavailableProviderSecurityPosture({
          provider: "claude",
          modeId: null,
          providerOptions: {},
        }),
      },
    ]);
    expect(harness.providerCatalog.refreshes).toEqual([
      { cwd: "/repo/worktree", providers: ["codex", "claude"] },
    ]);
    expect(harness.providerCatalog.reads).toEqual([
      { cwd: "/repo/worktree", provider: "codex", wait: false },
      { cwd: "/repo/worktree", provider: "claude", wait: false },
    ]);
    expect(harness.providerCatalog.createConfigReads).toEqual([
      {
        cwd: "/repo/worktree",
        provider: "codex",
        requestedMode: "workspace-write",
        featureValues: { fast_mode: true },
      },
      {
        cwd: "/repo/worktree",
        provider: "claude",
        requestedMode: undefined,
        featureValues: undefined,
      },
    ]);
    expect(harness.featureCatalog.reads).toEqual([
      {
        provider: "codex",
        cwd: "/repo/worktree",
        model: "gpt-5.6",
        modeId: "workspace-write",
        thinkingOptionId: "high",
        featureValues: { fast_mode: true },
        providerOptions: {
          sandbox_mode: "workspace-write",
          approval_policy: "on-request",
        },
      },
    ]);
    expect(harness.workspaceStore.reads).toEqual(["wks_team_test", "wks_team_test"]);
  });

  test("keeps a Team visible but refuses a missing profile without fallback", async () => {
    const harness = createHarness();
    harness.daemonConfigStore.agentProfiles = [
      {
        id: "some_other_profile",
        name: "Some other profile",
        provider: "codex",
      },
    ];

    await expect(
      preflightTeamRun(harness.preflightDependencies, {
        definition: createDefinition(),
        workspaceId: "wks_team_test",
      }),
    ).rejects.toMatchObject({
      code: "team_execution_preflight_failed",
      issues: [
        {
          kind: "profile_not_found",
          roleId: "role_builder",
          profileId: "profile_builder",
        },
        {
          kind: "profile_not_found",
          roleId: "role_reviewer",
          profileId: "profile_reviewer",
        },
      ],
    });
    expect(harness.providerCatalog.refreshes).toEqual([]);
    expect(harness.providerCatalog.reads).toEqual([]);
    expect(harness.providerCatalog.createConfigReads).toEqual([]);
  });

  test("rejects provider options that are invalid for the selected Workspace launch", async () => {
    const harness = createHarness();
    harness.providerCatalog.configurationIssues.set("codex", [
      {
        path: ["providerOptions", "approval_policy"],
        message: "Invalid approval policy",
      },
    ]);

    await expect(
      preflightTeamRun(harness.preflightDependencies, {
        definition: createDefinition(),
        workspaceId: "wks_team_test",
      }),
    ).rejects.toMatchObject({
      code: "team_execution_preflight_failed",
      issues: [
        {
          kind: "launch_unavailable",
          roleId: "role_builder",
          profileId: "profile_builder",
          provider: "codex",
          message: "providerOptions.approval_policy: Invalid approval policy",
        },
      ],
    });
    expect(harness.creations).toEqual([]);
  });

  test("freezes the provider registry's normalized provider options", async () => {
    const harness = createHarness();
    harness.providerCatalog.normalizedProviderOptions.set("codex", {
      sandbox_mode: "read-only",
      approval_policy: "never",
    });

    const accepted = await preflightTeamRun(harness.preflightDependencies, {
      definition: createDefinition(),
      workspaceId: "wks_team_test",
    });

    expect(accepted.steps[0]?.snapshot.resolvedLaunch.providerOptions).toEqual({
      sandbox_mode: "read-only",
      approval_policy: "never",
    });
    expect(harness.providerCatalog.securityPostureReads[0]).toEqual({
      provider: "codex",
      modeId: "workspace-write",
      providerOptions: {
        sandbox_mode: "read-only",
        approval_policy: "never",
      },
    });
  });

  test("resolves every Team role even when the workflow does not use it", async () => {
    const harness = createHarness();
    const definition = createDefinition();
    definition.roles.push({
      id: "role_observer",
      name: "Observer",
      instructions: "Observe without joining this workflow.",
      profileId: "profile_observer",
    });

    await expect(
      preflightTeamRun(harness.preflightDependencies, {
        definition,
        workspaceId: "wks_team_test",
      }),
    ).rejects.toMatchObject({
      code: "team_execution_preflight_failed",
      issues: [
        {
          kind: "profile_not_found",
          roleId: "role_observer",
          profileId: "profile_observer",
        },
      ],
    });
    expect(harness.providerCatalog.refreshes).toEqual([]);
  });

  test("treats profile display metadata as outside Team launch ownership", async () => {
    const harness = createHarness();
    harness.daemonConfigStore.agentProfiles[0] = {
      ...harness.daemonConfigStore.agentProfiles[0]!,
      name: "   ",
    };

    const accepted = await preflightTeamRun(harness.preflightDependencies, {
      definition: createDefinition(),
      workspaceId: "wks_team_test",
    });

    expect(accepted.steps[0]!.snapshot.roleName).toBe("Builder");
    expect(accepted.steps[0]!.snapshot.resolvedLaunch).not.toHaveProperty("profileName");
  });

  test("rejects profile settings that the selected Workspace cannot launch", async () => {
    const harness = createHarness();
    harness.daemonConfigStore.agentProfiles[0] = {
      ...harness.daemonConfigStore.agentProfiles[0]!,
      modeId: "removed-mode",
    };

    await expect(
      preflightTeamRun(harness.preflightDependencies, {
        definition: createDefinition(),
        workspaceId: "wks_team_test",
      }),
    ).rejects.toMatchObject({
      code: "team_execution_preflight_failed",
      issues: [
        {
          kind: "launch_unavailable",
          roleId: "role_builder",
          profileId: "profile_builder",
          message: "Invalid mode 'removed-mode' for provider 'codex'",
        },
      ],
    });
    expect(harness.creations).toEqual([]);
  });

  test("rejects unavailable, mistyped, and invalid feature values", async () => {
    const cases: Array<{
      featureValues: Record<string, unknown>;
      message: string;
    }> = [
      {
        featureValues: { removed_feature: true },
        message: "Feature 'removed_feature' is not available for this launch",
      },
      {
        featureValues: { fast_mode: "yes" },
        message: "Feature 'fast_mode' requires a boolean value",
      },
      {
        featureValues: { approval_policy: "always" },
        message: "Feature 'approval_policy' does not support option 'always'",
      },
    ];

    for (const testCase of cases) {
      const harness = createHarness();
      harness.daemonConfigStore.agentProfiles[0] = {
        ...harness.daemonConfigStore.agentProfiles[0]!,
        featureValues: testCase.featureValues,
      };

      await expect(
        preflightTeamRun(harness.preflightDependencies, {
          definition: createDefinition(),
          workspaceId: "wks_team_test",
        }),
      ).rejects.toMatchObject({
        code: "team_execution_preflight_failed",
        issues: [
          {
            kind: "launch_unavailable",
            roleId: "role_builder",
            profileId: "profile_builder",
            message: testCase.message,
          },
        ],
      });
      expect(harness.creations).toEqual([]);
    }
  });

  test("rejects missing and archived Workspaces before catalog access", async () => {
    const definition = createDefinition();
    for (const workspace of [null, { ...createWorkspace(), archivedAt: firstTimestamp }]) {
      const harness = createHarness();
      harness.workspaceStore.workspace = workspace;

      await expect(
        preflightTeamRun(harness.preflightDependencies, {
          definition,
          workspaceId: "wks_team_test",
        }),
      ).rejects.toBeInstanceOf(TeamExecutionPreflightError);
      expect(harness.providerCatalog.refreshes).toEqual([]);
      expect(harness.providerCatalog.reads).toEqual([]);
    }
  });

  test("rejects an unavailable later role before any agent can launch", async () => {
    const harness = createHarness();
    harness.providerCatalog.errors.set("claude", new Error("Claude is unavailable"));

    await expect(
      preflightTeamRun(harness.preflightDependencies, {
        definition: createDefinition(),
        workspaceId: "wks_team_test",
      }),
    ).rejects.toMatchObject({
      code: "team_execution_preflight_failed",
      issues: [
        {
          kind: "launch_unavailable",
          roleId: "role_reviewer",
          profileId: "profile_reviewer",
          provider: "claude",
          message: "Claude is unavailable",
        },
      ],
    });
    expect(harness.creations).toEqual([]);
  });
});

describe("Team step execution", () => {
  test("revalidates Workspace placement and the accepted model before creation", async () => {
    const harness = createHarness();
    const definition = createDefinition();
    const accepted = await preflightTeamRun(harness.preflightDependencies, {
      definition,
      workspaceId: "wks_team_test",
    });
    const run = createRun(definition, accepted);
    harness.workspaceStore.workspace = { ...createWorkspace(), cwd: "/repo/moved" };

    await expect(
      collectEvents(
        executeTeamStep(harness.executionDependencies, {
          run,
          stepId: "step_build",
          plannedAgentId,
        }),
      ),
    ).rejects.toMatchObject({
      issues: [{ kind: "workspace_mismatch", fields: ["cwd"] }],
    });
    expect(harness.creations).toEqual([]);
    expect(harness.agentStream.calls).toEqual([]);

    harness.workspaceStore.workspace = createWorkspace();
    harness.providerCatalog.models.set("codex", []);
    await expect(
      collectEvents(
        executeTeamStep(harness.executionDependencies, {
          run,
          stepId: "step_build",
          plannedAgentId,
        }),
      ),
    ).rejects.toMatchObject({
      issues: [
        {
          kind: "launch_unavailable",
          roleId: "role_builder",
          profileId: "profile_builder",
          model: "gpt-5.6",
        },
      ],
    });
    expect(harness.creations).toEqual([]);
    expect(harness.agentStream.calls).toEqual([]);
  });

  test("revalidates frozen feature values before agent creation", async () => {
    const harness = createHarness();
    const definition = createDefinition();
    const accepted = await preflightTeamRun(harness.preflightDependencies, {
      definition,
      workspaceId: "wks_team_test",
    });
    const run = createRun(definition, accepted);
    harness.featureCatalog.features.set("codex", []);

    await expect(
      collectEvents(
        executeTeamStep(harness.executionDependencies, {
          run,
          stepId: "step_build",
          plannedAgentId,
        }),
      ),
    ).rejects.toMatchObject({
      issues: [
        {
          kind: "launch_unavailable",
          roleId: "role_builder",
          profileId: "profile_builder",
          message: "Feature 'fast_mode' is not available for this launch",
        },
      ],
    });
    expect(harness.creations).toEqual([]);
  });

  test("revalidates frozen provider options before agent creation", async () => {
    const harness = createHarness();
    const definition = createDefinition();
    const accepted = await preflightTeamRun(harness.preflightDependencies, {
      definition,
      workspaceId: "wks_team_test",
    });
    const run = createRun(definition, accepted);
    harness.providerCatalog.configurationIssues.set("codex", [
      {
        path: ["providerOptions", "approval_policy"],
        message: "Approval policy is no longer available",
      },
    ]);

    await expect(
      collectEvents(
        executeTeamStep(harness.executionDependencies, {
          run,
          stepId: "step_build",
          plannedAgentId,
        }),
      ),
    ).rejects.toMatchObject({
      issues: [
        {
          kind: "launch_unavailable",
          roleId: "role_builder",
          profileId: "profile_builder",
          message: "providerOptions.approval_policy: Approval policy is no longer available",
        },
      ],
    });
    expect(harness.creations).toEqual([]);
  });

  test("fails closed when the provider normalizes a frozen option differently", async () => {
    const harness = createHarness();
    const definition = createDefinition();
    const accepted = await preflightTeamRun(harness.preflightDependencies, {
      definition,
      workspaceId: "wks_team_test",
    });
    const run = createRun(definition, accepted);
    harness.providerCatalog.normalizedProviderOptions.set("codex", {
      sandbox_mode: "read-only",
      approval_policy: "never",
    });

    await expect(
      collectEvents(
        executeTeamStep(harness.executionDependencies, {
          run,
          stepId: "step_build",
          plannedAgentId,
        }),
      ),
    ).rejects.toMatchObject({
      issues: [
        {
          kind: "launch_unavailable",
          roleId: "role_builder",
          profileId: "profile_builder",
          message: "Provider 'codex' now normalizes the frozen provider options differently",
        },
      ],
    });
    expect(harness.creations).toEqual([]);
  });

  test("executes a legacy frozen launch without provider options", async () => {
    const harness = createHarness();
    const definition = createDefinition();
    const accepted = await preflightTeamRun(harness.preflightDependencies, {
      definition,
      workspaceId: "wks_team_test",
    });
    const run = createRun(definition, accepted);
    delete run.steps[0]?.snapshot.resolvedLaunch.providerOptions;
    harness.agentStream.events = [{ type: "turn_canceled", provider: "codex" }];

    await collectEvents(
      executeTeamStep(harness.executionDependencies, {
        run,
        stepId: "step_build",
        plannedAgentId,
      }),
    );

    expect(harness.creations).toHaveLength(1);
    expect(harness.creations[0]).not.toHaveProperty("config");
  });

  test("owns one stream and launches the frozen profile after that profile is deleted", async () => {
    const harness = createHarness();
    const definition = createDefinition();
    const accepted = await preflightTeamRun(harness.preflightDependencies, {
      definition,
      workspaceId: "wks_team_test",
    });
    const run = createRun(definition, accepted);
    const frozenSecurityPosture = structuredClone(
      run.steps[0]!.snapshot.resolvedLaunch.securityPosture,
    );
    const admissionProjectionCount = harness.providerCatalog.securityPostureReads.length;
    harness.daemonConfigStore.agentProfiles = [];
    harness.providerCatalog.models.set("codex", [
      {
        provider: "codex",
        id: "gpt-5.6",
        label: "GPT-5.6",
        thinkingOptions: [{ id: "high", label: "High" }],
      },
      { provider: "codex", id: "gpt-5.7", label: "GPT-5.7", aliases: ["latest"] },
    ]);
    harness.agentStream.events = [
      { type: "turn_started", provider: "codex", turnId: "turn-1" },
      {
        type: "permission_requested",
        provider: "codex",
        turnId: "turn-1",
        request: {
          id: "permission-1",
          provider: "codex",
          name: "write_file",
          kind: "tool",
        },
      },
      {
        type: "permission_resolved",
        provider: "codex",
        turnId: "turn-1",
        requestId: "permission-1",
        resolution: { behavior: "deny", message: "Not this file" },
      },
      {
        type: "timeline",
        provider: "codex",
        turnId: "turn-1",
        item: { type: "assistant_message", text: "Finished without that write." },
      },
      {
        type: "turn_completed",
        provider: "codex",
        turnId: "turn-1",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ];
    harness.agentStream.finalResponse = "Finished without that write.";

    const events = await collectEvents(
      executeTeamStep(harness.executionDependencies, {
        run,
        stepId: "step_build",
        plannedAgentId,
      }),
    );

    expect(events).toEqual([
      { type: "agent_created", agentId: plannedAgentId },
      { type: "turn_started", provider: "codex", turnId: "turn-1" },
      expect.objectContaining({
        type: "permission_requested",
        pendingPermissionCount: 1,
      }),
      expect.objectContaining({
        type: "permission_resolved",
        resolution: { behavior: "deny", message: "Not this file" },
        pendingPermissionCount: 0,
      }),
      expect.objectContaining({
        type: "turn_completed",
        finalResponse: "Finished without that write.",
      }),
    ]);
    expect(harness.agentStream.calls).toHaveLength(1);
    expect(harness.agentStream.finalResponseReads).toBe(1);
    expect(run.steps[0]!.snapshot.resolvedLaunch.securityPosture).toEqual(frozenSecurityPosture);
    expect(harness.providerCatalog.securityPostureReads).toHaveLength(admissionProjectionCount);
    expect(harness.creations).toHaveLength(1);
    expect(harness.creations[0]).toEqual({
      kind: "mcp",
      agentId: plannedAgentId,
      provider: "codex/gpt-5.6",
      cwd: "/repo/worktree",
      workspaceId: "wks_team_test",
      mode: "workspace-write",
      thinking: "high",
      features: { fast_mode: true },
      config: {
        providerOptions: {
          sandbox_mode: "workspace-write",
          approval_policy: "on-request",
        },
      },
      title: "Delivery Team: Builder",
      labels: {
        [TEAM_ID_LABEL]: "team_delivery",
        [TEAM_RUN_ID_LABEL]: "trun_team_test",
        [TEAM_ROLE_ID_LABEL]: "role_builder",
        [TEAM_STEP_ID_LABEL]: "step_build",
      },
      background: true,
      notifyOnFinish: false,
    });
    expect(harness.creations[0]?.labels).not.toHaveProperty(PARENT_AGENT_ID_LABEL);
    expect(harness.creations[0]).not.toHaveProperty("initialPrompt");
    expect(harness.creations[0]).not.toHaveProperty("callerAgentId");
  });

  test("classifies a denied permission from the eventual failed turn", async () => {
    const harness = createHarness();
    const definition = createDefinition();
    const accepted = await preflightTeamRun(harness.preflightDependencies, {
      definition,
      workspaceId: "wks_team_test",
    });
    const run = createRun(definition, accepted);
    harness.agentStream.events = [
      {
        type: "permission_requested",
        provider: "codex",
        request: { id: "permission-1", provider: "codex", name: "shell", kind: "tool" },
      },
      {
        type: "permission_resolved",
        provider: "codex",
        requestId: "permission-1",
        resolution: { behavior: "deny" },
      },
      {
        type: "turn_failed",
        provider: "codex",
        error: "Provider stopped after denial",
        code: "provider_error",
        diagnostic: "native failure",
      },
    ];

    const events = await collectEvents(
      executeTeamStep(harness.executionDependencies, {
        run,
        stepId: "step_build",
        plannedAgentId,
      }),
    );

    expect(events.at(-1)).toEqual({
      type: "turn_failed",
      provider: "codex",
      error: "Provider stopped after denial",
      code: "provider_error",
      diagnostic: "native failure",
    });
    expect(harness.agentStream.finalResponseReads).toBe(0);
  });

  test("rejects a stream that ends without a terminal event", async () => {
    const harness = createHarness();
    const definition = createDefinition();
    const accepted = await preflightTeamRun(harness.preflightDependencies, {
      definition,
      workspaceId: "wks_team_test",
    });
    harness.agentStream.events = [{ type: "turn_started", provider: "codex" }];

    await expect(
      collectEvents(
        executeTeamStep(harness.executionDependencies, {
          run: createRun(definition, accepted),
          stepId: "step_build",
          plannedAgentId,
        }),
      ),
    ).rejects.toBeInstanceOf(TeamStepStreamEndedError);
  });
});

describe("Team step prompt", () => {
  test("truncates a multi-byte handoff without splitting a code point", () => {
    const handoff = createTeamHandoff(`${"a".repeat(4095)}🙂tail`);

    expect(handoff).toMatchObject({
      includedBytes: 4095,
      truncated: true,
    });
    expect(handoff.originalBytes).toBeGreaterThan(4096);
    expect(Buffer.byteLength(handoff.text, "utf8")).toBeLessThanOrEqual(4096);
    expect(handoff.text).not.toContain("�");
  });

  test("orders sections and marks an empty previous response explicitly", () => {
    const definition = createDefinition();
    const role = definition.roles[0]!;
    const step = {
      stepId: "step_build",
      roleId: role.id,
      roleName: role.name,
      roleInstructions: role.instructions,
      stepInstructions: null,
      resolvedLaunch: {
        profileId: role.profileId,
        provider: "codex",
        model: "gpt-5.6",
        modeId: "workspace-write",
        thinkingOptionId: "high",
        featureValues: { fast_mode: true },
      },
    };
    const withoutHandoff = composeTeamStepPrompt({
      teamName: definition.name,
      teamInstructions: definition.instructions,
      step,
      objective: "Ship it.",
    });
    const withEmptyHandoff = composeTeamStepPrompt({
      teamName: definition.name,
      teamInstructions: definition.instructions,
      step,
      objective: "Ship it.",
      previousFinalResponse: "",
    });

    expect(withoutHandoff.indexOf("## Team")).toBeLessThan(withoutHandoff.indexOf("## Role"));
    expect(withoutHandoff.indexOf("## Role")).toBeLessThan(withoutHandoff.indexOf("## Objective"));
    expect(withoutHandoff).not.toContain("Previous step final response");
    expect(withEmptyHandoff).toContain("[empty final response]");
    expect(withEmptyHandoff).toContain(
      "Metadata: truncated=false; originalBytes=0; includedBytes=0",
    );
  });
});
