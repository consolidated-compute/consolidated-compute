import {
  ASSIGNMENT_WORK_ITEM_IDENTIFIER_MAX_CHARS,
  ASSIGNMENT_WORK_ITEM_RESOURCE_ID_MAX_CHARS,
  ASSIGNMENT_WORK_ITEM_RESOURCE_TYPE_MAX_CHARS,
  ASSIGNMENT_WORK_ITEM_SOURCE_ID_MAX_CHARS,
  ASSIGNMENT_WORK_ITEM_SOURCE_LABEL_MAX_CHARS,
  ASSIGNMENT_WORK_ITEM_TITLE_MAX_CHARS,
  ASSIGNMENT_WORK_ITEM_URL_MAX_CHARS,
  type AssignmentWorkItemReferenceDto,
} from "@getpaseo/protocol/assignment/types";

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function isOpenToken(value: string): boolean {
  return /^[a-z][a-z0-9._-]*$/.test(value);
}

export function isValidAssignmentWorkItem(workItem: AssignmentWorkItemReferenceDto): boolean {
  return (
    workItem.sourceId.trim().length > 0 &&
    workItem.sourceId.length <= ASSIGNMENT_WORK_ITEM_SOURCE_ID_MAX_CHARS &&
    workItem.sourceLabel.trim().length > 0 &&
    workItem.sourceLabel.length <= ASSIGNMENT_WORK_ITEM_SOURCE_LABEL_MAX_CHARS &&
    isOpenToken(workItem.resourceType) &&
    workItem.resourceType.length <= ASSIGNMENT_WORK_ITEM_RESOURCE_TYPE_MAX_CHARS &&
    workItem.resourceId.trim().length > 0 &&
    workItem.resourceId.length <= ASSIGNMENT_WORK_ITEM_RESOURCE_ID_MAX_CHARS &&
    workItem.identifier.trim().length > 0 &&
    workItem.identifier.length <= ASSIGNMENT_WORK_ITEM_IDENTIFIER_MAX_CHARS &&
    workItem.title.trim().length > 0 &&
    workItem.title.length <= ASSIGNMENT_WORK_ITEM_TITLE_MAX_CHARS &&
    workItem.url.length <= ASSIGNMENT_WORK_ITEM_URL_MAX_CHARS &&
    isHttpUrl(workItem.url)
  );
}
