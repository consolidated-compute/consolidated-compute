import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import type { AgentPromptInput } from "../agent/agent-sdk-types.js";
import { DaemonClient } from "../test-utils/index.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

test("runs Plan, Implement, and Review through existing Paseo Agent Profiles", async () => {
  const prompts: AgentPromptInput[] = [];
  const cwd = await mkdtemp(join(tmpdir(), "paseo-team-profiles-"));
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      onStartTurn: (prompt) => prompts.push(prompt),
    }),
    agentProfiles: [
      {
        id: "architect",
        name: "Architect",
        provider: "codex",
        model: "gpt-5.4-mini",
        modeId: "full-access",
      },
      {
        id: "codex-builder",
        name: "Codex Builder",
        provider: "codex",
        model: "gpt-5.4-mini",
        modeId: "full-access",
        featureValues: { test_feature: true },
        providerOptions: {
          sandbox_mode: "workspace-write",
          approval_policy: "never",
        },
      },
      {
        id: "security-review",
        name: "Security Review",
        provider: "claude",
        model: "sonnet",
        modeId: "full-access",
      },
    ],
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.6.0",
  });

  try {
    await client.connect();
    expect(client.getLastServerInfoMessage()?.features).toMatchObject({
      agentProfiles: true,
      teams: true,
    });
    const createdWorkspace = await client.createWorkspace({
      source: { kind: "directory", path: cwd },
    });
    if (!createdWorkspace.workspace) {
      throw new Error(createdWorkspace.error ?? "Failed to create Team test Workspace");
    }

    const { team: definition } = await client.createTeam({
      name: "Delivery Team",
      instructions: "Complete the objective in order.",
      roles: [
        {
          id: "planner",
          name: "Planner",
          instructions: "Respond with exactly: PLAN_OK",
          profileId: "architect",
        },
        {
          id: "builder",
          name: "Builder",
          instructions: "Respond with exactly: IMPLEMENT_OK",
          profileId: "codex-builder",
        },
        {
          id: "reviewer",
          name: "Reviewer",
          instructions: "Respond with exactly: REVIEW_OK",
          profileId: "security-review",
        },
      ],
      workflow: [
        { id: "plan", roleId: "planner", instructions: null },
        { id: "implement", roleId: "builder", instructions: null },
        { id: "review", roleId: "reviewer", instructions: null },
      ],
    });

    const { run: started } = await client.startTeamRun({
      teamId: definition.id,
      expectedRevision: definition.revision,
      idempotencyKey: "plan-implement-review",
      objective: "Prove the Team execution boundary.",
      workspaceId: createdWorkspace.workspace.id,
    });
    await daemon.daemon.teamRunService.waitForRun(started.id);
    const { run: completed } = await client.getTeamRun(started.id);

    const { run: retried } = await client.startTeamRun({
      teamId: definition.id,
      expectedRevision: definition.revision,
      idempotencyKey: "plan-implement-review",
      objective: "Prove the Team execution boundary.",
      workspaceId: createdWorkspace.workspace.id,
    });
    expect(retried.id).toBe(started.id);

    expect(completed.state.status).toBe("succeeded");
    expect(completed.steps.map((step) => step.snapshot.resolvedLaunch)).toEqual([
      {
        profileId: "architect",
        provider: "codex",
        model: "gpt-5.4-mini",
        modeId: "full-access",
        thinkingOptionId: null,
        featureValues: {},
      },
      {
        profileId: "codex-builder",
        provider: "codex",
        model: "gpt-5.4-mini",
        modeId: "full-access",
        thinkingOptionId: null,
        featureValues: { test_feature: true },
      },
      {
        profileId: "security-review",
        provider: "claude",
        model: "sonnet",
        modeId: "full-access",
        thinkingOptionId: null,
        featureValues: {},
      },
    ]);
    const persisted = await daemon.daemon.teamRepository.getRun(started.id);
    expect(persisted?.steps.map((step) => step.snapshot.resolvedLaunch.providerOptions)).toEqual([
      {},
      { sandbox_mode: "workspace-write", approval_policy: "never" },
      {},
    ]);
    expect(prompts).toHaveLength(3);
    expect(prompts.every((prompt) => typeof prompt === "string")).toBe(true);
    const [planPrompt, implementPrompt, reviewPrompt] = prompts as string[];
    expect(planPrompt).toContain("Respond with exactly: PLAN_OK");
    expect(planPrompt).not.toContain("Previous step final response");
    expect(implementPrompt).toContain("Respond with exactly: IMPLEMENT_OK");
    expect(implementPrompt).toContain("<untrusted-previous-step-response>\nPLAN_OK");
    expect(reviewPrompt).toContain("Respond with exactly: REVIEW_OK");
    expect(reviewPrompt).toContain("<untrusted-previous-step-response>\nIMPLEMENT_OK");
    expect(reviewPrompt).not.toContain("\nPLAN_OK\n");

    const agentIds = completed.steps.map((step) => {
      if (!("agentId" in step.state) || step.state.agentId === null) {
        throw new Error(`Completed Team step ${step.snapshot.stepId} has no agent`);
      }
      return step.state.agentId;
    });
    const agents = await Promise.all(agentIds.map((agentId) => client.fetchAgent({ agentId })));
    expect(agents.map((entry) => entry?.agent.provider)).toEqual(["codex", "codex", "claude"]);
    expect(agents.map((entry) => entry?.agent.model)).toEqual([
      "gpt-5.4-mini",
      "gpt-5.4-mini",
      "sonnet",
    ]);
    expect(
      agentIds.map(
        (agentId) => daemon.daemon.agentManager.getAgent(agentId)?.config.providerOptions,
      ),
    ).toEqual([
      undefined,
      { sandbox_mode: "workspace-write", approval_policy: "never" },
      undefined,
    ]);
    expect(agents.map((entry) => entry?.agent.currentModeId)).toEqual([
      "full-access",
      "full-access",
      "full-access",
    ]);
    expect(agents[1]?.agent.features).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "test_feature", value: true })]),
    );
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
}, 180_000);
