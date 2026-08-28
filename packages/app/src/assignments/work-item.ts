import type { ForgeAuthState, ForgeSearchItem } from "@getpaseo/protocol/messages";
import type { AssignmentWorkItemReferenceDto } from "@getpaseo/protocol/assignment/types";
import type { PluginAttachmentItem } from "@getpaseo/plugin";
import { getForgePresentation } from "@/git/forge";
import { isValidAssignmentWorkItem } from "./work-item-validation";

interface WorkItemSearchQuerySnapshot {
  error: unknown;
  isFetching: boolean;
}

interface WorkItemForgeSearchQuerySnapshot extends WorkItemSearchQuerySnapshot {
  data?: {
    error: string | null;
    authState: ForgeAuthState;
  };
}

export interface WorkItemSearchSnapshot extends WorkItemSearchQuerySnapshot {
  authState: ForgeAuthState | null;
}

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
): AssignmentWorkItemReferenceDto | null {
  const workItem: AssignmentWorkItemReferenceDto = {
    sourceId: `plugin:${pluginId}:${sourceId}`,
    sourceLabel,
    resourceType: normalizeResourceType(item.resourceType),
    resourceId: item.id,
    identifier: item.identifier,
    title: item.title,
    url: item.url,
  };
  return isValidAssignmentWorkItem(workItem) ? workItem : null;
}

export function resolveWorkItemSearchSnapshot(input: {
  useForge: boolean;
  forge: WorkItemForgeSearchQuerySnapshot;
  plugin: WorkItemSearchQuerySnapshot;
  forgeSetupError: string;
}): WorkItemSearchSnapshot {
  if (!input.useForge) {
    return { error: input.plugin.error, authState: null, isFetching: input.plugin.isFetching };
  }
  const authError = forgeSearchRequiresSetup(input.forge.data?.authState ?? null)
    ? input.forgeSetupError
    : null;
  return {
    error: input.forge.error ?? input.forge.data?.error ?? authError,
    authState: input.forge.data?.authState ?? null,
    isFetching: input.forge.isFetching,
  };
}

function forgeSearchRequiresSetup(authState: ForgeAuthState | null): boolean {
  return authState !== null && authState !== "authenticated";
}
