import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentProfile } from "@getpaseo/protocol/messages";
import pino from "pino";
import { expect, test } from "vitest";

import type {
  AgentClient,
  AgentCreateSessionOptions,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentResumeSessionOptions,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  FetchCatalogOptions,
  ProviderCatalog,
  ProviderRefreshContext,
} from "../agent/agent-sdk-types.js";
import { CodexAppServerAgentClient } from "../agent/providers/codex-app-server-agent.js";
import { CODEX_AGENT_PROFILE_SECURITY_PRESETS } from "../agent/providers/codex/security-controls.js";
import { DaemonClient, createTestPaseoDaemon } from "../test-utils/index.js";

const PASSWORD_HASH = "$2b$12$GMhF7pN4QnMlHOQXOqjd1OitKWPSmAO3FwB0PHzKtcZR/sAMryz76";
const PASSWORD = "shared-secret";
const REAL_SUPERVISED_TIMEOUT_MS = 600_000;

const readOnlyProviderOptions = securityPreset("fail-closed-read-only");
const workspaceWriteProviderOptions = securityPreset("fail-closed-workspace-write");

const profiles = [
  {
    id: "proof-supervisor",
    name: "Proof Supervisor",
    provider: "codex",
    model: "gpt-5.4",
    modeId: "auto",
    thinkingOptionId: "low",
    providerOptions: readOnlyProviderOptions,
  },
  {
    id: "proof-planner",
    name: "Proof Planner",
    provider: "codex",
    model: "gpt-5.4",
    modeId: "auto",
    thinkingOptionId: "low",
    providerOptions: readOnlyProviderOptions,
  },
  {
    id: "proof-builder",
    name: "Proof Builder",
    provider: "codex",
    model: "gpt-5.4",
    modeId: "auto",
    thinkingOptionId: "low",
    providerOptions: workspaceWriteProviderOptions,
  },
  {
    id: "proof-reviewer",
    name: "Proof Reviewer",
    provider: "codex",
    model: "gpt-5.4",
    modeId: "auto",
    thinkingOptionId: "low",
    providerOptions: readOnlyProviderOptions,
  },
] satisfies AgentProfile[];

test(
  "proves a real Codex supervised Plan to Implement to Review run",
  async () => {
    const logger = pino({ level: "silent" });
    const temporaryDirectories: string[] = [];
    const paseoHomeRoot = await trackedTemporaryDirectory(
      temporaryDirectories,
      "paseo-supervised-real-home-",
    );
    const staticDir = await trackedTemporaryDirectory(
      temporaryDirectories,
      "paseo-supervised-real-static-",
    );
    const workspaceRoot = await trackedTemporaryDirectory(
      temporaryDirectories,
      "paseo-supervised-real-workspace-",
    );
    const implementationFile = path.join(workspaceRoot, "supervised-proof.txt");
    const implementationCommand = `printf 'REAL_SUPERVISED_IMPLEMENTATION' > '${implementationFile}'`;
    const planToken = "REAL_SUPERVISED_PLAN_TOKEN_7ce54f";
    const implementationToken = "REAL_SUPERVISED_IMPLEMENT_TOKEN_30b9d1";
    const realCodex = new RecordingGateAgentClient(new CodexAppServerAgentClient(logger));
    const daemon = await createTestPaseoDaemon({
      paseoHomeRoot,
      staticDir,
      cleanup: false,
      logger,
      agentClients: { codex: realCodex },
      agentProfiles: profiles,
      auth: { password: PASSWORD_HASH },
    });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      password: PASSWORD,
      appVersion: "0.7.2",
    });
    const streamEvents = new Map<string, AgentStreamEvent[]>();
    const unsubscribe = daemon.daemon.agentManager.subscribe(
      (event) => {
        if (event.type !== "agent_stream") return;
        const events = streamEvents.get(event.agentId) ?? [];
        events.push(event.event);
        streamEvents.set(event.agentId, events);
      },
      { replayState: false },
    );

    try {
      await client.connect();
      expect(client.getLastServerInfoMessage()?.features).toMatchObject({
        assignments: true,
        teams: true,
        teamSupervision: true,
        teamSupervisionAdmission: "available",
      });
      const createdWorkspace = await client.createWorkspace({
        source: { kind: "directory", path: workspaceRoot },
      });
      if (!createdWorkspace.workspace) {
        throw new Error(createdWorkspace.error ?? "Failed to create proof Workspace");
      }
      const { team } = await client.createTeam({
        name: "Real Codex Supervised Proof",
        instructions:
          "Execute the frozen Plan, Implement, and Review templates in order using exact immutable Artifact handoffs.",
        roles: [
          {
            id: "supervisor",
            name: "Supervisor",
            profileId: "proof-supervisor",
            instructions: [
              "Run this deterministic proof without delegation, escalation, or revision.",
              "If there is no plan, return a plan action with actionId action_plan and exactly these work items in order:",
              "work_plan mapped to plan; work_implement mapped to implement; work_review mapped to review.",
              "Otherwise dispatch the first planned work item with actionId action_dispatch_<workItemId> and exactly the accepted predecessor Artifact IDs required by the decision rules.",
              "When every work item has succeeded, return complete with actionId action_complete.",
            ].join("\n"),
          },
          {
            id: "planner",
            name: "Planner",
            profileId: "proof-planner",
            instructions: [
              "Try to use collaboration.spawn_agent once.",
              "If that tool is unavailable, do not use shell commands or MCP tools.",
              "Respond with exactly these two lines:",
              "DELEGATION_UNAVAILABLE",
              planToken,
            ].join("\n"),
          },
          {
            id: "builder",
            name: "Builder",
            profileId: "proof-builder",
            instructions: [
              `Copy the exact input line ${planToken}.`,
              "Invoke exec_command exactly once with this exact command:",
              implementationCommand,
              "Wait for the tool result, then respond with exactly these two lines:",
              planToken,
              implementationToken,
            ].join("\n"),
          },
          {
            id: "reviewer",
            name: "Reviewer",
            profileId: "proof-reviewer",
            instructions: [
              `Copy the exact input line ${implementationToken}.`,
              "Do not use tools.",
              "Respond with exactly these two lines:",
              "REAL_SUPERVISED_REVIEW_APPROVED",
              implementationToken,
            ].join("\n"),
          },
        ],
        workflow: [
          { id: "plan", roleId: "planner", instructions: null },
          { id: "implement", roleId: "builder", instructions: null },
          { id: "review", roleId: "reviewer", instructions: null },
        ],
      });
      const { assignment } = await client.createAssignment({
        title: "Real provider supervised proof",
        objective:
          "Complete the frozen Plan, Implement, and Review workflow without recursive delegation.",
        workItem: null,
      });
      const { run: started } = await client.startAssignmentTeamRun({
        teamId: team.id,
        expectedRevision: team.revision,
        idempotencyKey: "real-codex-supervised-proof",
        assignmentId: assignment.id,
        expectedAssignmentRevision: assignment.revision,
        workspaceId: createdWorkspace.workspace.id,
        supervision: { supervisorRoleId: "supervisor" },
      });

      await withTimeout(realCodex.waitForFirstCreation(), 60_000, "real supervised agent creation");
      await client.patchDaemonConfig({ agentProfiles: [] });
      realCodex.releaseFirstCreation();

      await daemon.daemon.teamRunService.waitForRun(started.id);
      const { run: completed } = await client.getTeamRun(started.id);
      if (completed.state.status !== "succeeded") {
        emitDiagnostic(completed, streamEvents);
      }
      expect(completed.state.status).toBe("succeeded");
      expect(readFileSync(implementationFile, "utf8")).toBe("REAL_SUPERVISED_IMPLEMENTATION");

      const persisted = await daemon.daemon.teamRepository.getRun(completed.id);
      if (!persisted?.supervision) throw new Error("Completed run lost supervised state");
      expect(persisted.supervision.decisions.map((decision) => decision.kind)).toEqual([
        "plan",
        "dispatch",
        "dispatch",
        "dispatch",
        "complete",
      ]);
      expect(persisted.supervision.supervisor.resolvedLaunch.providerOptions).toEqual(
        readOnlyProviderOptions,
      );
      expect(
        persisted.supervision.workerTemplates.map(
          (template) => template.resolvedLaunch.providerOptions,
        ),
      ).toEqual([readOnlyProviderOptions, workspaceWriteProviderOptions, readOnlyProviderOptions]);

      const workerSteps = persisted.steps.filter(
        (step) => step.snapshot.supervision?.kind === "worker",
      );
      expect(workerSteps).toHaveLength(3);
      const [planStep, implementationStep, reviewStep] = workerSteps;
      if (!planStep || !implementationStep || !reviewStep) {
        throw new Error("Real supervised proof has incomplete worker history");
      }
      const planArtifactId = requireOutputArtifactId(planStep);
      const implementationArtifactId = requireOutputArtifactId(implementationStep);
      expect(workerSteps.map((step) => step.snapshot.inputArtifactIds)).toEqual([
        [],
        [planArtifactId],
        [planArtifactId, implementationArtifactId],
      ]);

      const { artifacts } = await client.listAssignmentArtifacts({
        assignmentId: assignment.id,
        limit: 100,
      });
      const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
      expect(artifacts).toHaveLength(3);
      expect(artifactsById.get(planArtifactId)?.content).toContain("DELEGATION_UNAVAILABLE");
      expect(artifactsById.get(planArtifactId)?.content).toContain(planToken);
      expect(artifactsById.get(implementationArtifactId)?.content).toContain(planToken);
      expect(artifactsById.get(implementationArtifactId)?.content).toContain(implementationToken);
      expect(artifactsById.get(requireOutputArtifactId(reviewStep))?.content).toContain(
        "REAL_SUPERVISED_REVIEW_APPROVED",
      );
      expect(artifactsById.get(requireOutputArtifactId(reviewStep))?.content).toContain(
        implementationToken,
      );

      const workerAgentIds = workerSteps.map(requireCompletedAgentId);
      const planEvents = streamEvents.get(workerAgentIds[0]!) ?? [];
      expect(
        planEvents.some(
          (event) =>
            event.type === "timeline" &&
            event.item.type === "tool_call" &&
            event.item.detail.type === "sub_agent",
        ),
      ).toBe(false);
      expect(realCodex.createdConfigs.map((config) => config.providerOptions)).toEqual([
        readOnlyProviderOptions,
        readOnlyProviderOptions,
        workspaceWriteProviderOptions,
        readOnlyProviderOptions,
      ]);
      expect(
        realCodex.createdConfigs.every(
          (config) =>
            (config.providerOptions as { features?: { multi_agent_v2?: boolean } } | undefined)
              ?.features?.multi_agent_v2 === false,
        ),
      ).toBe(true);
      expect(existsSync(implementationFile)).toBe(true);

      emitEvidence({
        runId: completed.id,
        provider: "codex",
        host: { platform: process.platform, arch: process.arch },
        decisionKinds: persisted.supervision.decisions.map((decision) => decision.kind),
        artifactFlow: workerSteps.map((step) => ({
          roleId: step.snapshot.roleId,
          inputArtifactIds: step.snapshot.inputArtifactIds,
          outputArtifactId: step.snapshot.outputArtifact?.id,
        })),
        profileOptionsFrozenAfterCatalogRemoval: true,
        recursiveDelegationEnabled: false,
        workspaceWriteObserved: existsSync(implementationFile),
      });
    } finally {
      realCodex.releaseFirstCreation();
      unsubscribe();
      await client.close().catch(() => undefined);
      await daemon.close();
      await Promise.all(
        temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
      );
    }
  },
  REAL_SUPERVISED_TIMEOUT_MS,
);

class RecordingGateAgentClient implements AgentClient {
  readonly provider: AgentClient["provider"];
  readonly capabilities: AgentClient["capabilities"];
  readonly createdConfigs: AgentSessionConfig[] = [];
  private firstCreationReleased = false;
  private readonly firstCreationObserved: Promise<void>;
  private resolveFirstCreationObserved!: () => void;
  private readonly firstCreationGate: Promise<void>;
  private resolveFirstCreationGate!: () => void;

  constructor(private readonly inner: AgentClient) {
    this.provider = inner.provider;
    this.capabilities = inner.capabilities;
    this.firstCreationObserved = new Promise((resolve) => {
      this.resolveFirstCreationObserved = resolve;
    });
    this.firstCreationGate = new Promise((resolve) => {
      this.resolveFirstCreationGate = resolve;
    });
  }

  async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    this.createdConfigs.push(structuredClone(config));
    if (this.createdConfigs.length === 1) {
      this.resolveFirstCreationObserved();
      await this.firstCreationGate;
    }
    return this.inner.createSession(config, launchContext, options);
  }

  resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
    options?: AgentResumeSessionOptions,
  ): Promise<AgentSession> {
    return this.inner.resumeSession(handle, overrides, launchContext, options);
  }

  fetchCatalog(
    options: FetchCatalogOptions,
    context?: ProviderRefreshContext,
  ): Promise<ProviderCatalog> {
    return this.inner.fetchCatalog(options, context);
  }

  isAvailable(signal?: AbortSignal): Promise<boolean> {
    return this.inner.isAvailable(signal);
  }

  waitForFirstCreation(): Promise<void> {
    return this.firstCreationObserved;
  }

  releaseFirstCreation(): void {
    if (this.firstCreationReleased) return;
    this.firstCreationReleased = true;
    this.resolveFirstCreationGate();
  }

  shutdown(): Promise<void> | undefined {
    return this.inner.shutdown?.();
  }
}

function requireCompletedAgentId(step: {
  snapshot: { stepId: string };
  state: { agentId?: string | null };
}): string {
  if (!("agentId" in step.state) || !step.state.agentId) {
    throw new Error(`Completed worker ${step.snapshot.stepId} has no agent`);
  }
  return step.state.agentId;
}

function requireOutputArtifactId(step: {
  snapshot: { stepId: string; outputArtifact?: { id: string } | null };
}): string {
  const artifactId = step.snapshot.outputArtifact?.id;
  if (!artifactId) throw new Error(`Completed worker ${step.snapshot.stepId} has no Artifact`);
  return artifactId;
}

function securityPreset(id: string): Record<string, unknown> {
  const preset = CODEX_AGENT_PROFILE_SECURITY_PRESETS.find((candidate) => candidate.id === id);
  if (!preset) throw new Error(`Missing Codex security preset ${id}`);
  return structuredClone(preset.providerOptions);
}

function emitEvidence(evidence: unknown): void {
  console.log(`TEAM_SUPERVISED_REAL_EVIDENCE ${JSON.stringify(evidence)}`);
}

function emitDiagnostic(
  run: Awaited<ReturnType<DaemonClient["getTeamRun"]>>["run"],
  streamEvents: Map<string, AgentStreamEvent[]>,
): void {
  console.log(
    `TEAM_SUPERVISED_REAL_DIAGNOSTIC ${JSON.stringify({
      run,
      agentEvents: [...streamEvents.entries()].map(([agentId, events]) => ({
        agentId,
        eventTypes: events.map((event) =>
          event.type === "timeline" ? `timeline:${event.item.type}` : event.type,
        ),
      })),
    })}`,
  );
}

async function trackedTemporaryDirectory(directories: string[], prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
