import type { QueryClient } from "@tanstack/react-query";
import type { AssignmentDto } from "@getpaseo/protocol/assignment/types";
import {
  assignmentListQueryKey,
  assignmentQueryKey,
  type AssignmentListData,
  upsertAssignment,
} from "./data";

export async function applyAssignmentMutation(
  queryClient: QueryClient,
  serverId: string,
  assignment: AssignmentDto,
): Promise<void> {
  const listKey = assignmentListQueryKey(serverId);
  const detailKey = assignmentQueryKey(serverId, assignment.id);
  await Promise.all([
    queryClient.cancelQueries({ queryKey: listKey, exact: true }),
    queryClient.cancelQueries({ queryKey: detailKey, exact: true }),
  ]);
  queryClient.setQueryData<AssignmentListData>(listKey, (current) => ({
    assignments: upsertAssignment(current?.assignments ?? [], assignment),
    issues: current?.issues ?? [],
  }));
  queryClient.setQueryData(detailKey, assignment);
  void queryClient.invalidateQueries({ queryKey: listKey, exact: true });
}
