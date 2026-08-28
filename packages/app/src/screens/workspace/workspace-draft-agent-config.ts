import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";

export function resolveWorkspaceDraftProviderOptions(input: {
  autoSubmitConfig: { providerOptions: NonNullable<AgentSessionConfig["providerOptions"]> } | null;
  selectedProviderOptions: NonNullable<AgentSessionConfig["providerOptions"]>;
}): NonNullable<AgentSessionConfig["providerOptions"]> {
  if (input.autoSubmitConfig) {
    return input.autoSubmitConfig.providerOptions;
  }
  return input.selectedProviderOptions;
}

export function buildWorkspaceDraftAgentConfig(input: {
  provider: AgentSessionConfig["provider"];
  cwd: string;
  modeId?: string;
  model?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  providerOptions?: AgentSessionConfig["providerOptions"];
}): AgentSessionConfig {
  return {
    provider: input.provider,
    cwd: input.cwd,
    ...(input.modeId ? { modeId: input.modeId } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
    ...(input.featureValues ? { featureValues: input.featureValues } : {}),
    ...(input.providerOptions && Object.keys(input.providerOptions).length > 0
      ? { providerOptions: input.providerOptions }
      : {}),
  };
}
