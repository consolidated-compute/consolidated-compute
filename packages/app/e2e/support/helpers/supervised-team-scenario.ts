import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TeamRunDto } from "@getpaseo/protocol/team/types";
import { connectAssignmentsClient, type AssignmentsDaemonClient } from "./assignments";
import { startIsolatedHostDaemon, type IsolatedHostDaemon } from "./isolated-host-daemon";
import { seedWorkspace, type SeededWorkspace } from "./seed-client";
import { connectTeamsClient, type TeamsDaemonClient } from "./teams";

export const SUPERVISED_SURFACE_PASSWORD = "shared-secret";
const SUPERVISED_SURFACE_PASSWORD_HASH =
  "$2b$12$GMhF7pN4QnMlHOQXOqjd1OitKWPSmAO3FwB0PHzKtcZR/sAMryz76";

export interface SupervisedTeamSurfaceScenario {
  serverId: string;
  port: number;
  password: string;
  workspaceId: string;
  assignmentId: string;
  teamId: string;
  runId: string;
  workerAgentId: string;
  cleanup(): Promise<void>;
}

async function waitForPermissionRun(client: TeamsDaemonClient, runId: string): Promise<TeamRunDto> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { run } = await client.getTeamRun(runId);
    if (run.state.status === "waiting_for_permission") return run;
    if (["failed", "canceled", "interrupted", "stop_failed"].includes(run.state.status)) {
      throw new Error(`Supervised surface fixture terminated during setup: ${run.state.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const { run } = await client.getTeamRun(runId);
  throw new Error(
    `Timed out waiting for supervised surface fixture permission; got ${run.state.status}`,
  );
}

export async function startSupervisedTeamSurfaceScenario(input: {
  serverId: string;
}): Promise<SupervisedTeamSurfaceScenario> {
  const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-supervised-surface-"));
  let daemon: IsolatedHostDaemon | null = null;
  let workspace: SeededWorkspace | null = null;
  let teams: TeamsDaemonClient | null = null;
  let assignments: AssignmentsDaemonClient | null = null;

  const cleanup = async (): Promise<void> => {
    await Promise.allSettled([
      teams?.close() ?? Promise.resolve(),
      assignments?.close() ?? Promise.resolve(),
      workspace?.cleanup() ?? Promise.resolve(),
    ]);
    await daemon?.close();
    await rm(paseoHome, { recursive: true, force: true });
  };

  try {
    await writeFile(
      path.join(paseoHome, "config.json"),
      `${JSON.stringify({
        version: 1,
        daemon: {
          auth: { password: SUPERVISED_SURFACE_PASSWORD_HASH },
          agentProfiles: [
            {
              id: "surface-supervisor",
              name: "Surface Supervisor",
              provider: "mock",
              model: "ten-second-stream",
              modeId: "load-test",
            },
            {
              id: "surface-worker",
              name: "Surface Worker",
              provider: "mock",
              model: "ten-second-stream",
              modeId: "load-test",
            },
          ],
        },
      })}\n`,
    );
    daemon = await startIsolatedHostDaemon(input.serverId, {
      paseoHome,
      environment: { ...process.env, PASEO_PASSWORD: undefined },
    });
    workspace = await seedWorkspace({
      repoPrefix: "supervised-surface-",
      title: "Supervised surface proof",
      password: SUPERVISED_SURFACE_PASSWORD,
      port: daemon.port,
    });
    teams = await connectTeamsClient({
      password: SUPERVISED_SURFACE_PASSWORD,
      port: daemon.port,
    });
    assignments = await connectAssignmentsClient({
      password: SUPERVISED_SURFACE_PASSWORD,
      port: daemon.port,
    });
    const { team } = await teams.createTeam({
      name: "Supervised checkpoint Team",
      instructions: "Run the deterministic supervised checkpoint proof.",
      roles: [
        {
          id: "surface-supervisor",
          name: "Supervisor",
          instructions: "Coordinate the bounded checkpoint proof.",
          profileId: "surface-supervisor",
        },
        {
          id: "surface-worker",
          name: "Permission worker",
          instructions: "Emit synthetic plan approval.",
          profileId: "surface-worker",
        },
      ],
      workflow: [
        {
          id: "checkpoint",
          roleId: "surface-worker",
          instructions: null,
        },
      ],
    });
    const { assignment } = await assignments.createAssignment({
      title: "Supervised human checkpoint proof",
      objective: "Approve one provider permission and one durable human checkpoint.",
      workItem: null,
    });
    const { run } = await teams.startAssignmentTeamRun({
      teamId: team.id,
      expectedRevision: team.revision,
      idempotencyKey: "supervised-surface-proof",
      assignmentId: assignment.id,
      expectedAssignmentRevision: assignment.revision,
      workspaceId: workspace.workspaceId,
      supervision: { supervisorRoleId: "surface-supervisor" },
    });
    const waiting = await waitForPermissionRun(teams, run.id);
    const worker = waiting.steps.find((step) => step.state.status === "waiting_for_permission");
    if (!worker || !("agentId" in worker.state) || worker.state.agentId === null) {
      throw new Error(
        `Supervised surface fixture has no permission-waiting worker agent: ${JSON.stringify(waiting.steps)}`,
      );
    }

    return {
      serverId: input.serverId,
      port: daemon.port,
      password: SUPERVISED_SURFACE_PASSWORD,
      workspaceId: workspace.workspaceId,
      assignmentId: assignment.id,
      teamId: team.id,
      runId: run.id,
      workerAgentId: worker.state.agentId,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
