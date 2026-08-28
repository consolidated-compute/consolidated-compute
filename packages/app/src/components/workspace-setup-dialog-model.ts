import type { CreateAgentRequestOptions } from "@getpaseo/client/internal/daemon-client";

export function buildCreateAgentOptions({
  composerState,
  text,
  attachments,
  encodedImages,
  workspaceDirectory,
  workspaceId,
  provider,
}: {
  composerState: {
    modeOptions: { id: string }[];
    selectedMode: string;
    effectiveModelId: string | null;
    effectiveThinkingOptionId: string | null;
    selectedProviderOptions: NonNullable<CreateAgentRequestOptions["providerOptions"]>;
  };
  text: string;
  attachments: NonNullable<CreateAgentRequestOptions["attachments"]>;
  encodedImages: NonNullable<CreateAgentRequestOptions["images"]> | null;
  workspaceDirectory: string;
  workspaceId: string;
  provider: CreateAgentRequestOptions["provider"];
}): CreateAgentRequestOptions {
  // Reconcile the selected mode against the discovered modes. The mode picker
  // shows modeOptions[0] when the stored mode isn't in the list (e.g. a stale
  // globally-remembered mode this workspace's provider config no longer
  // defines), so the submitted mode must match that display rather than send a
  // stale mode the provider would reject.
  const modeOptionIds = composerState.modeOptions.map((mode) => mode.id);
  const reconciledMode = modeOptionIds.includes(composerState.selectedMode)
    ? composerState.selectedMode
    : (modeOptionIds[0] ?? "");
  return {
    provider,
    cwd: workspaceDirectory,
    workspaceId,
    ...(reconciledMode !== "" ? { modeId: reconciledMode } : {}),
    ...(composerState.effectiveModelId ? { model: composerState.effectiveModelId } : {}),
    ...(composerState.effectiveThinkingOptionId
      ? { thinkingOptionId: composerState.effectiveThinkingOptionId }
      : {}),
    providerOptions: composerState.selectedProviderOptions,
    ...(text.trim() ? { initialPrompt: text.trim() } : {}),
    ...(encodedImages && encodedImages.length > 0 ? { images: encodedImages } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}
