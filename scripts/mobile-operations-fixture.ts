import { once } from "node:events";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import {
  startIsolatedHostDaemon,
  type IsolatedHostDaemon,
} from "../packages/app/e2e/support/helpers/isolated-host-daemon.js";
import {
  mockProviderSubagentFeatureValue,
  OPERATIONS_DUPLICATE_PROVIDER_SUBAGENT_ID,
  OPERATIONS_PRIMARY_PROVIDER_SUBAGENTS,
  OPERATIONS_SECONDARY_PROVIDER_SUBAGENTS,
} from "../packages/app/e2e/support/helpers/operations-scenario-data.js";
import {
  seedWorkspace,
  type SeededWorkspace,
} from "../packages/app/e2e/support/helpers/seed-client.js";
import { seedParentWithCrossWorkspaceSubagent } from "../packages/app/e2e/support/helpers/subagents.js";

const PRIMARY_SERVER_ID = "srv_mobile_operations_primary";
const SECONDARY_SERVER_ID = "srv_mobile_operations_secondary";

async function main(): Promise<void> {
  const primaryDaemon = await startIsolatedHostDaemon(PRIMARY_SERVER_ID);
  let secondaryDaemon: IsolatedHostDaemon | null = null;
  let primary: SeededWorkspace | null = null;
  let secondary: SeededWorkspace | null = null;

  try {
    secondaryDaemon = await startIsolatedHostDaemon(SECONDARY_SERVER_ID);
    primary = await seedWorkspace({
      repoPrefix: "paseo-mobile-operations-primary-",
      title: "Mobile Operations Primary",
      port: primaryDaemon.port,
    });
    secondary = await seedWorkspace({
      repoPrefix: "paseo-mobile-operations-secondary-",
      title: "Mobile Operations Secondary",
      port: secondaryDaemon.port,
    });
    const primaryParent = await primary.client.createAgent({
      provider: "mock",
      cwd: primary.repoPath,
      workspaceId: primary.workspaceId,
      title: "Primary parent",
      modeId: "load-test",
      model: "five-minute-stream",
      featureValues: {
        mockProviderSubagents: mockProviderSubagentFeatureValue(
          OPERATIONS_PRIMARY_PROVIDER_SUBAGENTS,
        ),
      },
      initialPrompt: "stay running",
    });
    await primary.client.waitForAgentUpsert(
      primaryParent.id,
      (snapshot) => snapshot.status === "running",
      15_000,
    );
    const nestedChild = await primary.client.createAgent({
      provider: "mock",
      cwd: primary.repoPath,
      workspaceId: primary.workspaceId,
      title: "Nested helper",
      modeId: "load-test",
      model: "ten-second-stream",
      labels: { [PARENT_AGENT_ID_LABEL]: primaryParent.id },
    });
    const crossWorkspace = await seedParentWithCrossWorkspaceSubagent(primary, {
      parentTitle: "Release parent",
      childTitle: "Cross-workspace helper",
    });
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
    await primary.client.waitForFinish(reviewAgent.id, 15_000);
    const questionAgent = await primary.client.createAgent({
      provider: "mock",
      cwd: primary.repoPath,
      workspaceId: primary.workspaceId,
      title: "Question needs input",
      modeId: "load-test",
      model: "ten-second-stream",
      initialPrompt: "Emit synthetic questions.",
    });
    await primary.client.waitForFinish(questionAgent.id, 15_000);

    const secondaryAgent = await secondary.client.createAgent({
      provider: "mock",
      cwd: secondary.repoPath,
      workspaceId: secondary.workspaceId,
      title: "Secondary host worker",
      modeId: "load-test",
      model: "five-minute-stream",
      featureValues: {
        mockProviderSubagents: mockProviderSubagentFeatureValue(
          OPERATIONS_SECONDARY_PROVIDER_SUBAGENTS,
        ),
      },
      initialPrompt: "stay running",
    });
    await secondary.client.waitForAgentUpsert(
      secondaryAgent.id,
      (snapshot) => snapshot.status === "running",
      15_000,
    );

    process.stdout.write(
      `PASEO_MOBILE_OPERATIONS_FIXTURE=${JSON.stringify({
        primary: {
          serverId: PRIMARY_SERVER_ID,
          port: primaryDaemon.port,
          workspaceId: primary.workspaceId,
          parentAgentId: primaryParent.id,
          nestedAgentId: nestedChild.id,
          crossWorkspaceAgentId: crossWorkspace.child.id,
          reviewAgentId: reviewAgent.id,
          questionAgentId: questionAgent.id,
          providerSubagentId: OPERATIONS_DUPLICATE_PROVIDER_SUBAGENT_ID,
        },
        secondary: {
          serverId: SECONDARY_SERVER_ID,
          port: secondaryDaemon.port,
          workspaceId: secondary.workspaceId,
          agentId: secondaryAgent.id,
          providerSubagentId: OPERATIONS_DUPLICATE_PROVIDER_SUBAGENT_ID,
        },
      })}\n`,
    );
    await Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]);
  } finally {
    await Promise.allSettled([
      primary?.cleanup() ?? Promise.resolve(),
      secondary?.cleanup() ?? Promise.resolve(),
    ]);
    await Promise.allSettled([
      primaryDaemon.close(),
      secondaryDaemon?.close() ?? Promise.resolve(),
    ]);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
