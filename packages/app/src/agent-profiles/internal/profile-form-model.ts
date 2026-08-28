import equal from "fast-deep-equal";
import type {
  AgentFeature,
  AgentMode,
  AgentModelDefinition,
  AgentProfileSecurityPreset,
  AgentSelectOption,
  ProviderSnapshotEntry,
} from "@getpaseo/protocol/agent-types";
import type { AgentProfile, AgentProfilePatch } from "@getpaseo/protocol/messages";
import { formatAgentModeLabel, formatThinkingOptionLabel } from "@/agent-controls/labels";
import { applyFeatureValues, pruneFeatureValues } from "@/hooks/feature-preferences";
import { filterSelectableModels } from "@/provider-selection/model-catalog";

/**
 * The profile patch minus the id; the list owns identity.
 *
 * `Omit` does not work here. `AgentProfilePatchSchema` is `.passthrough()`, so
 * `AgentProfilePatch` carries a `[key: string]: unknown` index signature, and
 * `Exclude<keyof AgentProfilePatch, "id">` stays `string | number` — the named keys
 * come back as `unknown` and `name`/`provider` stop being required. Mapping
 * `keyof` with an `as` filter drops the index signature and the id together.
 */
export type AgentProfileValue = {
  [K in keyof AgentProfilePatch as string extends K
    ? never
    : K extends "id"
      ? never
      : K]: AgentProfilePatch[K];
};

export interface AgentProfileFormDisplay {
  label: string;
  description?: string;
}

export interface AgentProfileFormOption {
  id: string;
  value: string;
  label: string;
  description?: string;
  testID: string;
}

/**
 * Pre-fill values for create mode. Only used when `mode === "create"`; edit
 * mode always seeds from the stored `profile` and ignores this.
 */
export interface AgentProfileSeed {
  provider: string;
  modelId?: string;
  name?: string;
  providerDisplay?: AgentProfileFormDisplay;
  modelDisplay?: AgentProfileFormDisplay;
}

export interface AgentProfileSelectionDisplays {
  provider?: AgentProfileFormDisplay;
  model?: AgentProfileFormDisplay;
  mode?: AgentProfileFormDisplay;
  thinking?: AgentProfileFormDisplay;
}

export interface AgentProfileFormSnapshot {
  mode: "create" | "edit";
  profile?: AgentProfile;
  profileDisplays?: AgentProfileSelectionDisplays;
  seed?: AgentProfileSeed;
  customSecurityDisplay?: AgentProfileFormDisplay;
}

/**
 * The inputs a feature listing needs. Features are provider-scoped and change
 * with model/mode/thinking, so every one of those is part of the request.
 */
export interface AgentProfileFeatureRequest {
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
}

export type AgentProfileResolutionStatus = "idle" | "pending" | "complete";

export type AgentProfileSecurityStatus =
  | "idle"
  | "pending"
  | "available"
  | "unrecognized"
  | "stale"
  | "read_only"
  | "unavailable"
  | "unsupported"
  | "update_required";

export interface AgentProfileFormDisclosure {
  showModelField: boolean;
  showModeField: boolean;
  showThinkingField: boolean;
  showFeaturesField: boolean;
  showSecurityPresetField: boolean;
}

export interface AgentProfileFormState {
  mode: "create" | "edit";
  name: string;
  icon: string;
  color: string;
  notes: string;
  provider: string;
  modelId: string;
  modeId: string;
  thinkingOptionId: string;
  featureValues: Record<string, unknown>;

  providerChoices: AgentProfileFormOption[];
  modelOptions: AgentProfileFormOption[];
  modeOptions: AgentProfileFormOption[];
  thinkingOptions: AgentProfileFormOption[];
  securityPresetOptions: AgentProfileFormOption[];
  features: AgentFeature[];

  providerDisplay: AgentProfileFormDisplay | null;
  modelDisplay: AgentProfileFormDisplay | null;
  modeDisplay: AgentProfileFormDisplay | null;
  thinkingDisplay: AgentProfileFormDisplay | null;
  securityPresetId: string | null;
  securityPresetDisplay: AgentProfileFormDisplay | null;

  catalogResolution: AgentProfileResolutionStatus;
  catalogError: string | null;
  catalogRetryAvailable: boolean;
  featureResolution: AgentProfileResolutionStatus;
  featureRequest: AgentProfileFeatureRequest | null;
  featureRequestKey: string | null;
  securityCapabilityResolution: AgentProfileResolutionStatus;
  securityStatus: AgentProfileSecurityStatus;

  disclosure: AgentProfileFormDisclosure;
  isSubmitting: boolean;
  submitError: string | null;
  canSubmit: boolean;
  submitValue: AgentProfileValue | null;
}

export interface AgentProfileFormModel {
  getState: () => AgentProfileFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  /** Late input: the host-scoped provider catalog. Never touches selections. */
  applyProviderCatalog: (entries: readonly ProviderSnapshotEntry[]) => void;
  /** Resolve a provider catalog request that failed without usable cached data. */
  applyProviderCatalogUnavailable: (error: string) => void;
  /** Late input: whether this host can persist provider-native profile options. */
  applySecurityCapability: (supported: boolean) => void;
  /** Late input: the feature list for one request. Stale keys are ignored. */
  applyFeatures: (requestKey: string, features: readonly AgentFeature[]) => void;
  /** Resolve a request that produced no usable features (provider error). */
  applyFeaturesUnavailable: (requestKey: string) => void;
  setName: (value: string) => void;
  setAppearance: (value: { icon: string; color: string }) => void;
  setNotes: (value: string) => void;
  setProvider: (providerId: string, display: AgentProfileFormDisplay) => void;
  setModel: (modelId: string, display: AgentProfileFormDisplay | null) => void;
  setMode: (modeId: string, display: AgentProfileFormDisplay | null) => void;
  setThinking: (thinkingOptionId: string, display: AgentProfileFormDisplay | null) => void;
  setSecurityPreset: (presetId: string, display: AgentProfileFormDisplay) => void;
  setFeatureValue: (featureId: string, value: unknown) => void;
  setSubmitting: (value: boolean) => void;
  setSubmitError: (value: string | null) => void;
}

interface CapturedSecurityPreset {
  provider: string;
  id: string;
  display: AgentProfileFormDisplay;
  providerOptions: NonNullable<AgentProfile["providerOptions"]>;
}

interface SecurityResolution {
  status: AgentProfileSecurityStatus;
  presets: readonly AgentProfileSecurityPreset[];
}

function findEntry(
  entries: readonly ProviderSnapshotEntry[],
  provider: string,
): ProviderSnapshotEntry | null {
  if (!provider) {
    return null;
  }
  return entries.find((entry) => entry.provider === provider) ?? null;
}

function resolveModels(
  entries: readonly ProviderSnapshotEntry[],
  provider: string,
): AgentModelDefinition[] {
  return filterSelectableModels(findEntry(entries, provider)?.models ?? null) ?? [];
}

function resolveModes(entries: readonly ProviderSnapshotEntry[], provider: string): AgentMode[] {
  return findEntry(entries, provider)?.modes ?? [];
}

/**
 * Thinking options hang off a model, so an unset model still has to resolve to
 * the model the daemon would pick — otherwise the field disappears whenever the
 * user leaves the model on "provider default".
 */
function resolveEffectiveModel(
  models: readonly AgentModelDefinition[],
  modelId: string,
): AgentModelDefinition | null {
  const trimmed = modelId.trim();
  if (trimmed) {
    return models.find((model) => model.id === trimmed) ?? null;
  }
  return models.find((model) => model.isDefault) ?? models[0] ?? null;
}

function resolveThinkingOptions(
  entries: readonly ProviderSnapshotEntry[],
  provider: string,
  modelId: string,
): AgentSelectOption[] {
  return resolveEffectiveModel(resolveModels(entries, provider), modelId)?.thinkingOptions ?? [];
}

/** Every real option is selected by its own id; only the unset row differs. */
function formOption(input: {
  id: string;
  label: string;
  description: string | undefined;
  testID: string;
}): AgentProfileFormOption {
  return {
    id: input.id,
    value: input.id,
    label: input.label,
    ...(input.description ? { description: input.description } : {}),
    testID: input.testID,
  };
}

function buildProviderChoices(entries: readonly ProviderSnapshotEntry[]): AgentProfileFormOption[] {
  return entries
    .filter((entry) => entry.enabled)
    .map((entry) =>
      formOption({
        id: entry.provider,
        label: entry.label ?? entry.provider,
        description: entry.description,
        testID: `agent-profile-provider-option-${entry.provider}`,
      }),
    );
}

function buildSecurityPresetOptions(
  presets: readonly AgentProfileSecurityPreset[],
): AgentProfileFormOption[] {
  return presets.map((preset) =>
    formOption({
      id: preset.id,
      label: preset.label,
      description: preset.description,
      testID: `agent-profile-security-option-${preset.id}`,
    }),
  );
}

function cloneProviderOptions(
  value: NonNullable<AgentProfile["providerOptions"]>,
): NonNullable<AgentProfile["providerOptions"]> {
  return JSON.parse(JSON.stringify(value)) as NonNullable<AgentProfile["providerOptions"]>;
}

function resolveLegacySecurityState(input: {
  provider: string;
  preservedProvider: string | undefined;
  preservedProviderOptions: AgentProfile["providerOptions"] | undefined;
}): SecurityResolution {
  const providerChanged =
    input.preservedProvider !== undefined && input.provider !== input.preservedProvider;
  if (providerChanged && input.preservedProviderOptions !== undefined) {
    return { status: "update_required", presets: [] };
  }
  if (input.provider === input.preservedProvider && input.preservedProviderOptions !== undefined) {
    return { status: "read_only", presets: [] };
  }
  return { status: "unsupported", presets: [] };
}

function resolveLegacyCapabilitySecurityState(input: {
  provider: string;
  preservedProvider: string | undefined;
  preservedProviderOptions: AgentProfile["providerOptions"] | undefined;
  captured: CapturedSecurityPreset | null;
}): SecurityResolution {
  if (
    input.captured?.provider === input.provider &&
    (input.provider !== input.preservedProvider ||
      input.preservedProviderOptions === undefined ||
      !equal(input.captured.providerOptions, input.preservedProviderOptions))
  ) {
    return { status: "update_required", presets: [] };
  }
  return resolveLegacySecurityState(input);
}

function resolveCatalogSecurityFailure(input: {
  provider: string;
  preservedProvider: string | undefined;
  preservedProviderOptions: AgentProfile["providerOptions"] | undefined;
  catalogError: string | null;
  entry: ProviderSnapshotEntry | null;
}): SecurityResolution | null {
  if (input.entry?.status === "loading") return { status: "pending", presets: [] };
  const failed =
    Boolean(input.catalogError) ||
    input.entry?.status === "error" ||
    input.entry?.status === "unavailable";
  if (!failed) return null;
  if (input.provider === input.preservedProvider && input.preservedProviderOptions !== undefined) {
    return { status: "read_only", presets: [] };
  }
  return { status: "unavailable", presets: [] };
}

function resolveCapturedSecurityState(
  entry: ProviderSnapshotEntry | null,
  presets: readonly AgentProfileSecurityPreset[],
  captured: CapturedSecurityPreset,
): SecurityResolution {
  if (entry?.status === "loading") return { status: "pending", presets: [] };
  const current = presets.find((preset) => preset.id === captured.id);
  if (
    entry?.status !== "ready" ||
    !current ||
    !equal(current.providerOptions, captured.providerOptions)
  ) {
    return { status: "stale", presets: entry?.status === "ready" ? presets : [] };
  }
  return { status: "available", presets };
}

function resolveUnrecognizedSecurityState(
  entry: ProviderSnapshotEntry | null,
  presets: readonly AgentProfileSecurityPreset[],
): SecurityResolution {
  if (entry?.status !== "ready" || presets.length === 0) {
    return { status: "read_only", presets: [] };
  }
  return { status: "unrecognized", presets };
}

function buildDisclosure(input: {
  hasProvider: boolean;
  models: readonly AgentModelDefinition[];
  modes: readonly AgentMode[];
  thinking: readonly AgentSelectOption[];
  features: readonly AgentFeature[];
  modelId: string;
  modeId: string;
  thinkingOptionId: string;
  security: SecurityResolution;
}): AgentProfileFormDisclosure {
  const editableSecurityStatuses: ReadonlySet<AgentProfileSecurityStatus> = new Set([
    "available",
    "unrecognized",
    "stale",
  ]);
  const securityNoticeStatuses: ReadonlySet<AgentProfileSecurityStatus> = new Set([
    "pending",
    "unrecognized",
    "stale",
    "read_only",
    "unavailable",
    "update_required",
  ]);
  return {
    showModelField: input.hasProvider && (input.models.length > 0 || Boolean(input.modelId)),
    showModeField: input.hasProvider && (input.modes.length > 0 || Boolean(input.modeId)),
    showThinkingField:
      input.hasProvider && (input.thinking.length > 0 || Boolean(input.thinkingOptionId)),
    showFeaturesField: input.hasProvider && input.features.length > 0,
    showSecurityPresetField:
      input.hasProvider &&
      (editableSecurityStatuses.has(input.security.status) ||
        securityNoticeStatuses.has(input.security.status)),
  };
}

function securityBlocksSubmit(status: AgentProfileSecurityStatus): boolean {
  return status === "pending" || status === "stale" || status === "update_required";
}

function buildModelOptions(models: readonly AgentModelDefinition[]): AgentProfileFormOption[] {
  return models.map((model) =>
    formOption({
      id: model.id,
      label: model.label,
      // Models are labelled by family, so the id is the only thing that
      // distinguishes two entries with the same label.
      description: model.description ?? model.id,
      testID: `agent-profile-model-option-${model.id}`,
    }),
  );
}

function buildModeOptions(modes: readonly AgentMode[]): AgentProfileFormOption[] {
  return modes.map((mode) =>
    formOption({
      id: mode.id,
      label: formatAgentModeLabel(mode),
      description: mode.description,
      testID: `agent-profile-mode-option-${mode.id}`,
    }),
  );
}

function buildThinkingOptions(options: readonly AgentSelectOption[]): AgentProfileFormOption[] {
  return options.map((option) =>
    formOption({
      id: option.id,
      label: formatThinkingOptionLabel(option),
      description: option.description,
      testID: `agent-profile-thinking-option-${option.id}`,
    }),
  );
}

/**
 * Every selection resolves to a concrete id.
 *
 * Each list used to carry a synthetic "Provider default" row. It read as a value
 * you could choose but stored an absent one, so a profile that looked fully
 * specified would apply whatever the host preferred at the time — and two hosts
 * would materialize the same profile differently. The schedule form never
 * offered that row; this form now matches it and seeds the catalog's own default
 * instead, so what the form shows is what the profile stores.
 */
function defaultModelId(models: readonly AgentModelDefinition[]): string {
  return models.find((model) => model.isDefault)?.id ?? models[0]?.id ?? "";
}

function defaultModeId(entry: ProviderSnapshotEntry | null, modes: readonly AgentMode[]): string {
  return entry?.defaultModeId ?? modes[0]?.id ?? "";
}

function defaultThinkingOptionId(model: AgentModelDefinition | null): string {
  const options = model?.thinkingOptions ?? [];
  return (
    model?.defaultThinkingOptionId ??
    options.find((option) => option.isDefault)?.id ??
    options[0]?.id ??
    ""
  );
}

function catalogDisplay(label: string, description: string | undefined): AgentProfileFormDisplay {
  return { label, ...(description ? { description } : {}) };
}

function seedModelSelection(
  state: AgentProfileFormState,
  models: readonly AgentModelDefinition[],
): { id: string; display: AgentProfileFormDisplay | null } {
  if (state.modelId) return { id: state.modelId, display: state.modelDisplay };
  const selected = models.find((model) => model.id === defaultModelId(models));
  return {
    id: selected?.id ?? "",
    display: selected ? catalogDisplay(selected.label, selected.description) : null,
  };
}

function seedModeSelection(
  state: AgentProfileFormState,
  entry: ProviderSnapshotEntry | null,
  modes: readonly AgentMode[],
): { id: string; display: AgentProfileFormDisplay | null } {
  if (state.modeId) return { id: state.modeId, display: state.modeDisplay };
  const selected = modes.find((mode) => mode.id === defaultModeId(entry, modes));
  return {
    id: selected?.id ?? "",
    display: selected ? catalogDisplay(formatAgentModeLabel(selected), selected.description) : null,
  };
}

function seedThinkingSelection(
  state: AgentProfileFormState,
  models: readonly AgentModelDefinition[],
  modelId: string,
): { id: string; display: AgentProfileFormDisplay | null } {
  if (state.thinkingOptionId) {
    return { id: state.thinkingOptionId, display: state.thinkingDisplay };
  }
  const effectiveModel = resolveEffectiveModel(models, modelId);
  const defaultId = defaultThinkingOptionId(effectiveModel);
  const selected = effectiveModel?.thinkingOptions?.find((option) => option.id === defaultId);
  return {
    id: selected?.id ?? "",
    display: selected
      ? catalogDisplay(formatThinkingOptionLabel(selected), selected.description)
      : null,
  };
}

function seedSelections(
  next: AgentProfileFormState,
  input: {
    entry: ProviderSnapshotEntry | null;
    models: readonly AgentModelDefinition[];
    modes: readonly AgentMode[];
  },
): AgentProfileFormState {
  const model = seedModelSelection(next, input.models);
  const mode = seedModeSelection(next, input.entry, input.modes);
  const thinking = seedThinkingSelection(next, input.models, model.id);
  if (
    model.id === next.modelId &&
    mode.id === next.modeId &&
    thinking.id === next.thinkingOptionId
  ) {
    return next;
  }
  return {
    ...next,
    modelId: model.id,
    modelDisplay: model.display,
    modeId: mode.id,
    modeDisplay: mode.display,
    thinkingOptionId: thinking.id,
    thinkingDisplay: thinking.display,
  };
}

function resolveSecuritySelection(input: {
  provider: string;
  captured: CapturedSecurityPreset | null;
  unrecognized: boolean;
  customDisplay: AgentProfileFormDisplay;
}): { id: string | null; display: AgentProfileFormDisplay | null } {
  if (input.captured?.provider === input.provider) {
    return { id: input.captured.id, display: input.captured.display };
  }
  return input.unrecognized
    ? { id: "custom", display: input.customDisplay }
    : { id: null, display: null };
}

function buildFeatureRequest(state: AgentProfileFormState): AgentProfileFeatureRequest | null {
  if (!state.provider) {
    return null;
  }
  return {
    provider: state.provider,
    ...(state.modelId ? { model: state.modelId } : {}),
    ...(state.modeId ? { modeId: state.modeId } : {}),
    ...(state.thinkingOptionId ? { thinkingOptionId: state.thinkingOptionId } : {}),
  };
}

export function buildFeatureRequestKey(request: AgentProfileFeatureRequest | null): string | null {
  if (!request) {
    return null;
  }
  return [
    request.provider,
    request.model ?? "",
    request.modeId ?? "",
    request.thinkingOptionId ?? "",
  ].join("|");
}

function buildSubmitValue(
  state: AgentProfileFormState,
  providerOptions: AgentProfile["providerOptions"] | null | undefined,
): AgentProfileValue | null {
  const name = state.name.trim();
  const notes = state.notes.trim();
  if (!name || !state.provider) {
    return null;
  }
  return {
    name,
    ...(state.icon ? { icon: state.icon } : {}),
    ...(state.color ? { color: state.color } : {}),
    provider: state.provider,
    ...(state.modelId ? { model: state.modelId } : {}),
    ...(state.modeId ? { modeId: state.modeId } : {}),
    ...(state.thinkingOptionId ? { thinkingOptionId: state.thinkingOptionId } : {}),
    ...(Object.keys(state.featureValues).length > 0 ? { featureValues: state.featureValues } : {}),
    ...(notes ? { notes } : {}),
    ...(providerOptions !== undefined ? { providerOptions } : {}),
  };
}

function resolveFeatureStatus(
  featureRequestKey: string | null,
  featuresAreCurrent: boolean,
): AgentProfileResolutionStatus {
  if (featureRequestKey === null) {
    return "idle";
  }
  return featuresAreCurrent ? "complete" : "pending";
}

const BLANK_PROFILE: AgentProfileValue = { name: "", provider: "" };

/** A stored id doubles as its own captured label when no display was provided. */
function seedDisplay(value: string | undefined): AgentProfileFormDisplay | null {
  return value ? { label: value } : null;
}

function buildInitialDisplays(input: {
  snapshot: AgentProfileFormSnapshot;
  provider: string;
  modelId: string;
  modeId: string | undefined;
  thinkingOptionId: string | undefined;
}): {
  provider: AgentProfileFormDisplay | null;
  model: AgentProfileFormDisplay | null;
  mode: AgentProfileFormDisplay | null;
  thinking: AgentProfileFormDisplay | null;
} {
  if (input.snapshot.mode === "create") {
    return {
      provider: input.snapshot.seed?.providerDisplay ?? seedDisplay(input.provider),
      model: input.snapshot.seed?.modelDisplay ?? seedDisplay(input.modelId),
      mode: seedDisplay(input.modeId),
      thinking: seedDisplay(input.thinkingOptionId),
    };
  }
  return {
    provider: input.snapshot.profileDisplays?.provider ?? seedDisplay(input.provider),
    model: input.snapshot.profileDisplays?.model ?? seedDisplay(input.modelId),
    mode: input.snapshot.profileDisplays?.mode ?? seedDisplay(input.modeId),
    thinking: input.snapshot.profileDisplays?.thinking ?? seedDisplay(input.thinkingOptionId),
  };
}

/**
 * Edit mode seeds every value and display from the stored profile alone. Late
 * catalogs populate option lists without rewriting those captured displays.
 */
function buildInitialState(snapshot: AgentProfileFormSnapshot): AgentProfileFormState {
  const profile = snapshot.profile ?? BLANK_PROFILE;
  const seed = snapshot.mode === "create" ? snapshot.seed : undefined;
  const name = seed?.name ?? profile.name;
  const provider = seed?.provider ?? profile.provider;
  const modelId = seed?.modelId ?? profile.model ?? "";
  const displays = buildInitialDisplays({
    snapshot,
    provider,
    modelId,
    modeId: profile.modeId,
    thinkingOptionId: profile.thinkingOptionId,
  });
  return {
    mode: snapshot.mode,
    name,
    icon: profile.icon ?? "",
    color: profile.color ?? "",
    notes: profile.notes ?? "",
    provider,
    modelId,
    modeId: profile.modeId ?? "",
    thinkingOptionId: profile.thinkingOptionId ?? "",
    featureValues: { ...profile.featureValues },
    providerChoices: [],
    modelOptions: [],
    modeOptions: [],
    thinkingOptions: [],
    securityPresetOptions: [],
    features: [],
    providerDisplay: displays.provider,
    modelDisplay: displays.model,
    modeDisplay: displays.mode,
    thinkingDisplay: displays.thinking,
    securityPresetId: null,
    securityPresetDisplay: null,
    catalogResolution: "idle",
    catalogError: null,
    catalogRetryAvailable: false,
    featureResolution: "idle",
    featureRequest: null,
    featureRequestKey: null,
    securityCapabilityResolution: "idle",
    securityStatus: "idle",
    disclosure: {
      showModelField: false,
      showModeField: false,
      showThinkingField: false,
      showFeaturesField: false,
      showSecurityPresetField: false,
    },
    isSubmitting: false,
    submitError: null,
    canSubmit: false,
    submitValue: null,
  };
}

export function openAgentProfileForm(snapshot: AgentProfileFormSnapshot): AgentProfileFormModel {
  const preservedProvider = snapshot.mode === "edit" ? snapshot.profile?.provider : undefined;
  const preservedProviderOptions =
    snapshot.mode === "edit" ? snapshot.profile?.providerOptions : undefined;
  const customSecurityDisplay = snapshot.customSecurityDisplay ?? { label: "Custom" };
  let entries: readonly ProviderSnapshotEntry[] = [];
  let catalogResolution: AgentProfileResolutionStatus = "idle";
  let catalogError: string | null = null;
  let securityCapability: boolean | null = null;
  let securitySeedResolvedProvider: string | null = null;
  let securityOptionsAreUnrecognized = false;
  let capturedSecurityPreset: CapturedSecurityPreset | null = null;
  let resolvedFeatureKey: string | null = null;
  let resolvedFeatures: AgentFeature[] = [];
  let listeners = new Set<() => void>();
  let closed = false;

  function captureSecurityPreset(provider: string, preset: AgentProfileSecurityPreset): void {
    capturedSecurityPreset = {
      provider,
      id: preset.id,
      display: {
        label: preset.label,
        ...(preset.description ? { description: preset.description } : {}),
      },
      providerOptions: cloneProviderOptions(preset.providerOptions),
    };
    securityOptionsAreUnrecognized = false;
  }

  function seedSecuritySelection(provider: string, presets: readonly AgentProfileSecurityPreset[]) {
    if (securitySeedResolvedProvider === provider) return;
    securitySeedResolvedProvider = provider;
    const usesPreservedOptions = provider === preservedProvider;
    const targetOptions = usesPreservedOptions ? (preservedProviderOptions ?? {}) : {};
    const match = presets.find((preset) => equal(preset.providerOptions, targetOptions));
    if (match) {
      captureSecurityPreset(provider, match);
      return;
    }
    capturedSecurityPreset = null;
    securityOptionsAreUnrecognized = usesPreservedOptions && preservedProviderOptions !== undefined;
  }

  function resolveSecurityState(provider: string): {
    status: AgentProfileSecurityStatus;
    presets: readonly AgentProfileSecurityPreset[];
  } {
    if (!provider) return { status: "idle", presets: [] };
    if (securityCapability === null) return { status: "pending", presets: [] };
    if (!securityCapability) {
      return resolveLegacyCapabilitySecurityState({
        provider,
        preservedProvider,
        preservedProviderOptions,
        captured: capturedSecurityPreset,
      });
    }
    if (catalogResolution !== "complete") return { status: "pending", presets: [] };
    const entry = findEntry(entries, provider);
    const failure = resolveCatalogSecurityFailure({
      provider,
      preservedProvider,
      preservedProviderOptions,
      catalogError,
      entry,
    });
    if (failure?.status === "read_only") {
      securityOptionsAreUnrecognized = true;
    }
    if (failure) return failure;
    const presets = entry?.agentProfileSecurityPresets ?? [];
    if (entry?.status === "ready") seedSecuritySelection(provider, presets);

    const captured = capturedSecurityPreset;
    if (captured?.provider === provider) {
      return resolveCapturedSecurityState(entry, presets, captured);
    }
    if (securityOptionsAreUnrecognized) {
      return resolveUnrecognizedSecurityState(entry, presets);
    }
    return { status: "unsupported", presets: [] };
  }

  function resolveProviderOptionsPatch(
    provider: string,
  ): AgentProfile["providerOptions"] | null | undefined {
    if (capturedSecurityPreset?.provider === provider) {
      return capturedSecurityPreset.providerOptions;
    }
    if (provider === preservedProvider && preservedProviderOptions !== undefined) {
      return preservedProviderOptions;
    }
    if (provider !== preservedProvider && preservedProviderOptions !== undefined) {
      return null;
    }
    return undefined;
  }

  function derive(incoming: AgentProfileFormState): AgentProfileFormState {
    const models = resolveModels(entries, incoming.provider);
    const modes = resolveModes(entries, incoming.provider);
    const next = seedSelections(incoming, {
      entry: findEntry(entries, incoming.provider),
      models,
      modes,
    });
    const thinking = resolveThinkingOptions(entries, next.provider, next.modelId);
    const featureRequest = buildFeatureRequest(next);
    const featureRequestKey = buildFeatureRequestKey(featureRequest);
    const featuresAreCurrent =
      featureRequestKey !== null && featureRequestKey === resolvedFeatureKey;
    const features = featuresAreCurrent
      ? applyFeatureValues(resolvedFeatures, next.featureValues)
      : [];
    const featureResolution = resolveFeatureStatus(featureRequestKey, featuresAreCurrent);
    const security = resolveSecurityState(next.provider);
    const providerEntry = findEntry(entries, next.provider);
    const catalogRetryAvailable = Boolean(
      catalogError || providerEntry?.status === "error" || providerEntry?.status === "unavailable",
    );
    const selectedSecurity = resolveSecuritySelection({
      provider: next.provider,
      captured: capturedSecurityPreset,
      unrecognized: securityOptionsAreUnrecognized,
      customDisplay: customSecurityDisplay,
    });

    const withOptions: AgentProfileFormState = {
      ...next,
      providerChoices: buildProviderChoices(entries),
      modelOptions: buildModelOptions(models),
      modeOptions: buildModeOptions(modes),
      thinkingOptions: buildThinkingOptions(thinking),
      securityPresetOptions: buildSecurityPresetOptions(security.presets),
      features,
      securityPresetId: selectedSecurity.id,
      securityPresetDisplay: selectedSecurity.display,
      catalogResolution,
      catalogError,
      catalogRetryAvailable,
      featureResolution,
      featureRequest,
      featureRequestKey,
      securityCapabilityResolution: securityCapability === null ? "pending" : "complete",
      securityStatus: security.status,
    };

    // A field appears once the catalog can populate it, and stays visible while
    // a stored value needs a home even if this host cannot resolve it.
    const hasProvider = Boolean(withOptions.provider);
    const disclosure = buildDisclosure({
      hasProvider,
      models,
      modes,
      thinking,
      features,
      modelId: withOptions.modelId,
      modeId: withOptions.modeId,
      thinkingOptionId: withOptions.thinkingOptionId,
      security,
    });
    const canSubmit =
      withOptions.name.trim().length > 0 &&
      withOptions.provider.length > 0 &&
      !securityBlocksSubmit(security.status) &&
      !withOptions.isSubmitting;
    const resolved: AgentProfileFormState = { ...withOptions, disclosure, canSubmit };
    return {
      ...resolved,
      submitValue: canSubmit
        ? buildSubmitValue(resolved, resolveProviderOptionsPatch(resolved.provider))
        : null,
    };
  }

  let state: AgentProfileFormState = derive(buildInitialState(snapshot));

  function publish(mutate: (current: AgentProfileFormState) => AgentProfileFormState): void {
    if (closed) {
      return;
    }
    state = derive(mutate(state));
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {
      closed = true;
      listeners = new Set();
    },
    applyProviderCatalog: (nextEntries) => {
      entries = [...nextEntries];
      catalogResolution = "complete";
      catalogError = null;
      publish((current) => current);
    },
    applyProviderCatalogUnavailable: (error) => {
      entries = [];
      catalogResolution = "complete";
      catalogError = error;
      publish((current) => current);
    },
    applySecurityCapability: (supported) => {
      securityCapability = supported;
      publish((current) => current);
    },
    applyFeatures: (requestKey, features) => {
      if (requestKey !== state.featureRequestKey) {
        return;
      }
      resolvedFeatureKey = requestKey;
      resolvedFeatures = [...features];
      publish((current) => ({
        ...current,
        featureValues: pruneFeatureValues(current.featureValues, resolvedFeatures),
      }));
    },
    applyFeaturesUnavailable: (requestKey) => {
      if (requestKey !== state.featureRequestKey) {
        return;
      }
      resolvedFeatureKey = requestKey;
      resolvedFeatures = [];
      publish((current) => current);
    },
    setName: (value) => publish((current) => ({ ...current, name: value })),
    setAppearance: (value) =>
      publish((current) => ({ ...current, icon: value.icon, color: value.color })),
    setNotes: (value) => publish((current) => ({ ...current, notes: value })),
    setProvider: (providerId, display) =>
      publish((current) => {
        if (current.provider === providerId) {
          return current;
        }
        capturedSecurityPreset = null;
        securityOptionsAreUnrecognized = false;
        securitySeedResolvedProvider = null;
        // Everything below the provider is provider-scoped: a model id, mode id,
        // thinking id or feature id from the old provider means nothing here.
        // Clearing them is enough — `derive` seeds the new provider's defaults.
        return {
          ...current,
          provider: providerId,
          providerDisplay: display,
          modelId: "",
          modelDisplay: null,
          modeId: "",
          modeDisplay: null,
          thinkingOptionId: "",
          thinkingDisplay: null,
          featureValues: {},
        };
      }),
    setModel: (modelId, display) =>
      publish((current) => {
        if (current.modelId === modelId) {
          return current;
        }
        // Thinking options are a property of the model, so a level the new model
        // does not offer has to go.
        const nextThinking = resolveThinkingOptions(entries, current.provider, modelId);
        const keepsThinking =
          current.thinkingOptionId.length > 0 &&
          nextThinking.some((option) => option.id === current.thinkingOptionId);
        return {
          ...current,
          modelId,
          modelDisplay: display,
          thinkingOptionId: keepsThinking ? current.thinkingOptionId : "",
          thinkingDisplay: keepsThinking ? current.thinkingDisplay : null,
        };
      }),
    setMode: (modeId, display) =>
      publish((current) => ({ ...current, modeId, modeDisplay: display })),
    setThinking: (thinkingOptionId, display) =>
      publish((current) => ({ ...current, thinkingOptionId, thinkingDisplay: display })),
    setSecurityPreset: (presetId, display) => {
      const entry = findEntry(entries, state.provider);
      if (!securityCapability || entry?.status !== "ready") return;
      const preset = entry.agentProfileSecurityPresets?.find(
        (candidate) => candidate.id === presetId,
      );
      if (!preset) return;
      captureSecurityPreset(state.provider, preset);
      if (capturedSecurityPreset) capturedSecurityPreset.display = display;
      publish((current) => ({
        ...current,
        securityPresetId: preset.id,
        securityPresetDisplay: display,
        submitError: null,
      }));
    },
    setFeatureValue: (featureId, value) =>
      publish((current) => ({
        ...current,
        featureValues: { ...current.featureValues, [featureId]: value },
      })),
    setSubmitting: (value) => publish((current) => ({ ...current, isSubmitting: value })),
    setSubmitError: (value) => publish((current) => ({ ...current, submitError: value })),
  };
}
