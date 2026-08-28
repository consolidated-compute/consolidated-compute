import type { AgentProvider, ProviderOptions } from "@getpaseo/protocol/agent-types";

import type { WorkspaceDraftTabSetup, WorkspaceTabTarget } from "@/workspace-tabs/model";

export interface WorkspaceDraftSubmissionComposerState {
  selectedMode: string;
  effectiveModelId: string | null;
  effectiveThinkingOptionId: string | null;
  featureValues: Record<string, unknown> | undefined;
  selectedProviderOptions: ProviderOptions;
}

export interface WorkspaceDraftSubmissionConfig {
  cwd: string;
  provider: AgentProvider;
  modeId: string | null;
  model: string | null;
  thinkingOptionId: string | null;
  featureValues: Record<string, unknown> | undefined;
  providerOptions?: ProviderOptions;
  target: WorkspaceTabTarget;
}

export function resolveWorkspaceDraftSubmissionConfig(input: {
  draftId: string;
  workspaceDirectory: string;
  provider: AgentProvider;
  composerState: WorkspaceDraftSubmissionComposerState;
  initialSetup?: WorkspaceDraftTabSetup;
}): WorkspaceDraftSubmissionConfig {
  const { draftId, workspaceDirectory, provider, composerState, initialSetup } = input;
  if (initialSetup) {
    return {
      cwd: initialSetup.cwd,
      provider: initialSetup.provider,
      modeId: initialSetup.modeId,
      model: initialSetup.model,
      thinkingOptionId: initialSetup.thinkingOptionId,
      featureValues: initialSetup.featureValues,
      providerOptions: composerState.selectedProviderOptions,
      target: { kind: "draft", draftId, setup: initialSetup },
    };
  }
  return {
    cwd: workspaceDirectory,
    provider,
    modeId: composerState.selectedMode || null,
    model: composerState.effectiveModelId || null,
    thinkingOptionId: composerState.effectiveThinkingOptionId || null,
    featureValues: composerState.featureValues,
    providerOptions: composerState.selectedProviderOptions,
    target: { kind: "draft", draftId },
  };
}
