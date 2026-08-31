import type { SupervisedTeamAgentAuthority } from "../../team/agent-authority.js";

const SUPERVISOR_TOOL_NAMES: ReadonlySet<string> = new Set([
  "get_agent_status",
  "list_agents",
  "get_agent_activity",
  "list_pending_permissions",
  "respond_to_permission",
]);

export class SupervisedTeamToolUnauthorizedError extends Error {
  readonly code = "supervised_team_tool_unauthorized";

  constructor(
    readonly runId: string,
    readonly callerAgentId: string,
    readonly toolName: string,
  ) {
    super(`Supervised Team agent ${callerAgentId} cannot use Paseo tool '${toolName}'`);
    this.name = "SupervisedTeamToolUnauthorizedError";
  }
}

export class SupervisedTeamAgentTargetUnauthorizedError extends Error {
  readonly code = "supervised_team_agent_target_unauthorized";

  constructor(
    readonly runId: string,
    readonly callerAgentId: string,
    readonly targetAgentId: string,
  ) {
    super(
      `Supervised Team agent ${callerAgentId} cannot target agent ${targetAgentId} outside its run`,
    );
    this.name = "SupervisedTeamAgentTargetUnauthorizedError";
  }
}

export function isSupervisedTeamToolAllowed(
  authority: SupervisedTeamAgentAuthority,
  toolName: string,
): boolean {
  return authority.role === "supervisor" && SUPERVISOR_TOOL_NAMES.has(toolName);
}

export function requireSupervisedTeamToolAllowed(
  authority: SupervisedTeamAgentAuthority | null,
  toolName: string,
): void {
  if (!authority || isSupervisedTeamToolAllowed(authority, toolName)) return;
  throw new SupervisedTeamToolUnauthorizedError(authority.runId, authority.callerAgentId, toolName);
}

export function requireSupervisedTeamAgentTarget(
  authority: SupervisedTeamAgentAuthority | null,
  targetAgentId: string,
): void {
  if (!authority || authority.memberAgentIds.includes(targetAgentId)) return;
  throw new SupervisedTeamAgentTargetUnauthorizedError(
    authority.runId,
    authority.callerAgentId,
    targetAgentId,
  );
}
