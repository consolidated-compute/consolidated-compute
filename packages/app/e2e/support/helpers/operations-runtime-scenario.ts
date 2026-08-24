import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import type { Page } from "@playwright/test";
import { getE2EDaemonPort } from "./daemon-port";
import { startIsolatedHostDaemon, type IsolatedHostDaemon } from "./isolated-host-daemon";
import {
  installOperationsHostFixture,
  type OperationsHostFixture,
} from "./operations-host-fixture";
import { seedWorkspace, type SeededWorkspace } from "./seed-client";
import { getServerId } from "./server-id";
import {
  seedParentWithCrossWorkspaceSubagent,
  seedParentWithSubagent,
  type SeededCrossWorkspaceSubagentPair,
  type SeededSubagentPair,
} from "./subagents";

export const OPERATIONS_RUNTIME_NODE_COUNT = 15;

interface SeededAgent {
  id: string;
}

export interface OperationsRuntimeScenario {
  primaryServerId: string;
  primaryHostLabel: string;
  secondaryHostLabel: string;
  primary: SeededWorkspace;
  secondary: SeededWorkspace;
  secondaryDaemon: IsolatedHostDaemon;
  sameWorkspace: SeededSubagentPair;
  crossWorkspace: SeededCrossWorkspaceSubagentPair;
  secondaryAgent: SeededAgent;
  reviewAgent: SeededAgent;
  questionAgent: SeededAgent;
  duplicateProviderSubagentId: string;
  primaryFixture: OperationsHostFixture;
  secondaryFixture: OperationsHostFixture;
  cleanup(): Promise<void>;
}

function providerSubagent(
  input: Pick<
    ProviderSubagentDescriptorPayload,
    "id" | "parentAgentId" | "provider" | "description" | "status" | "subtitle"
  >,
  now: string,
): ProviderSubagentDescriptorPayload {
  return {
    ...input,
    title: null,
    createdAt: now,
    updatedAt: now,
    toolCallId: `${input.id}-call`,
  };
}

export async function seedOperationsRuntimeScenario(
  page: Page,
  input: {
    prefix: string;
    primaryWorkspaceTitle: string;
    secondaryWorkspaceTitle: string;
    primaryHostLabel: string;
    secondaryHostLabel: string;
  },
): Promise<OperationsRuntimeScenario> {
  const primaryServerId = getServerId();
  const primary = await seedWorkspace({
    repoPrefix: `${input.prefix}-primary-`,
    title: input.primaryWorkspaceTitle,
  });
  let secondaryDaemon: IsolatedHostDaemon | null = null;
  let secondary: SeededWorkspace | null = null;

  try {
    secondaryDaemon = await startIsolatedHostDaemon(`${input.prefix}-secondary`);
    secondary = await seedWorkspace({
      repoPrefix: `${input.prefix}-secondary-`,
      title: input.secondaryWorkspaceTitle,
      port: secondaryDaemon.port,
    });

    const sameWorkspace = await seedParentWithSubagent(primary, {
      parentTitle: "Primary parent",
      childTitle: "Nested helper",
    });
    const crossWorkspace = await seedParentWithCrossWorkspaceSubagent(primary, {
      parentTitle: "Release parent",
      childTitle: "Cross-workspace helper",
    });
    const secondaryAgent = await secondary.client.createAgent({
      provider: "mock",
      cwd: secondary.repoPath,
      workspaceId: secondary.workspaceId,
      title: "Secondary host worker",
      modeId: "load-test",
      model: "five-minute-stream",
      initialPrompt: "stay running",
    });
    await secondary.client.waitForAgentUpsert(
      secondaryAgent.id,
      (snapshot) => snapshot.status === "running",
      15_000,
    );

    const reviewAgent = await primary.client.createAgent({
      provider: "mock",
      cwd: primary.repoPath,
      workspaceId: primary.workspaceId,
      title: "Completed work to review",
      modeId: "load-test",
      model: "ten-second-stream",
      featureValues: { mockAssistantResponse: "Ready for review." },
      initialPrompt: "Complete this work for review.",
    });
    const completedReview = await primary.client.waitForFinish(reviewAgent.id, 15_000);
    if (completedReview.status !== "idle") {
      throw new Error(`Expected the review agent to finish idle, got ${completedReview.status}`);
    }

    const questionAgent = await primary.client.createAgent({
      provider: "mock",
      cwd: primary.repoPath,
      workspaceId: primary.workspaceId,
      title: "Question needs input",
      modeId: "load-test",
      model: "ten-second-stream",
      initialPrompt: "Emit synthetic questions.",
    });
    const parkedQuestion = await primary.client.waitForFinish(questionAgent.id, 15_000);
    if (parkedQuestion.status !== "permission") {
      throw new Error(`Expected the question agent to need input, got ${parkedQuestion.status}`);
    }

    const now = new Date().toISOString();
    const duplicateProviderSubagentId = "duplicate-provider-child";
    const primaryFixture = await installOperationsHostFixture(page, {
      port: getE2EDaemonPort(),
      providerSubagents: [
        providerSubagent(
          {
            id: duplicateProviderSubagentId,
            parentAgentId: sameWorkspace.parent.id,
            provider: "codex",
            description: "Review the primary host changes",
            status: "failed",
            subtitle: "Primary host native child",
          },
          now,
        ),
        providerSubagent(
          {
            id: "primary-running-provider",
            parentAgentId: sameWorkspace.parent.id,
            provider: "codex",
            description: "Coordinate active primary work",
            status: "running",
            subtitle: "Live provider child",
          },
          now,
        ),
        providerSubagent(
          {
            id: "primary-completed-provider",
            parentAgentId: sameWorkspace.parent.id,
            provider: "claude",
            description: "Completed primary analysis",
            status: "completed",
            subtitle: "Finished provider child",
          },
          now,
        ),
        providerSubagent(
          {
            id: "primary-canceled-provider",
            parentAgentId: sameWorkspace.parent.id,
            provider: "codex",
            description: "Canceled primary exploration",
            status: "canceled",
            subtitle: "Stopped provider child",
          },
          now,
        ),
      ],
    });
    const secondaryFixture = await installOperationsHostFixture(page, {
      port: secondaryDaemon.port,
      providerSubagents: [
        providerSubagent(
          {
            id: duplicateProviderSubagentId,
            parentAgentId: secondaryAgent.id,
            provider: "claude",
            description: "Inspect the secondary host",
            status: "completed",
            subtitle: "Secondary host native child",
          },
          now,
        ),
        providerSubagent(
          {
            id: "secondary-running-provider",
            parentAgentId: secondaryAgent.id,
            provider: "claude",
            description: "Coordinate active secondary work",
            status: "running",
            subtitle: "Live provider child",
          },
          now,
        ),
        providerSubagent(
          {
            id: "secondary-completed-provider",
            parentAgentId: secondaryAgent.id,
            provider: "codex",
            description: "Completed secondary analysis",
            status: "completed",
            subtitle: "Finished provider child",
          },
          now,
        ),
        providerSubagent(
          {
            id: "secondary-failed-provider",
            parentAgentId: secondaryAgent.id,
            provider: "claude",
            description: "Failed secondary verification",
            status: "failed",
            subtitle: "Failed provider child",
          },
          now,
        ),
      ],
    });

    const seededSecondary = secondary;
    const seededSecondaryDaemon = secondaryDaemon;
    return {
      primaryServerId,
      primaryHostLabel: input.primaryHostLabel,
      secondaryHostLabel: input.secondaryHostLabel,
      primary,
      secondary: seededSecondary,
      secondaryDaemon: seededSecondaryDaemon,
      sameWorkspace,
      crossWorkspace,
      secondaryAgent,
      reviewAgent,
      questionAgent,
      duplicateProviderSubagentId,
      primaryFixture,
      secondaryFixture,
      cleanup: async () => {
        await seededSecondary.cleanup().catch(() => undefined);
        await seededSecondaryDaemon.close().catch(() => undefined);
        await primary.cleanup().catch(() => undefined);
      },
    };
  } catch (error) {
    await secondary?.cleanup().catch(() => undefined);
    await secondaryDaemon?.close().catch(() => undefined);
    await primary.cleanup().catch(() => undefined);
    throw error;
  }
}
