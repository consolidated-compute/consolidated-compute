import type {
  TeamDefinitionDto,
  TeamDefinitionInputDto,
  TeamDefinitionPatchDto,
  TeamRunDto,
} from "@getpaseo/protocol/team/types";
import { connectDaemonClient } from "./daemon-client-loader";

export interface TeamsDaemonClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  createTeam(
    definition: TeamDefinitionInputDto,
    requestId?: string,
  ): Promise<{
    team: TeamDefinitionDto;
  }>;
  listTeams(requestId?: string): Promise<{ teams: TeamDefinitionDto[] }>;
  getTeam(teamId: string, requestId?: string): Promise<{ team: TeamDefinitionDto }>;
  updateTeam(input: {
    teamId: string;
    expectedRevision: number;
    patch: TeamDefinitionPatchDto;
    requestId?: string;
  }): Promise<{ team: TeamDefinitionDto }>;
  deleteTeam(input: {
    teamId: string;
    expectedRevision: number;
    requestId?: string;
  }): Promise<{ teamId: string }>;
  getTeamRun(runId: string, requestId?: string): Promise<{ run: TeamRunDto }>;
}

export function connectTeamsClient(options?: { port?: number }): Promise<TeamsDaemonClient> {
  return connectDaemonClient<TeamsDaemonClient>({
    clientIdPrefix: "teams-e2e",
    port: options?.port,
  });
}

/** Deletes a Team at its current revision so UI edits do not complicate cleanup. */
export async function removeTeam(client: TeamsDaemonClient, teamId: string): Promise<void> {
  const { team } = await client.getTeam(teamId);
  await client.deleteTeam({ teamId, expectedRevision: team.revision });
}
