import type { AgentFeature, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { materializeAgentProfile } from "@getpaseo/protocol/agent-profiles";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { TEAM_OBJECTIVE_MAX_CHARS, type TeamDefinitionDto } from "@getpaseo/protocol/team/types";
import type { WorkspaceDescriptor } from "@/stores/session-store";

export interface TeamRunFormDisplay {
  label: string;
  description?: string;
}

export interface TeamRunWorkspaceOption {
  workspaceId: string;
  cwd: string;
  display: TeamRunFormDisplay;
}

export type TeamRunRoleResolutionStatus =
  | "loading"
  | "ready"
  | "profile_missing"
  | "profile_ambiguous"
  | "profile_invalid"
  | "provider_unavailable"
  | "model_unavailable"
  | "mode_unavailable"
  | "thinking_unavailable"
  | "features_loading"
  | "feature_unavailable";

export interface TeamRunRoleResolution {
  roleId: string;
  roleName: string;
  profileId: string;
  profileName: string | null;
  provider: string | null;
  model: string | null;
  modeId: string | null;
  thinkingOptionId: string | null;
  featureValues: Record<string, unknown>;
  status: TeamRunRoleResolutionStatus;
}

export type TeamRunFormValidationIssue =
  | "workspace_required"
  | "workspace_missing"
  | "objective_required"
  | "objective_too_long"
  | "profiles_loading"
  | "profile_unavailable";

export interface TeamRunFormSubmission {
  serverId: string;
  teamId: string;
  expectedRevision: number;
  idempotencyKey: string;
  objective: string;
  workspaceId: string;
}

export interface TeamRunFormState {
  serverId: string;
  team: TeamDefinitionDto;
  workspaces: TeamRunWorkspaceOption[];
  selectedWorkspaceId: string | null;
  selectedWorkspaceDisplay: TeamRunFormDisplay | null;
  selectedWorkspaceCwd: string | null;
  objective: string;
  roleResolutions: TeamRunRoleResolution[];
  validationIssue: TeamRunFormValidationIssue | null;
  canSubmit: boolean;
  submission: TeamRunFormSubmission | null;
  submitError: string | null;
}

export interface TeamRunFormSnapshot {
  serverId: string;
  team: TeamDefinitionDto;
  workspaces: readonly TeamRunWorkspaceOption[];
  profiles?: readonly AgentProfile[] | null;
}

export interface TeamRunFormModel {
  getState: () => TeamRunFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  applyWorkspaces: (workspaces: readonly TeamRunWorkspaceOption[]) => void;
  applyProfiles: (profiles: readonly AgentProfile[] | null) => void;
  applyProviderCatalog: (
    workspaceId: string,
    workspaceCwd: string,
    entries: readonly ProviderSnapshotEntry[] | null,
  ) => void;
  applyFeatureCatalog: (
    roleId: string,
    requestKey: string,
    features: readonly AgentFeature[] | null,
  ) => void;
  setWorkspace: (workspaceId: string, display: TeamRunFormDisplay) => void;
  setObjective: (value: string) => void;
  setSubmitError: (value: string | null) => void;
}

interface OpenTeamRunFormOptions {
  generateIdempotencyKey?: () => string;
}

export interface TeamRunFeatureRequest {
  roleId: string;
  requestKey: string;
  config: {
    provider: ProviderSnapshotEntry["provider"];
    cwd: string;
    model?: string;
    modeId?: string;
    thinkingOptionId?: string;
    featureValues: Record<string, unknown>;
  };
}

export function buildTeamRunWorkspaceOptions(
  workspaces: readonly WorkspaceDescriptor[],
): TeamRunWorkspaceOption[] {
  return workspaces
    .filter((workspace) => workspace.archivingAt === null)
    .map((workspace) => ({
      workspaceId: workspace.id,
      cwd: workspace.workspaceDirectory,
      display: {
        label: workspace.title ?? workspace.name,
        description: workspace.projectDisplayName,
      },
    }))
    .sort((left, right) => left.display.label.localeCompare(right.display.label));
}

function generateIdempotencyKey(): string {
  return `team-run-${crypto.randomUUID()}`;
}

function findModel(entry: ProviderSnapshotEntry, requested: string) {
  return entry.models?.find(
    (model) => model.id === requested || model.aliases?.includes(requested),
  );
}

function providerReadinessStatus(
  provider: ProviderSnapshotEntry | undefined,
): "loading" | "provider_unavailable" | null {
  if (
    !provider ||
    !provider.enabled ||
    provider.status === "error" ||
    provider.status === "unavailable"
  ) {
    return "provider_unavailable";
  }
  return provider.status === "loading" ? "loading" : null;
}

function providerSelectionStatus(
  provider: ProviderSnapshotEntry,
  materialized: ReturnType<typeof materializeAgentProfile>,
  model: NonNullable<ProviderSnapshotEntry["models"]>[number] | undefined,
): Exclude<TeamRunRoleResolutionStatus, "loading" | "ready"> | null {
  if (materialized.modelId && !model) return "model_unavailable";
  if (materialized.modeId && !provider.modes?.some((mode) => mode.id === materialized.modeId)) {
    return "mode_unavailable";
  }
  if (
    materialized.thinkingOptionId &&
    !model?.thinkingOptions?.some((option) => option.id === materialized.thinkingOptionId)
  ) {
    return "thinking_unavailable";
  }
  return null;
}

export function buildTeamRunFeatureRequest(
  resolution: TeamRunRoleResolution,
  cwd: string | null,
): TeamRunFeatureRequest | null {
  if (!cwd || !resolution.provider || Object.keys(resolution.featureValues).length === 0) {
    return null;
  }
  const config = {
    provider: resolution.provider,
    cwd,
    ...(resolution.model ? { model: resolution.model } : {}),
    ...(resolution.modeId ? { modeId: resolution.modeId } : {}),
    ...(resolution.thinkingOptionId ? { thinkingOptionId: resolution.thinkingOptionId } : {}),
    featureValues: resolution.featureValues,
  };
  return {
    roleId: resolution.roleId,
    requestKey: JSON.stringify([resolution.roleId, config]),
    config,
  };
}

function hasInvalidFeatureValue(
  featureValues: Record<string, unknown>,
  features: readonly AgentFeature[],
): boolean {
  const featuresById = new Map(features.map((feature) => [feature.id, feature]));
  return Object.entries(featureValues).some(([featureId, value]) => {
    const feature = featuresById.get(featureId);
    if (!feature) return true;
    if (feature.type === "toggle") return typeof value !== "boolean";
    if (value !== null && typeof value !== "string") return true;
    return value !== null && !feature.options.some((option) => option.id === value);
  });
}

type RoleResolutionBase = Omit<TeamRunRoleResolution, "status">;
type ResolvedProfile =
  | { resolved: false; resolution: TeamRunRoleResolution }
  | {
      resolved: true;
      base: RoleResolutionBase;
      materialized: ReturnType<typeof materializeAgentProfile>;
    };

function resolveProfile(
  role: TeamDefinitionDto["roles"][number],
  profiles: readonly AgentProfile[] | null,
): ResolvedProfile {
  const base = {
    roleId: role.id,
    roleName: role.name,
    profileId: role.profileId,
    profileName: null,
    provider: null,
    model: null,
    modeId: null,
    thinkingOptionId: null,
    featureValues: {},
  } satisfies RoleResolutionBase;
  if (profiles === null) return { resolved: false, resolution: { ...base, status: "loading" } };
  const matches = profiles.filter((profile) => profile.id === role.profileId);
  if (matches.length === 0) {
    return { resolved: false, resolution: { ...base, status: "profile_missing" } };
  }
  if (matches.length > 1) {
    return { resolved: false, resolution: { ...base, status: "profile_ambiguous" } };
  }
  const profile = matches[0]!;
  const materialized = materializeAgentProfile(profile);
  const resolvedBase = {
    ...base,
    profileName: profile.name,
    provider: materialized.provider || null,
    model: materialized.modelId || null,
    modeId: materialized.modeId || null,
    thinkingOptionId: materialized.thinkingOptionId || null,
    featureValues: materialized.featureValues,
  };
  if (!materialized.provider) {
    return { resolved: false, resolution: { ...resolvedBase, status: "profile_invalid" } };
  }
  return { resolved: true, base: resolvedBase, materialized };
}

function resolveProvider(
  profile: Extract<ResolvedProfile, { resolved: true }>,
  providerEntries: readonly ProviderSnapshotEntry[] | null,
): TeamRunRoleResolution {
  const { base, materialized } = profile;
  if (providerEntries === null) return { ...base, status: "loading" };
  const provider = providerEntries.find((entry) => entry.provider === materialized.provider);
  const readinessStatus = providerReadinessStatus(provider);
  if (readinessStatus) return { ...base, status: readinessStatus };
  const readyProvider = provider as ProviderSnapshotEntry;

  const requestedModel = materialized.modelId;
  const model = requestedModel
    ? findModel(readyProvider, requestedModel)
    : (readyProvider.models?.find((entry) => entry.isDefault) ?? readyProvider.models?.[0]);
  const selectionStatus = providerSelectionStatus(readyProvider, materialized, model);
  if (selectionStatus) return { ...base, status: selectionStatus };
  return {
    ...base,
    model: model?.id ?? base.model,
    modeId: materialized.modeId || readyProvider.defaultModeId || null,
    status: "ready",
  };
}

interface FeatureCatalogResult {
  requestKey: string;
  features: readonly AgentFeature[] | null;
}

function resolveRoles(input: {
  team: TeamDefinitionDto;
  profiles: readonly AgentProfile[] | null;
  providerEntries: readonly ProviderSnapshotEntry[] | null;
  selectedWorkspaceCwd: string | null;
  featureCatalogs: ReadonlyMap<string, FeatureCatalogResult>;
}): TeamRunRoleResolution[] {
  return input.team.roles.map((role) => {
    const profile = resolveProfile(role, input.profiles);
    const resolution = profile.resolved
      ? resolveProvider(profile, input.providerEntries)
      : profile.resolution;
    if (resolution.status !== "ready") return resolution;
    const request = buildTeamRunFeatureRequest(resolution, input.selectedWorkspaceCwd);
    if (!request) return resolution;
    const catalog = input.featureCatalogs.get(role.id);
    if (!catalog || catalog.requestKey !== request.requestKey) {
      return { ...resolution, status: "features_loading" };
    }
    if (
      catalog.features === null ||
      hasInvalidFeatureValue(resolution.featureValues, catalog.features)
    ) {
      return { ...resolution, status: "feature_unavailable" };
    }
    return resolution;
  });
}

function validationIssue(state: TeamRunFormState): TeamRunFormValidationIssue | null {
  if (!state.selectedWorkspaceId) return "workspace_required";
  if (!state.workspaces.some((workspace) => workspace.workspaceId === state.selectedWorkspaceId)) {
    return "workspace_missing";
  }
  if (!state.objective.trim()) return "objective_required";
  if (state.objective.length > TEAM_OBJECTIVE_MAX_CHARS) return "objective_too_long";
  if (
    state.roleResolutions.some(
      (role) => role.status === "loading" || role.status === "features_loading",
    )
  ) {
    return "profiles_loading";
  }
  if (state.roleResolutions.some((role) => role.status !== "ready")) {
    return "profile_unavailable";
  }
  return null;
}

export function openTeamRunForm(
  snapshot: TeamRunFormSnapshot,
  options: OpenTeamRunFormOptions = {},
): TeamRunFormModel {
  let profiles: readonly AgentProfile[] | null = snapshot.profiles ?? null;
  let providerEntries: readonly ProviderSnapshotEntry[] | null = null;
  let providerWorkspaceId: string | null = null;
  let providerWorkspaceCwd: string | null = null;
  const featureCatalogs = new Map<string, FeatureCatalogResult>();
  const idempotencyKey = (options.generateIdempotencyKey ?? generateIdempotencyKey)();
  const initialWorkspace = snapshot.workspaces.length === 1 ? snapshot.workspaces[0]! : null;
  let closed = false;
  const listeners = new Set<() => void>();
  let state: TeamRunFormState = {
    serverId: snapshot.serverId,
    team: snapshot.team,
    workspaces: [...snapshot.workspaces],
    selectedWorkspaceId: initialWorkspace?.workspaceId ?? null,
    selectedWorkspaceDisplay: initialWorkspace?.display ?? null,
    selectedWorkspaceCwd: initialWorkspace?.cwd ?? null,
    objective: "",
    roleResolutions: [],
    validationIssue: null,
    canSubmit: false,
    submission: null,
    submitError: null,
  };

  const publish = (next: TeamRunFormState): void => {
    if (closed) return;
    const roleResolutions = resolveRoles({
      team: next.team,
      profiles,
      providerEntries:
        providerWorkspaceId === next.selectedWorkspaceId &&
        providerWorkspaceCwd === next.selectedWorkspaceCwd
          ? providerEntries
          : null,
      selectedWorkspaceCwd: next.selectedWorkspaceCwd,
      featureCatalogs,
    });
    const draft = { ...next, roleResolutions };
    const issue = validationIssue(draft);
    const submission =
      issue === null && draft.selectedWorkspaceId
        ? {
            serverId: draft.serverId,
            teamId: draft.team.id,
            expectedRevision: draft.team.revision,
            idempotencyKey,
            objective: draft.objective.trim(),
            workspaceId: draft.selectedWorkspaceId,
          }
        : null;
    state = {
      ...draft,
      validationIssue: issue,
      canSubmit: submission !== null,
      submission,
    };
    listeners.forEach((listener) => listener());
  };

  publish(state);

  return {
    getState: () => state,
    subscribe: (listener) => {
      if (closed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {
      closed = true;
      listeners.clear();
    },
    applyWorkspaces: (workspaces) => {
      const nextWorkspaces = [...workspaces];
      const selected = nextWorkspaces.find(
        (workspace) => workspace.workspaceId === state.selectedWorkspaceId,
      );
      if (selected && selected.cwd !== state.selectedWorkspaceCwd) {
        providerWorkspaceId = null;
        providerWorkspaceCwd = null;
        providerEntries = null;
      }
      publish({
        ...state,
        workspaces: nextWorkspaces,
        selectedWorkspaceCwd: selected?.cwd ?? state.selectedWorkspaceCwd,
      });
    },
    applyProfiles: (nextProfiles) => {
      profiles = nextProfiles;
      publish(state);
    },
    applyProviderCatalog: (workspaceId, workspaceCwd, entries) => {
      if (
        workspaceId !== state.selectedWorkspaceId ||
        workspaceCwd !== state.selectedWorkspaceCwd
      ) {
        return;
      }
      providerWorkspaceId = workspaceId;
      providerWorkspaceCwd = workspaceCwd;
      providerEntries = entries;
      publish(state);
    },
    applyFeatureCatalog: (roleId, requestKey, features) => {
      const current = featureCatalogs.get(roleId);
      if (current?.requestKey === requestKey && current.features === features) return;
      featureCatalogs.set(roleId, { requestKey, features });
      publish(state);
    },
    setWorkspace: (workspaceId, display) => {
      const workspace = state.workspaces.find((entry) => entry.workspaceId === workspaceId);
      providerWorkspaceId = null;
      providerWorkspaceCwd = null;
      providerEntries = null;
      publish({
        ...state,
        selectedWorkspaceId: workspaceId,
        selectedWorkspaceDisplay: display,
        selectedWorkspaceCwd: workspace?.cwd ?? null,
        submitError: null,
      });
    },
    setObjective: (objective) => publish({ ...state, objective, submitError: null }),
    setSubmitError: (submitError) => publish({ ...state, submitError }),
  };
}
