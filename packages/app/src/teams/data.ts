import type { TeamDefinitionDto } from "@getpaseo/protocol/team/types";
import type { HostRuntimeConnectionStatus } from "@/runtime/host-runtime";

export const teamsQueryBaseKey = ["teams"] as const;

export function teamListQueryKey(serverId: string) {
  return [...teamsQueryBaseKey, serverId, "list"] as const;
}

export interface TeamHostIdentity {
  serverId: string;
  serverName: string;
}

export interface AggregatedTeam extends TeamDefinitionDto {
  serverId: string;
  serverName: string;
  key: string;
}

export type TeamHostStatus =
  | "connecting"
  | "loading"
  | "ready"
  | "unsupported"
  | "offline"
  | "error";

export interface TeamHostState extends TeamHostIdentity {
  status: TeamHostStatus;
  teams: AggregatedTeam[];
  canAuthor: boolean;
  agentProfilesSupported: boolean;
  error: string | null;
}

export interface TeamHostQuerySnapshot {
  data: TeamDefinitionDto[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
}

export interface ResolveTeamHostStateInput extends TeamHostIdentity {
  connectionStatus: HostRuntimeConnectionStatus;
  teamsFeature: boolean | null;
  agentProfilesFeature: boolean | null;
  query: TeamHostQuerySnapshot;
  connectionError: string | null;
}

export function teamKey(serverId: string, teamId: string): string {
  return `${serverId}:${teamId}`;
}

export function qualifyTeams(
  host: TeamHostIdentity,
  teams: readonly TeamDefinitionDto[],
): AggregatedTeam[] {
  return teams.map((team) => ({
    ...team,
    serverId: host.serverId,
    serverName: host.serverName,
    key: teamKey(host.serverId, team.id),
  }));
}

export function resolveTeamHostState(input: ResolveTeamHostStateInput): TeamHostState {
  const teams = qualifyTeams(input, input.query.data ?? []);
  const agentProfilesSupported = input.agentProfilesFeature === true;
  const base = {
    serverId: input.serverId,
    serverName: input.serverName,
    teams,
    agentProfilesSupported,
  };

  if (input.connectionStatus === "connecting" || input.connectionStatus === "idle") {
    return { ...base, status: "connecting", canAuthor: false, error: null };
  }

  if (input.connectionStatus !== "online") {
    return {
      ...base,
      status: "offline",
      canAuthor: false,
      error: input.connectionError,
    };
  }

  if (input.teamsFeature === false) {
    return { ...base, status: "unsupported", canAuthor: false, error: null };
  }

  if (input.teamsFeature === null || input.query.isLoading) {
    return { ...base, status: "loading", canAuthor: false, error: null };
  }

  if (input.query.isError) {
    return {
      ...base,
      status: "error",
      canAuthor: false,
      error: input.query.error?.message ?? "Unable to load Teams",
    };
  }

  return {
    ...base,
    status: "ready",
    canAuthor: agentProfilesSupported,
    error: null,
  };
}
