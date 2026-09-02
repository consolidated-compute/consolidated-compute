import equal from "fast-deep-equal";
import type {
  AgentFeature,
  AgentModelDefinition,
  ProviderSnapshotEntry,
} from "@getpaseo/protocol/agent-types";
import { materializeAgentProfile } from "@getpaseo/protocol/agent-profiles";
import type { AssignmentDto } from "@getpaseo/protocol/assignment/types";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import {
  TEAM_OBJECTIVE_MAX_CHARS,
  type TeamDefinitionDto,
  type TeamRunPreviewDto,
  type TeamSecurityPostureDto,
  type TeamRunSupervisionStartDto,
} from "@getpaseo/protocol/team/types";
import { filterSelectableModels } from "@/provider-selection/model-catalog";
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
  securityPosture: TeamSecurityPostureDto | null;
  status: TeamRunRoleResolutionStatus;
}

export type TeamRunFormValidationIssue =
  | "workspace_required"
  | "workspace_missing"
  | "objective_required"
  | "objective_too_long"
  | "profiles_loading"
  | "profile_unavailable"
  | "security_preview_loading"
  | "security_preview_failed"
  | "supervisor_required"
  | "supervisor_unavailable"
  | "native_delegation_unenforced";

export type TeamRunExecutionMode = "sequential" | "supervised";

export interface TeamRunSupervisorOption {
  roleId: string;
  display: TeamRunFormDisplay;
}

interface TeamRunFormSubmissionBase {
  serverId: string;
  teamId: string;
  expectedRevision: number;
  idempotencyKey: string;
  objective: string;
  workspaceId: string;
  expectedPreviewFingerprint?: string;
}

export type TeamRunFormSubmission = TeamRunFormSubmissionBase &
  (
    | {
        assignmentId: string;
        expectedAssignmentRevision: number;
        supervision?: TeamRunSupervisionStartDto;
      }
    | {
        assignmentId?: never;
        expectedAssignmentRevision?: never;
        supervision?: never;
      }
  );

export interface TeamRunFormState {
  serverId: string;
  team: TeamDefinitionDto;
  workspaces: TeamRunWorkspaceOption[];
  selectedWorkspaceId: string | null;
  selectedWorkspaceDisplay: TeamRunFormDisplay | null;
  selectedWorkspaceCwd: string | null;
  catalogGeneration: number;
  profileGeneration: number;
  objective: string;
  assignment: AssignmentDto | null;
  supervisionSupported: boolean;
  executionMode: TeamRunExecutionMode;
  supervisorOptions: TeamRunSupervisorOption[];
  selectedSupervisorRoleId: string | null;
  selectedSupervisorDisplay: TeamRunFormDisplay | null;
  roleResolutions: TeamRunRoleResolution[];
  securityPreviewStatus: "idle" | "pending" | "ready" | "error" | "unsupported";
  securityPreviewRequest: TeamRunSecurityPreviewRequest | null;
  securityPreviewError: string | null;
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
  assignment?: AssignmentDto;
  supervisionSupported?: boolean;
}

export interface TeamRunFormModel {
  getState: () => TeamRunFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  applyWorkspaces: (workspaces: readonly TeamRunWorkspaceOption[]) => void;
  applyProfiles: (profiles: readonly AgentProfile[] | null) => void;
  applySupervisionCapability: (supported: boolean) => void;
  applyProviderCatalog: (
    workspaceId: string,
    workspaceCwd: string,
    entries: readonly ProviderSnapshotEntry[] | null,
  ) => void;
  applySecurityPreviewCapability: (supported: boolean) => void;
  applySecurityPreviewPending: (requestKey: string) => void;
  applySecurityPreview: (requestKey: string, preview: TeamRunPreviewDto) => void;
  applySecurityPreviewError: (requestKey: string, error: string) => void;
  applyFeatureCatalog: (
    roleId: string,
    requestKey: string,
    features: readonly AgentFeature[] | null,
  ) => void;
  setWorkspace: (workspaceId: string, display: TeamRunFormDisplay) => void;
  setObjective: (value: string) => void;
  setExecutionMode: (mode: TeamRunExecutionMode) => void;
  setSupervisor: (roleId: string, display: TeamRunFormDisplay) => void;
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

export interface TeamRunFeatureProbe {
  requestKey: string;
  roleIds: string[];
  config: TeamRunFeatureRequest["config"];
}

export interface TeamRunSecurityPreviewRequest {
  requestKey: string;
  input: {
    teamId: string;
    expectedRevision: number;
    workspaceId: string;
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

export function buildTeamRunSupervisorOptions(team: TeamDefinitionDto): TeamRunSupervisorOption[] {
  const workerRoleIds = new Set(team.workflow.map((step) => step.roleId));
  return team.roles
    .filter((role) => !workerRoleIds.has(role.id))
    .map((role) => ({
      roleId: role.id,
      display: { label: role.name },
    }));
}

function generateIdempotencyKey(): string {
  return `team-run-${crypto.randomUUID()}`;
}

function findModel(models: readonly AgentModelDefinition[], requested: string) {
  return models.find((model) => model.id === requested || model.aliases?.includes(requested));
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
  catalogGeneration: number,
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
    requestKey: JSON.stringify([catalogGeneration, config]),
    config,
  };
}

export function buildTeamRunFeatureProbes(
  requests: readonly TeamRunFeatureRequest[],
): TeamRunFeatureProbe[] {
  const probes = new Map<string, TeamRunFeatureProbe>();
  for (const request of requests) {
    const existing = probes.get(request.requestKey);
    if (existing) {
      existing.roleIds.push(request.roleId);
      continue;
    }
    probes.set(request.requestKey, {
      requestKey: request.requestKey,
      roleIds: [request.roleId],
      config: request.config,
    });
  }
  return [...probes.values()];
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
    securityPosture: null,
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
  const selectableModels = filterSelectableModels(readyProvider.models ?? null) ?? [];

  const requestedModel = materialized.modelId;
  const model = requestedModel
    ? findModel(selectableModels, requestedModel)
    : (selectableModels.find((entry) => entry.isDefault) ?? selectableModels[0]);
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
  catalogGeneration: number;
  featureCatalogs: ReadonlyMap<string, FeatureCatalogResult>;
}): TeamRunRoleResolution[] {
  return input.team.roles.map((role) => {
    const profile = resolveProfile(role, input.profiles);
    const resolution = profile.resolved
      ? resolveProvider(profile, input.providerEntries)
      : profile.resolution;
    if (resolution.status !== "ready") return resolution;
    const request = buildTeamRunFeatureRequest(
      resolution,
      input.selectedWorkspaceCwd,
      input.catalogGeneration,
    );
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

function applySecurityPreview(
  resolutions: readonly TeamRunRoleResolution[],
  preview: TeamRunPreviewDto | null,
): TeamRunRoleResolution[] {
  if (!preview) return [...resolutions];
  const roles = new Map(preview.roles.map((role) => [role.roleId, role]));
  return resolutions.map((resolution) => {
    const previewRole = roles.get(resolution.roleId);
    if (!previewRole || resolution.status !== "ready") return resolution;
    const launch = previewRole.resolvedLaunch;
    return {
      ...resolution,
      profileId: launch.profileId,
      provider: launch.provider,
      model: launch.model,
      modeId: launch.modeId,
      thinkingOptionId: launch.thinkingOptionId,
      featureValues: launch.featureValues,
      securityPosture: launch.securityPosture ?? null,
    };
  });
}

function buildSecurityPreviewRequest(
  state: TeamRunFormState,
): TeamRunSecurityPreviewRequest | null {
  if (!state.selectedWorkspaceId || !state.selectedWorkspaceCwd) {
    return null;
  }
  return {
    requestKey: JSON.stringify([
      state.team.id,
      state.team.revision,
      state.selectedWorkspaceId,
      state.selectedWorkspaceCwd,
      state.profileGeneration,
      state.catalogGeneration,
    ]),
    input: {
      teamId: state.team.id,
      expectedRevision: state.team.revision,
      workspaceId: state.selectedWorkspaceId,
    },
  };
}

interface ResolvedSecurityPreview {
  requestKey: string;
  preview: TeamRunPreviewDto;
}

interface SecurityPreviewFailure {
  requestKey: string;
  error: string;
}

function isCompleteSecurityPreview(preview: TeamRunPreviewDto, state: TeamRunFormState): boolean {
  if (
    preview.workspace.workspaceId !== state.selectedWorkspaceId ||
    preview.workspace.cwd !== state.selectedWorkspaceCwd ||
    preview.roles.length !== state.team.roles.length
  ) {
    return false;
  }
  const roles = new Map(preview.roles.map((role) => [role.roleId, role]));
  return state.team.roles.every((role) => {
    const previewRole = roles.get(role.id);
    return (
      previewRole?.roleName === role.name &&
      previewRole.resolvedLaunch.securityPosture !== undefined
    );
  });
}

function resolveSecurityPreview(input: {
  capability: boolean | null;
  request: TeamRunSecurityPreviewRequest | null;
  resolved: ResolvedSecurityPreview | null;
  failure: SecurityPreviewFailure | null;
  state: TeamRunFormState;
}): {
  status: TeamRunFormState["securityPreviewStatus"];
  error: string | null;
  preview: TeamRunPreviewDto | null;
} {
  if (input.capability === null) return { status: "pending", error: null, preview: null };
  if (!input.capability) return { status: "unsupported", error: null, preview: null };
  if (!input.request) return { status: "idle", error: null, preview: null };
  if (input.failure?.requestKey === input.request.requestKey) {
    return { status: "error", error: input.failure.error, preview: null };
  }
  if (input.resolved?.requestKey !== input.request.requestKey) {
    return { status: "pending", error: null, preview: null };
  }
  if (!isCompleteSecurityPreview(input.resolved.preview, input.state)) {
    return { status: "error", error: null, preview: null };
  }
  return { status: "ready", error: null, preview: input.resolved.preview };
}

function securityPreviewValidationIssue(
  capability: boolean | null,
  status: TeamRunFormState["securityPreviewStatus"],
): TeamRunFormValidationIssue | null {
  if (capability === null || (capability && (status === "idle" || status === "pending"))) {
    return "security_preview_loading";
  }
  return capability && status === "error" ? "security_preview_failed" : null;
}

function buildSubmission(
  state: TeamRunFormState,
  idempotencyKey: string,
  preview: TeamRunPreviewDto | null,
): TeamRunFormSubmission | null {
  if (!state.selectedWorkspaceId) return null;
  const base = {
    serverId: state.serverId,
    teamId: state.team.id,
    expectedRevision: state.team.revision,
    idempotencyKey,
    objective: state.objective.trim(),
    workspaceId: state.selectedWorkspaceId,
    ...(preview ? { expectedPreviewFingerprint: preview.fingerprint } : {}),
  };
  if (!state.assignment) return base;
  return {
    ...base,
    assignmentId: state.assignment.id,
    expectedAssignmentRevision: state.assignment.revision,
    ...(state.executionMode === "supervised" && state.selectedSupervisorRoleId
      ? { supervision: { supervisorRoleId: state.selectedSupervisorRoleId } }
      : {}),
  };
}

function baseValidationIssue(state: TeamRunFormState): TeamRunFormValidationIssue | null {
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
  if (state.executionMode === "supervised") {
    if (
      !state.selectedSupervisorRoleId ||
      !state.supervisorOptions.some((option) => option.roleId === state.selectedSupervisorRoleId)
    ) {
      return state.supervisorOptions.length === 0
        ? "supervisor_unavailable"
        : "supervisor_required";
    }
    if (state.securityPreviewStatus === "unsupported") {
      return "native_delegation_unenforced";
    }
    if (
      state.securityPreviewStatus === "ready" &&
      !supervisedRoleResolutions(state).every(
        (resolution) => resolution.securityPosture?.nativeDelegation?.status === "enforced",
      )
    ) {
      return "native_delegation_unenforced";
    }
  }
  return null;
}

function supervisedRoleResolutions(state: TeamRunFormState): TeamRunRoleResolution[] {
  const roleIds = new Set(state.team.workflow.map((step) => step.roleId));
  if (state.selectedSupervisorRoleId) roleIds.add(state.selectedSupervisorRoleId);
  return state.roleResolutions.filter((resolution) => roleIds.has(resolution.roleId));
}

export function openTeamRunForm(
  snapshot: TeamRunFormSnapshot,
  options: OpenTeamRunFormOptions = {},
): TeamRunFormModel {
  let profiles: readonly AgentProfile[] | null = snapshot.profiles ?? null;
  let providerEntries: readonly ProviderSnapshotEntry[] | null = null;
  let providerWorkspaceId: string | null = null;
  let providerWorkspaceCwd: string | null = null;
  let securityPreviewCapability: boolean | null = null;
  let resolvedSecurityPreview: { requestKey: string; preview: TeamRunPreviewDto } | null = null;
  let securityPreviewFailure: { requestKey: string; error: string } | null = null;
  const featureCatalogs = new Map<string, FeatureCatalogResult>();
  const idempotencyKey = (options.generateIdempotencyKey ?? generateIdempotencyKey)();
  const initialWorkspace = snapshot.workspaces.length === 1 ? snapshot.workspaces[0]! : null;
  const supervisorOptions = buildTeamRunSupervisorOptions(snapshot.team);
  const initialSupervisor = supervisorOptions.length === 1 ? supervisorOptions[0]! : null;
  let closed = false;
  const listeners = new Set<() => void>();
  let state: TeamRunFormState = {
    serverId: snapshot.serverId,
    team: snapshot.team,
    workspaces: [...snapshot.workspaces],
    selectedWorkspaceId: initialWorkspace?.workspaceId ?? null,
    selectedWorkspaceDisplay: initialWorkspace?.display ?? null,
    selectedWorkspaceCwd: initialWorkspace?.cwd ?? null,
    catalogGeneration: 0,
    profileGeneration: 0,
    objective: snapshot.assignment?.objective ?? "",
    assignment: snapshot.assignment ?? null,
    supervisionSupported: snapshot.supervisionSupported ?? false,
    executionMode: "sequential",
    supervisorOptions,
    selectedSupervisorRoleId: initialSupervisor?.roleId ?? null,
    selectedSupervisorDisplay: initialSupervisor?.display ?? null,
    roleResolutions: [],
    securityPreviewStatus: "idle",
    securityPreviewRequest: null,
    securityPreviewError: null,
    validationIssue: null,
    canSubmit: false,
    submission: null,
    submitError: null,
  };

  const publish = (next: TeamRunFormState): void => {
    if (closed) return;
    const localRoleResolutions = resolveRoles({
      team: next.team,
      profiles,
      providerEntries:
        providerWorkspaceId === next.selectedWorkspaceId &&
        providerWorkspaceCwd === next.selectedWorkspaceCwd
          ? providerEntries
          : null,
      selectedWorkspaceCwd: next.selectedWorkspaceCwd,
      catalogGeneration: next.catalogGeneration,
      featureCatalogs,
    });
    const previewDraft = { ...next, roleResolutions: localRoleResolutions };
    const previewRequest = buildSecurityPreviewRequest(previewDraft);
    const securityPreview = resolveSecurityPreview({
      capability: securityPreviewCapability,
      request: previewRequest,
      resolved: resolvedSecurityPreview,
      failure: securityPreviewFailure,
      state: previewDraft,
    });
    const roleResolutions = applySecurityPreview(localRoleResolutions, securityPreview.preview);
    const draft = {
      ...next,
      roleResolutions,
      securityPreviewStatus: securityPreview.status,
      securityPreviewRequest: securityPreviewCapability === true ? previewRequest : null,
      securityPreviewError: securityPreview.error,
    };
    const issue =
      baseValidationIssue(draft) ??
      securityPreviewValidationIssue(securityPreviewCapability, securityPreview.status);
    const submission =
      issue === null ? buildSubmission(draft, idempotencyKey, securityPreview.preview) : null;
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
      const selectedWasAvailable = state.workspaces.some(
        (workspace) => workspace.workspaceId === state.selectedWorkspaceId,
      );
      const previousSelected = state.workspaces.find(
        (workspace) => workspace.workspaceId === state.selectedWorkspaceId,
      );
      const selected = nextWorkspaces.find(
        (workspace) => workspace.workspaceId === state.selectedWorkspaceId,
      );
      const selectionContextChanged =
        Boolean(selected) !== selectedWasAvailable ||
        (selected !== undefined && selected.cwd !== state.selectedWorkspaceCwd);
      const previewContextChanged =
        selectionContextChanged || selected?.display.label !== previousSelected?.display.label;
      if (selectionContextChanged) {
        providerWorkspaceId = null;
        providerWorkspaceCwd = null;
        providerEntries = null;
      }
      publish({
        ...state,
        workspaces: nextWorkspaces,
        selectedWorkspaceCwd: selected?.cwd ?? null,
        catalogGeneration: previewContextChanged
          ? state.catalogGeneration + 1
          : state.catalogGeneration,
      });
    },
    applyProfiles: (nextProfiles) => {
      const changed = !equal(profiles, nextProfiles);
      profiles = nextProfiles;
      publish({
        ...state,
        profileGeneration: changed ? state.profileGeneration + 1 : state.profileGeneration,
      });
    },
    applySupervisionCapability: (supported) => {
      if (state.supervisionSupported === supported) return;
      publish({
        ...state,
        supervisionSupported: supported,
        executionMode: supported ? state.executionMode : "sequential",
        submitError: null,
      });
    },
    applyProviderCatalog: (workspaceId, workspaceCwd, entries) => {
      if (
        workspaceId !== state.selectedWorkspaceId ||
        workspaceCwd !== state.selectedWorkspaceCwd
      ) {
        return;
      }
      if (
        providerWorkspaceId === workspaceId &&
        providerWorkspaceCwd === workspaceCwd &&
        equal(providerEntries, entries)
      ) {
        return;
      }
      providerWorkspaceId = workspaceId;
      providerWorkspaceCwd = workspaceCwd;
      providerEntries = entries;
      const previewInFlight =
        state.securityPreviewStatus === "pending" && state.securityPreviewRequest !== null;
      publish({
        ...state,
        catalogGeneration: previewInFlight ? state.catalogGeneration : state.catalogGeneration + 1,
      });
    },
    applySecurityPreviewCapability: (supported) => {
      if (securityPreviewCapability === supported) return;
      securityPreviewCapability = supported;
      publish(state);
    },
    applySecurityPreviewPending: (requestKey) => {
      if (requestKey !== state.securityPreviewRequest?.requestKey) return;
      if (!securityPreviewFailure && resolvedSecurityPreview?.requestKey !== requestKey) return;
      resolvedSecurityPreview = null;
      securityPreviewFailure = null;
      publish(state);
    },
    applySecurityPreview: (requestKey, preview) => {
      if (requestKey !== state.securityPreviewRequest?.requestKey) return;
      if (
        resolvedSecurityPreview?.requestKey === requestKey &&
        equal(resolvedSecurityPreview.preview, preview)
      ) {
        return;
      }
      resolvedSecurityPreview = { requestKey, preview };
      securityPreviewFailure = null;
      publish(state);
    },
    applySecurityPreviewError: (requestKey, error) => {
      if (requestKey !== state.securityPreviewRequest?.requestKey) return;
      if (
        securityPreviewFailure?.requestKey === requestKey &&
        securityPreviewFailure.error === error
      ) {
        return;
      }
      securityPreviewFailure = { requestKey, error };
      publish(state);
    },
    applyFeatureCatalog: (roleId, requestKey, features) => {
      const current = featureCatalogs.get(roleId);
      if (current?.requestKey === requestKey && equal(current.features, features)) return;
      featureCatalogs.set(roleId, { requestKey, features });
      publish(state);
    },
    setWorkspace: (workspaceId, display) => {
      const workspace = state.workspaces.find((entry) => entry.workspaceId === workspaceId);
      const selectionContextChanged =
        workspaceId !== state.selectedWorkspaceId || workspace?.cwd !== state.selectedWorkspaceCwd;
      if (selectionContextChanged) {
        providerWorkspaceId = null;
        providerWorkspaceCwd = null;
        providerEntries = null;
      }
      publish({
        ...state,
        selectedWorkspaceId: workspaceId,
        selectedWorkspaceDisplay: display,
        selectedWorkspaceCwd: workspace?.cwd ?? null,
        catalogGeneration: selectionContextChanged
          ? state.catalogGeneration + 1
          : state.catalogGeneration,
        submitError: null,
      });
    },
    setObjective: (objective) => {
      if (state.assignment) return;
      publish({ ...state, objective, submitError: null });
    },
    setExecutionMode: (executionMode) => {
      if (executionMode === "supervised" && (!state.assignment || !state.supervisionSupported)) {
        return;
      }
      publish({ ...state, executionMode, submitError: null });
    },
    setSupervisor: (roleId, display) => {
      if (!state.supervisorOptions.some((option) => option.roleId === roleId)) return;
      publish({
        ...state,
        selectedSupervisorRoleId: roleId,
        selectedSupervisorDisplay: display,
        submitError: null,
      });
    },
    setSubmitError: (submitError) => publish({ ...state, submitError }),
  };
}
