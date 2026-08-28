import type { ForgeSearchItem } from "@getpaseo/protocol/messages";
import type { AssignmentWorkItemReferenceDto } from "@getpaseo/protocol/assignment/types";
import type { PluginAttachmentItem } from "@getpaseo/plugin";
import { getForgePresentation } from "@/git/forge";

function normalizeResourceType(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/g, "");
  return normalized || "resource";
}

export function forgeSearchItemToWorkItem(item: ForgeSearchItem): AssignmentWorkItemReferenceDto {
  const presentation = getForgePresentation(item.forge ?? "github");
  const prefix =
    item.kind === "change_request" ? presentation.numberPrefix : presentation.issueNumberPrefix;
  return {
    sourceId: presentation.forge,
    sourceLabel: presentation.brandLabel,
    resourceType: item.kind,
    resourceId: item.projectPath ? `${item.projectPath}:${item.kind}:${item.number}` : item.url,
    identifier: `${prefix}${item.number}`,
    title: item.title,
    url: item.url,
  };
}

export function pluginAttachmentItemToWorkItem(
  pluginId: string,
  sourceId: string,
  sourceLabel: string,
  item: PluginAttachmentItem,
): AssignmentWorkItemReferenceDto {
  return {
    sourceId: `plugin:${pluginId}:${sourceId}`,
    sourceLabel,
    resourceType: normalizeResourceType(item.resourceType),
    resourceId: item.id,
    identifier: item.identifier,
    title: item.title,
    url: item.url,
  };
}
