import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import type { TeamDefinitionDto } from "@getpaseo/protocol/team/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { AgentProfileGlyph, buildAgentProfileTags, useAgentProfiles } from "@/agent-profiles";
import { Button } from "@/components/ui/button";
import { ComboboxItem } from "@/components/ui/combobox";
import { type FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldOption,
  type SelectFieldRenderOptionInput,
} from "@/components/ui/select-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import { toErrorMessage } from "@/utils/error-messages";
import {
  openTeamForm,
  type TeamFormHost,
  type TeamFormModel,
  type TeamFormRole,
  type TeamFormStep,
  type TeamFormValidationIssue,
} from "./form-model";
import { useTeamMutations } from "./use-team-mutations";

export interface TeamFormSheetProps {
  mode: "create" | "edit";
  hosts: TeamFormHost[];
  selectedServerId?: string | null;
  team?: TeamDefinitionDto;
  authoringEnabled?: boolean;
  onClose: () => void;
  onSaved: (serverId: string, team: TeamDefinitionDto) => void;
}

const TEAM_SHEET_SNAP_POINTS = ["90%"];

function rpcErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function validationMessage(
  issue: TeamFormValidationIssue | null,
  t: ReturnType<typeof useTranslation>["t"],
): string | null {
  return issue ? t(`teams.form.validation.${issue}`) : null;
}

export function TeamFormSheet(props: TeamFormSheetProps): ReactElement {
  const { t } = useTranslation();
  const controlSize: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const [model] = useState(() =>
    openTeamForm({
      mode: props.mode,
      hosts: props.hosts,
      selectedServerId: props.selectedServerId,
      ...(props.team ? { team: props.team } : {}),
    }),
  );
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const { profiles } = useAgentProfiles(state.selectedServerId);
  const { entries } = useProvidersSnapshot(state.selectedServerId, { cwd: null });
  const mutations = useTeamMutations();
  const pending = mutations.create.isPending || mutations.update.isPending;
  const formDisabled = pending || props.authoringEnabled === false;

  useEffect(() => () => model.close(), [model]);
  useEffect(() => model.applyHosts(props.hosts), [model, props.hosts]);
  useEffect(() => {
    if (state.selectedServerId) model.applyProfiles(state.selectedServerId, profiles);
  }, [model, profiles, state.selectedServerId]);

  const header = useMemo<SheetHeader>(
    () => ({
      title: t(props.mode === "create" ? "teams.form.createTitle" : "teams.form.editTitle"),
    }),
    [props.mode, t],
  );
  const hostOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      state.hosts.map((host) => ({
        id: host.serverId,
        value: host.serverId,
        label: host.label,
        testID: `team-form-host-${host.serverId}`,
      })),
    [state.hosts],
  );
  const selectedHost = state.hosts.find((host) => host.serverId === state.selectedServerId);
  const selectedHostDisplay = useMemo(
    () => (selectedHost ? { label: selectedHost.label } : null),
    [selectedHost],
  );

  const formatFeatureCount = useCallback(
    (count: number) =>
      count === 1
        ? t("settings.host.agentProfiles.featureCountOne", { count })
        : t("settings.host.agentProfiles.featureCount", { count }),
    [t],
  );
  const profileOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      (profiles ?? []).map((profile) => ({
        id: profile.id,
        value: profile.id,
        label: profile.name,
        description: buildAgentProfileTags({ profile, entries, formatFeatureCount })
          .map((tag) => tag.label)
          .join(" · "),
        testID: `team-form-profile-${profile.id}`,
      })),
    [entries, formatFeatureCount, profiles],
  );
  const profilesById = useMemo(
    () => new Map((profiles ?? []).map((profile) => [profile.id, profile])),
    [profiles],
  );

  const renderProfileOption = useCallback(
    ({ option, selected, active, onPress }: SelectFieldRenderOptionInput<string>) => {
      const profile = profilesById.get(option.value);
      return (
        <ProfileOptionItem
          option={option}
          profile={profile}
          selected={selected}
          active={active}
          onPress={onPress}
        />
      );
    },
    [profilesById],
  );

  const selectHost = useCallback((serverId: string) => model.setHost(serverId), [model]);
  const manageProfiles = useCallback(() => {
    if (!state.selectedServerId) return;
    props.onClose();
    router.push(buildSettingsHostSectionRoute(state.selectedServerId, "agents"));
  }, [props, state.selectedServerId]);

  const save = useCallback(async () => {
    const submission = model.getState().submission;
    if (!submission) return;
    model.setSubmitError(null);
    try {
      if (submission.kind === "create") {
        const payload = await mutations.create.mutateAsync(submission);
        props.onSaved(submission.serverId, payload.team);
      } else {
        const payload = await mutations.update.mutateAsync(submission);
        props.onSaved(submission.serverId, payload.team);
      }
    } catch (error) {
      model.setSubmitError(
        rpcErrorCode(error) === "team_revision_conflict"
          ? t("teams.errors.conflict")
          : toErrorMessage(error),
      );
    }
  }, [model, mutations.create, mutations.update, props, t]);
  const savePress = useCallback(() => void save(), [save]);

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button variant="secondary" onPress={props.onClose} disabled={pending}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          variant="default"
          onPress={savePress}
          disabled={!state.canSubmit || formDisabled}
          loading={pending}
          testID="team-form-save"
        >
          {t(props.mode === "create" ? "teams.actions.create" : "teams.actions.save")}
        </Button>
      </View>
    ),
    [formDisabled, pending, props.mode, props.onClose, savePress, state.canSubmit, t],
  );

  return (
    <AdaptiveModalSheet
      visible
      onClose={props.onClose}
      header={header}
      footer={footer}
      desktopMaxWidth={680}
      snapPoints={TEAM_SHEET_SNAP_POINTS}
      testID="team-form-sheet"
    >
      <View style={styles.body}>
        {props.mode === "create" ? (
          <SelectField
            label={t("teams.form.host")}
            value={state.selectedServerId}
            selectedDisplay={selectedHostDisplay}
            options={hostOptions}
            onChange={selectHost}
            placeholder={t("teams.form.selectHost")}
            emptyText={t("teams.form.noHosts")}
            disabled={formDisabled}
            size={controlSize}
            testID="team-form-host-field"
          />
        ) : (
          <Field label={t("teams.form.host")}>
            <Text style={styles.immutableHost}>
              {selectedHost?.label ?? state.selectedServerId}
            </Text>
          </Field>
        )}

        <Field label={t("teams.form.name")}>
          <FormTextInput
            initialValue={state.name}
            onChangeText={model.setName}
            placeholder={t("teams.form.namePlaceholder")}
            editable={!formDisabled}
            size={controlSize}
            accessibilityLabel={t("teams.form.name")}
            testID="team-form-name"
          />
        </Field>
        <Field label={t("teams.form.instructions")} hint={t("teams.form.instructionsHint")}>
          <FormTextInput
            initialValue={state.instructions}
            onChangeText={model.setInstructions}
            placeholder={t("teams.form.instructionsPlaceholder")}
            multiline
            numberOfLines={4}
            editable={!formDisabled}
            size={controlSize}
            style={styles.multiline}
            accessibilityLabel={t("teams.form.instructions")}
            testID="team-form-instructions"
          />
        </Field>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{t("teams.detail.roles")}</Text>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={Plus}
            onPress={model.addRole}
            disabled={formDisabled}
            testID="team-form-add-role"
          >
            {t("teams.actions.addRole")}
          </Button>
        </View>
        {state.roles.map((role, index) => (
          <TeamRoleEditor
            key={role.id}
            role={role}
            index={index}
            profile={profilesById.get(role.profileId)}
            profileOptions={profileOptions}
            renderProfileOption={renderProfileOption}
            profilesLoaded={state.profiles !== null}
            hostSelected={Boolean(state.selectedServerId)}
            pending={formDisabled}
            controlSize={controlSize}
            model={model}
          />
        ))}
        <Button
          variant="outline"
          onPress={manageProfiles}
          disabled={!state.selectedServerId || formDisabled}
          testID="team-form-manage-profiles"
        >
          {t("teams.actions.manageProfiles")}
        </Button>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{t("teams.detail.workflow")}</Text>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={Plus}
            onPress={model.addStep}
            disabled={formDisabled || state.roles.length === 0}
            testID="team-form-add-step"
          >
            {t("teams.actions.addStep")}
          </Button>
        </View>
        {state.workflow.map((step, index) => (
          <TeamStepEditor
            key={step.id}
            step={step}
            index={index}
            stepCount={state.workflow.length}
            roles={state.roles}
            pending={formDisabled}
            controlSize={controlSize}
            model={model}
          />
        ))}

        {state.submitError ? (
          <Text style={styles.error} testID="team-form-submit-error">
            {state.submitError}
          </Text>
        ) : null}
        {state.validationIssue && state.validationIssue !== "profiles_loading" ? (
          <Text style={styles.validation} testID="team-form-validation">
            {validationMessage(state.validationIssue, t)}
          </Text>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

function ProfileOptionItem({
  option,
  profile,
  selected,
  active,
  onPress,
}: SelectFieldRenderOptionInput<string> & { profile: AgentProfile | undefined }): ReactElement {
  const leading = useMemo(
    () => (profile ? <AgentProfileGlyph icon={profile.icon} color={profile.color} /> : undefined),
    [profile],
  );
  return (
    <ComboboxItem
      label={option.label}
      description={option.description}
      leadingSlot={leading}
      selected={selected}
      active={active}
      onPress={onPress}
      testID={option.testID}
    />
  );
}

function TeamRoleEditor({
  role,
  index,
  profile,
  profileOptions,
  renderProfileOption,
  profilesLoaded,
  hostSelected,
  pending,
  controlSize,
  model,
}: {
  role: TeamFormRole;
  index: number;
  profile: AgentProfile | undefined;
  profileOptions: SelectFieldOption<string>[];
  renderProfileOption: (input: SelectFieldRenderOptionInput<string>) => ReactElement;
  profilesLoaded: boolean;
  hostSelected: boolean;
  pending: boolean;
  controlSize: FieldControlSize;
  model: TeamFormModel;
}): ReactElement {
  const { t } = useTranslation();
  const setName = useCallback(
    (value: string) => model.setRoleName(role.id, value),
    [model, role.id],
  );
  const setInstructions = useCallback(
    (value: string) => model.setRoleInstructions(role.id, value),
    [model, role.id],
  );
  const setProfile = useCallback(
    (profileId: string, display: SelectFieldDisplay) =>
      model.setRoleProfile(role.id, profileId, display),
    [model, role.id],
  );
  const remove = useCallback(() => model.removeRole(role.id), [model, role.id]);
  const profileLeading = useMemo(
    () => (profile ? <AgentProfileGlyph icon={profile.icon} color={profile.color} /> : undefined),
    [profile],
  );
  const profileError =
    role.profileId && profilesLoaded && !profile ? t("teams.detail.missingProfile") : null;

  return (
    <View style={styles.card} testID={`team-form-role-${role.id}`}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>{t("teams.form.roleNumber", { number: index + 1 })}</Text>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={Trash2}
          onPress={remove}
          disabled={pending}
          accessibilityLabel={t("teams.actions.removeRole")}
          testID={`team-form-remove-role-${role.id}`}
        />
      </View>
      <Field label={t("teams.form.roleName")}>
        <FormTextInput
          initialValue={role.name}
          onChangeText={setName}
          placeholder={t("teams.form.roleNamePlaceholder")}
          editable={!pending}
          size={controlSize}
          accessibilityLabel={t("teams.form.roleName")}
          testID={`team-form-role-name-${role.id}`}
        />
      </Field>
      <SelectField
        label={t("teams.form.profile")}
        value={role.profileId || null}
        selectedDisplay={role.profileDisplay}
        options={profileOptions}
        onChange={setProfile}
        placeholder={t("teams.form.selectProfile")}
        emptyText={t("teams.form.noProfiles")}
        loading={!profilesLoaded}
        searchable={profileOptions.length > 6}
        searchPlaceholder={t("teams.form.searchProfiles")}
        triggerLeading={profileLeading}
        renderOption={renderProfileOption}
        disabled={pending || !hostSelected}
        size={controlSize}
        error={profileError}
        testID={`team-form-role-profile-${role.id}`}
      />
      <Field label={t("teams.form.roleInstructions")} hint={t("teams.form.roleInstructionsHint")}>
        <FormTextInput
          initialValue={role.instructions}
          onChangeText={setInstructions}
          placeholder={t("teams.form.roleInstructionsPlaceholder")}
          multiline
          numberOfLines={3}
          editable={!pending}
          size={controlSize}
          style={styles.multiline}
          accessibilityLabel={t("teams.form.roleInstructions")}
          testID={`team-form-role-instructions-${role.id}`}
        />
      </Field>
    </View>
  );
}

function TeamStepEditor({
  step,
  index,
  stepCount,
  roles,
  pending,
  controlSize,
  model,
}: {
  step: TeamFormStep;
  index: number;
  stepCount: number;
  roles: TeamFormRole[];
  pending: boolean;
  controlSize: FieldControlSize;
  model: TeamFormModel;
}): ReactElement {
  const { t } = useTranslation();
  const role = roles.find((candidate) => candidate.id === step.roleId);
  const roleOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      roles.map((candidate) => ({
        id: candidate.id,
        value: candidate.id,
        label: candidate.name || t("teams.form.unnamedRole"),
      })),
    [roles, t],
  );
  const selectedRoleDisplay = useMemo(
    () => (role ? { label: role.name || t("teams.form.unnamedRole") } : null),
    [role, t],
  );
  const moveUp = useCallback(() => model.moveStep(step.id, -1), [model, step.id]);
  const moveDown = useCallback(() => model.moveStep(step.id, 1), [model, step.id]);
  const remove = useCallback(() => model.removeStep(step.id), [model, step.id]);
  const setRole = useCallback(
    (roleId: string) => model.setStepRole(step.id, roleId),
    [model, step.id],
  );
  const setInstructions = useCallback(
    (value: string) => model.setStepInstructions(step.id, value),
    [model, step.id],
  );

  return (
    <View style={styles.card} testID={`team-form-step-${step.id}`}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>{t("teams.form.stepNumber", { number: index + 1 })}</Text>
        <View style={styles.stepActions}>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={ArrowUp}
            onPress={moveUp}
            disabled={pending || index === 0}
            accessibilityLabel={t("teams.actions.moveUp")}
            testID={`team-form-step-up-${step.id}`}
          />
          <Button
            variant="ghost"
            size="sm"
            leftIcon={ArrowDown}
            onPress={moveDown}
            disabled={pending || index === stepCount - 1}
            accessibilityLabel={t("teams.actions.moveDown")}
            testID={`team-form-step-down-${step.id}`}
          />
          <Button
            variant="ghost"
            size="sm"
            leftIcon={Trash2}
            onPress={remove}
            disabled={pending}
            accessibilityLabel={t("teams.actions.removeStep")}
            testID={`team-form-remove-step-${step.id}`}
          />
        </View>
      </View>
      <SelectField
        label={t("teams.form.workflowRole")}
        value={step.roleId || null}
        selectedDisplay={selectedRoleDisplay}
        options={roleOptions}
        onChange={setRole}
        placeholder={t("teams.form.selectRole")}
        emptyText={t("teams.form.noRoles")}
        disabled={pending}
        size={controlSize}
        testID={`team-form-step-role-${step.id}`}
      />
      <Field label={t("teams.form.stepInstructions")} hint={t("teams.form.optional")}>
        <FormTextInput
          initialValue={step.instructions}
          onChangeText={setInstructions}
          placeholder={t("teams.form.stepInstructionsPlaceholder")}
          multiline
          numberOfLines={3}
          editable={!pending}
          size={controlSize}
          style={styles.multiline}
          accessibilityLabel={t("teams.form.stepInstructions")}
          testID={`team-form-step-instructions-${step.id}`}
        />
      </Field>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[6] },
  footer: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
  immutableHost: {
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  multiline: { minHeight: 76, textAlignVertical: "top" },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
  },
  card: {
    gap: theme.spacing[4],
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  cardTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  stepActions: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  validation: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
