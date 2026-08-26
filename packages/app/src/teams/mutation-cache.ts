import type { QueryClient } from "@tanstack/react-query";
import { teamListQueryKey } from "./data";

export async function prepareTeamListMutation(
  queryClient: QueryClient,
  serverId: string,
): Promise<void> {
  await queryClient.cancelQueries({ queryKey: teamListQueryKey(serverId), exact: true });
}

export function invalidateTeamList(queryClient: QueryClient, serverId: string): void {
  void queryClient.invalidateQueries({ queryKey: teamListQueryKey(serverId), exact: true });
}
