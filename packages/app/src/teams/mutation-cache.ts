import type { QueryClient } from "@tanstack/react-query";
import type { TeamDefinitionDto } from "@getpaseo/protocol/team/types";
import { teamListQueryKey } from "./data";

export function upsertTeam(
  current: readonly TeamDefinitionDto[],
  incoming: TeamDefinitionDto,
): TeamDefinitionDto[] {
  if (!current.some((team) => team.id === incoming.id)) return [...current, incoming];
  return current.map((team) => (team.id === incoming.id ? incoming : team));
}

export async function prepareTeamListMutation(
  queryClient: QueryClient,
  serverId: string,
): Promise<void> {
  await queryClient.cancelQueries({ queryKey: teamListQueryKey(serverId), exact: true });
}

export function invalidateTeamList(queryClient: QueryClient, serverId: string): void {
  void queryClient.invalidateQueries({ queryKey: teamListQueryKey(serverId), exact: true });
}
