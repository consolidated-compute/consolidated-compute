import type { PersistedTeamRunRecord } from "./model.js";

export interface SupervisedTeamAgentAuthority {
  runId: string;
  assignmentId: string;
  workspaceId: string;
  callerAgentId: string;
  role: "supervisor" | "worker";
  roleId: string;
  memberAgentIds: string[];
}

export class SupervisedTeamAgentAuthorityConflictError extends Error {
  readonly code = "supervised_team_agent_authority_conflict";

  constructor(readonly agentId: string) {
    super(`Agent ${agentId} belongs to more than one supervised Team Run`);
    this.name = "SupervisedTeamAgentAuthorityConflictError";
  }
}

export function resolveSupervisedTeamAgentAuthority(
  runs: readonly PersistedTeamRunRecord[],
  agentId: string,
): SupervisedTeamAgentAuthority | null {
  const matches: SupervisedTeamAgentAuthority[] = [];
  for (const run of runs) {
    if (!run.supervision || !run.assignmentId) continue;
    const memberAgentIds = collectSupervisedAgentIds(run);
    const isSupervisor = run.supervision.supervisor.agentId === agentId;
    const workerStep = run.steps.find(
      (step) =>
        step.snapshot.supervision?.kind === "worker" &&
        "plannedAgentId" in step.state &&
        step.state.plannedAgentId === agentId,
    );
    if (!isSupervisor && !workerStep) continue;
    matches.push({
      runId: run.id,
      assignmentId: run.assignmentId,
      workspaceId: run.workspace.workspaceId,
      callerAgentId: agentId,
      role: isSupervisor ? "supervisor" : "worker",
      roleId: isSupervisor ? run.supervision.supervisor.roleId : workerStep!.snapshot.roleId,
      memberAgentIds,
    });
  }
  if (matches.length > 1) throw new SupervisedTeamAgentAuthorityConflictError(agentId);
  return matches[0] ?? null;
}

function collectSupervisedAgentIds(run: PersistedTeamRunRecord): string[] {
  const agentIds = new Set<string>([run.supervision!.supervisor.agentId]);
  for (const step of run.steps) {
    if (step.snapshot.supervision?.kind === "worker" && "plannedAgentId" in step.state) {
      agentIds.add(step.state.plannedAgentId);
    }
  }
  return [...agentIds];
}
