import type {
  ForgeRepositoryPage,
  ForgeRepositoryWorkPage,
} from "@getpaseo/protocol/forge-repositories";
import {
  ASSIGNMENT_WORK_ITEM_TITLE_MAX_CHARS,
  type AssignmentWorkItemReferenceDto,
} from "@getpaseo/protocol/assignment/types";
import { isValidAssignmentWorkItem } from "@/assignments/work-item-validation";

export type Repository = ForgeRepositoryPage["items"][number];
export type RepositoryWorkItem = ForgeRepositoryWorkPage["items"][number];

export function repositoryWorkToAssignmentReference(
  item: RepositoryWorkItem,
): AssignmentWorkItemReferenceDto | null {
  const reference: AssignmentWorkItemReferenceDto = {
    sourceId: item.repository.forge,
    sourceLabel: "GitHub",
    resourceType: item.kind,
    resourceId: `${item.repository.host}:${item.repository.id}:${item.id}`,
    identifier: `#${item.number}`,
    title: item.title.trim().slice(0, ASSIGNMENT_WORK_ITEM_TITLE_MAX_CHARS),
    url: item.url,
  };
  return isValidAssignmentWorkItem(reference) ? reference : null;
}
