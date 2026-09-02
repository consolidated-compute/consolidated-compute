import { once } from "node:events";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { connectDaemonClient } from "../packages/app/e2e/support/helpers/daemon-client-loader.js";
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
import {
  connectAssignmentsClient,
  type AssignmentsDaemonClient,
} from "../packages/app/e2e/support/helpers/assignments.js";
import {
  connectTeamsClient,
  type TeamsDaemonClient,
} from "../packages/app/e2e/support/helpers/teams.js";
import {
  startSupervisedTeamSurfaceScenario,
  type SupervisedTeamSurfaceScenario,
} from "../packages/app/e2e/support/helpers/supervised-team-scenario.js";
import { seedParentWithCrossWorkspaceSubagent } from "../packages/app/e2e/support/helpers/subagents.js";

const PRIMARY_SERVER_ID = "srv_mobile_operations_primary";
const SECONDARY_SERVER_ID = "srv_mobile_operations_secondary";
const PRIMARY_TEAM_ROLE_ID = "planner";
const PRIMARY_TEAM_SUPERVISOR_ROLE_ID = "supervisor";
const PRIMARY_TEAM_STEP_ID = "plan";

interface AgentProfilesDaemonClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  patchDaemonConfig(config: { agentProfiles: AgentProfile[] }): Promise<unknown>;
}

async function main(): Promise<void> {
  const primaryDaemon = await startIsolatedHostDaemon(PRIMARY_SERVER_ID);
  let secondaryDaemon: IsolatedHostDaemon | null = null;
  let primary: SeededWorkspace | null = null;
  let secondary: SeededWorkspace | null = null;
  let profilesClient: AgentProfilesDaemonClient | null = null;
  let teamsClient: TeamsDaemonClient | null = null;
  let assignmentsClient: AssignmentsDaemonClient | null = null;
  let supervisedScenario: SupervisedTeamSurfaceScenario | null = null;

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
    profilesClient = await connectDaemonClient<AgentProfilesDaemonClient>({
      clientIdPrefix: "mobile-teams-profiles",
      port: primaryDaemon.port,
    });
    await profilesClient.patchDaemonConfig({
      agentProfiles: [
        {
          id: "mobile-planner",
          name: "Mobile Planner",
          provider: "mock",
          model: "ten-second-stream",
          modeId: "load-test",
        },
        {
          id: "mobile-supervisor",
          name: "Mobile Supervisor",
          provider: "mock",
          model: "ten-second-stream",
          modeId: "load-test",
        },
      ],
    });
    teamsClient = await connectTeamsClient({ port: primaryDaemon.port });
    const mobileTeam = await teamsClient.createTeam({
      name: "Mobile Delivery Team",
      instructions: "Prove a native Team Run can pause and resume.",
      roles: [
        {
          id: PRIMARY_TEAM_ROLE_ID,
          name: "Planner",
          instructions: "Emit synthetic plan approval.",
          profileId: "mobile-planner",
        },
        {
          id: PRIMARY_TEAM_SUPERVISOR_ROLE_ID,
          name: "Supervisor",
          instructions: "Coordinate the saved native worker plan.",
          profileId: "mobile-supervisor",
        },
      ],
      workflow: [
        {
          id: PRIMARY_TEAM_STEP_ID,
          roleId: PRIMARY_TEAM_ROLE_ID,
          instructions: null,
        },
      ],
    });
    assignmentsClient = await connectAssignmentsClient({ port: primaryDaemon.port });
    const mobileAssignment = await assignmentsClient.createAssignment({
      title: "Mobile Artifact contract",
      objective: "Persist the exact output from the selected Team.",
      workItem: {
        sourceId: "github",
        sourceLabel: "GitHub",
        resourceType: "issue",
        resourceId: "consolidated-compute/consolidated-compute:issue:72",
        identifier: "#72",
        title: "Assignments: prove the three-role Artifact contract",
        url: "https://github.com/consolidated-compute/consolidated-compute/issues/72",
      },
    });
    supervisedScenario = await startSupervisedTeamSurfaceScenario({
      serverId: "srv_mobile_supervised_surface",
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
          teamId: mobileTeam.team.id,
          teamRoleId: PRIMARY_TEAM_ROLE_ID,
          teamSupervisorRoleId: PRIMARY_TEAM_SUPERVISOR_ROLE_ID,
          teamStepId: PRIMARY_TEAM_STEP_ID,
          assignmentId: mobileAssignment.assignment.id,
        },
        secondary: {
          serverId: SECONDARY_SERVER_ID,
          port: secondaryDaemon.port,
          workspaceId: secondary.workspaceId,
          agentId: secondaryAgent.id,
          providerSubagentId: OPERATIONS_DUPLICATE_PROVIDER_SUBAGENT_ID,
        },
        supervised: {
          serverId: supervisedScenario.serverId,
          port: supervisedScenario.port,
          password: supervisedScenario.password,
          assignmentId: supervisedScenario.assignmentId,
          runId: supervisedScenario.runId,
          workerAgentId: supervisedScenario.workerAgentId,
        },
      })}\n`,
    );
    await Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]);
  } finally {
    await Promise.allSettled([
      assignmentsClient?.close() ?? Promise.resolve(),
      teamsClient?.close() ?? Promise.resolve(),
      profilesClient?.close() ?? Promise.resolve(),
    ]);
    await Promise.allSettled([
      primary?.cleanup() ?? Promise.resolve(),
      secondary?.cleanup() ?? Promise.resolve(),
      supervisedScenario?.cleanup() ?? Promise.resolve(),
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
