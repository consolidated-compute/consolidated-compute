import type { AgentProfile } from "@getpaseo/protocol/messages";
import type {
  TeamDefinitionDto,
  TeamDefinitionInputDto,
  TeamDefinitionPatchDto,
} from "@getpaseo/protocol/team/types";
import {
  TEAM_AGENT_PROFILE_ID_MAX_CHARS,
  TEAM_INSTRUCTIONS_MAX_CHARS,
  TEAM_MAX_ROLES,
  TEAM_MAX_WORKFLOW_STEPS,
  TEAM_NAME_MAX_CHARS,
  TEAM_ROLE_NAME_MAX_CHARS,
} from "@getpaseo/protocol/team/types";

export interface TeamFormHost {
  serverId: string;
  label: string;
}

export interface TeamFormDisplay {
  label: string;
  description?: string;
}

export interface TeamFormRole {
  id: string;
  name: string;
  instructions: string;
  profileId: string;
  profileDisplay: TeamFormDisplay | null;
}

export interface TeamFormStep {
  id: string;
  roleId: string;
  instructions: string;
}

export type TeamFormValidationIssue =
  | "host_required"
  | "profiles_loading"
  | "name_required"
  | "name_too_long"
  | "instructions_required"
  | "instructions_too_long"
  | "role_required"
  | "too_many_roles"
  | "role_name_required"
  | "role_name_too_long"
  | "role_instructions_required"
  | "role_instructions_too_long"
  | "role_profile_required"
  | "role_profile_too_long"
  | "role_profile_missing"
  | "workflow_required"
  | "too_many_steps"
  | "step_instructions_too_long"
  | "workflow_role_required";

export type TeamFormSubmission =
  | {
      kind: "create";
      serverId: string;
      definition: TeamDefinitionInputDto;
    }
  | {
      kind: "update";
      serverId: string;
      teamId: string;
      expectedRevision: number;
      patch: TeamDefinitionPatchDto;
    };

export interface TeamFormState {
  mode: "create" | "edit";
  hosts: TeamFormHost[];
  selectedServerId: string | null;
  name: string;
  instructions: string;
  roles: TeamFormRole[];
  workflow: TeamFormStep[];
  profiles: AgentProfile[] | null;
  validationIssue: TeamFormValidationIssue | null;
  canSubmit: boolean;
  canAddRole: boolean;
  canAddStep: boolean;
  submission: TeamFormSubmission | null;
  submitError: string | null;
}

export interface TeamFormSnapshot {
  mode: "create" | "edit";
  hosts: readonly TeamFormHost[];
  selectedServerId?: string | null;
  team?: TeamDefinitionDto;
  profilesByServerId?: Readonly<Record<string, readonly AgentProfile[] | null>>;
}

export interface TeamFormModel {
  getState: () => TeamFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  applyHosts: (hosts: readonly TeamFormHost[]) => void;
  applyProfiles: (serverId: string, profiles: readonly AgentProfile[] | null) => void;
  setHost: (serverId: string) => void;
  setName: (value: string) => void;
  setInstructions: (value: string) => void;
  addRole: () => void;
  removeRole: (roleId: string) => void;
  setRoleName: (roleId: string, value: string) => void;
  setRoleInstructions: (roleId: string, value: string) => void;
  setRoleProfile: (roleId: string, profileId: string, display: TeamFormDisplay) => void;
  addStep: () => void;
  removeStep: (stepId: string) => void;
  setStepRole: (stepId: string, roleId: string) => void;
  setStepInstructions: (stepId: string, value: string) => void;
  moveStep: (stepId: string, offset: -1 | 1) => void;
  setSubmitError: (value: string | null) => void;
}

interface TeamFormModelOptions {
  generateId?: (kind: "role" | "step") => string;
}

function generateEntityId(kind: "role" | "step"): string {
  return `${kind}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function findProfile(
  profiles: readonly AgentProfile[] | null | undefined,
  profileId: string,
): AgentProfile | null {
  return profiles?.find((profile) => profile.id === profileId) ?? null;
}

function profileDisplay(
  profiles: readonly AgentProfile[] | null | undefined,
  profileId: string,
): TeamFormDisplay {
  const profile = findProfile(profiles, profileId);
  return { label: profile?.name ?? profileId };
}

function definitionFromState(state: TeamFormState): TeamDefinitionInputDto {
  return {
    name: state.name.trim(),
    instructions: state.instructions.trim(),
    roles: state.roles.map((role) => ({
      id: role.id,
      name: role.name.trim(),
      instructions: role.instructions.trim(),
      profileId: role.profileId.trim(),
    })),
    workflow: state.workflow.map((step) => ({
      id: step.id,
      roleId: step.roleId,
      instructions: step.instructions.trim() || null,
    })),
  };
}

function definitionsMatch(left: TeamDefinitionInputDto, right: TeamDefinitionInputDto): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateRole(
  role: TeamFormRole,
  profiles: readonly AgentProfile[],
): TeamFormValidationIssue | null {
  if (!role.name.trim()) return "role_name_required";
  if (role.name.length > TEAM_ROLE_NAME_MAX_CHARS) return "role_name_too_long";
  if (!role.instructions.trim()) return "role_instructions_required";
  if (role.instructions.length > TEAM_INSTRUCTIONS_MAX_CHARS) {
    return "role_instructions_too_long";
  }
  if (!role.profileId.trim()) return "role_profile_required";
  if (role.profileId.length > TEAM_AGENT_PROFILE_ID_MAX_CHARS) {
    return "role_profile_too_long";
  }
  if (!findProfile(profiles, role.profileId)) return "role_profile_missing";
  return null;
}

function validateState(state: TeamFormState): TeamFormValidationIssue | null {
  if (
    !state.selectedServerId ||
    !state.hosts.some((host) => host.serverId === state.selectedServerId)
  ) {
    return "host_required";
  }
  if (state.profiles === null) return "profiles_loading";
  if (!state.name.trim()) return "name_required";
  if (state.name.length > TEAM_NAME_MAX_CHARS) return "name_too_long";
  if (!state.instructions.trim()) return "instructions_required";
  if (state.instructions.length > TEAM_INSTRUCTIONS_MAX_CHARS) return "instructions_too_long";
  if (state.roles.length === 0) return "role_required";
  if (state.roles.length > TEAM_MAX_ROLES) return "too_many_roles";
  for (const role of state.roles) {
    const issue = validateRole(role, state.profiles);
    if (issue) return issue;
  }
  if (state.workflow.length === 0) return "workflow_required";
  if (state.workflow.length > TEAM_MAX_WORKFLOW_STEPS) return "too_many_steps";
  if (state.workflow.some((step) => step.instructions.length > TEAM_INSTRUCTIONS_MAX_CHARS)) {
    return "step_instructions_too_long";
  }
  const roleIds = new Set(state.roles.map((role) => role.id));
  if (state.workflow.some((step) => !roleIds.has(step.roleId))) return "workflow_role_required";
  return null;
}

export function openTeamForm(
  snapshot: TeamFormSnapshot,
  options: TeamFormModelOptions = {},
): TeamFormModel {
  const generateId = options.generateId ?? generateEntityId;
  const listeners = new Set<() => void>();
  const profileCatalogs = new Map<string, readonly AgentProfile[] | null>(
    Object.entries(snapshot.profilesByServerId ?? {}),
  );
  const resolvedProfileCatalogs = new Set(
    [...profileCatalogs.entries()]
      .filter(([, profiles]) => profiles !== null)
      .map(([serverId]) => serverId),
  );
  const selectedServerId =
    snapshot.mode === "edit"
      ? (snapshot.selectedServerId ?? null)
      : (snapshot.selectedServerId ??
        (snapshot.hosts.length === 1 ? snapshot.hosts[0]!.serverId : null));
  const initialProfiles = selectedServerId ? (profileCatalogs.get(selectedServerId) ?? null) : null;
  const initialDefinition = snapshot.team
    ? {
        name: snapshot.team.name,
        instructions: snapshot.team.instructions,
        roles: snapshot.team.roles,
        workflow: snapshot.team.workflow,
      }
    : null;

  let state: TeamFormState = {
    mode: snapshot.mode,
    hosts: [...snapshot.hosts],
    selectedServerId,
    name: snapshot.team?.name ?? "",
    instructions: snapshot.team?.instructions ?? "",
    roles: snapshot.team
      ? snapshot.team.roles.map((role) => ({
          ...role,
          profileDisplay: profileDisplay(initialProfiles, role.profileId),
        }))
      : [
          {
            id: generateId("role"),
            name: "",
            instructions: "",
            profileId: "",
            profileDisplay: null,
          },
        ],
    workflow: snapshot.team
      ? snapshot.team.workflow.map((step) => ({
          ...step,
          instructions: step.instructions ?? "",
        }))
      : [],
    profiles: initialProfiles ? [...initialProfiles] : null,
    validationIssue: null,
    canSubmit: false,
    canAddRole: true,
    canAddStep: true,
    submission: null,
    submitError: null,
  };

  if (!snapshot.team) {
    state.workflow = [
      {
        id: generateId("step"),
        roleId: state.roles[0]!.id,
        instructions: "",
      },
    ];
  }

  function deriveState(next: TeamFormState): TeamFormState {
    const validationIssue = validateState(next);
    const definition = definitionFromState(next);
    let submission: TeamFormSubmission | null = null;
    if (!validationIssue && next.selectedServerId) {
      if (next.mode === "create") {
        submission = { kind: "create", serverId: next.selectedServerId, definition };
      } else if (
        snapshot.team &&
        initialDefinition &&
        !definitionsMatch(definition, initialDefinition)
      ) {
        submission = {
          kind: "update",
          serverId: next.selectedServerId,
          teamId: snapshot.team.id,
          expectedRevision: snapshot.team.revision,
          patch: definition,
        };
      }
    }
    return {
      ...next,
      validationIssue,
      canSubmit: submission !== null,
      canAddRole: next.roles.length < TEAM_MAX_ROLES,
      canAddStep: next.workflow.length < TEAM_MAX_WORKFLOW_STEPS,
      submission,
    };
  }

  state = deriveState(state);

  function publish(
    next: TeamFormState,
    publishOptions: { preserveSubmitError?: boolean } = {},
  ): void {
    state = deriveState({
      ...next,
      submitError: publishOptions.preserveSubmitError ? next.submitError : null,
    });
    for (const listener of listeners) listener();
  }

  function updateRole(roleId: string, update: (role: TeamFormRole) => TeamFormRole): void {
    publish({
      ...state,
      roles: state.roles.map((role) => (role.id === roleId ? update(role) : role)),
    });
  }

  function updateStep(stepId: string, update: (step: TeamFormStep) => TeamFormStep): void {
    publish({
      ...state,
      workflow: state.workflow.map((step) => (step.id === stepId ? update(step) : step)),
    });
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => listeners.clear(),
    applyHosts: (hosts) => publish({ ...state, hosts: [...hosts] }, { preserveSubmitError: true }),
    applyProfiles: (serverId, profiles) => {
      profileCatalogs.set(serverId, profiles);
      if (serverId !== state.selectedServerId) return;
      const isInitialResolution = profiles !== null && !resolvedProfileCatalogs.has(serverId);
      if (profiles !== null) resolvedProfileCatalogs.add(serverId);
      publish(
        {
          ...state,
          profiles: profiles ? [...profiles] : null,
          roles: isInitialResolution
            ? state.roles.map((role) => ({
                ...role,
                profileDisplay: role.profileId ? profileDisplay(profiles, role.profileId) : null,
              }))
            : state.roles,
        },
        { preserveSubmitError: true },
      );
    },
    setHost: (serverId) => {
      if (state.mode === "edit" || serverId === state.selectedServerId) return;
      const nextProfiles = profileCatalogs.get(serverId) ?? null;
      publish({
        ...state,
        selectedServerId: serverId,
        profiles: nextProfiles ? [...nextProfiles] : null,
        roles: state.roles.map((role) => ({ ...role, profileId: "", profileDisplay: null })),
      });
    },
    setName: (name) => publish({ ...state, name }),
    setInstructions: (instructions) => publish({ ...state, instructions }),
    addRole: () => {
      if (!state.canAddRole) return;
      publish({
        ...state,
        roles: [
          ...state.roles,
          {
            id: generateId("role"),
            name: "",
            instructions: "",
            profileId: "",
            profileDisplay: null,
          },
        ],
      });
    },
    removeRole: (roleId) =>
      publish({
        ...state,
        roles: state.roles.filter((role) => role.id !== roleId),
        workflow: state.workflow.filter((step) => step.roleId !== roleId),
      }),
    setRoleName: (roleId, name) => updateRole(roleId, (role) => ({ ...role, name })),
    setRoleInstructions: (roleId, instructions) =>
      updateRole(roleId, (role) => ({ ...role, instructions })),
    setRoleProfile: (roleId, profileId, display) =>
      updateRole(roleId, (role) => ({ ...role, profileId, profileDisplay: display })),
    addStep: () => {
      if (!state.canAddStep) return;
      publish({
        ...state,
        workflow: [
          ...state.workflow,
          {
            id: generateId("step"),
            roleId: state.roles[0]?.id ?? "",
            instructions: "",
          },
        ],
      });
    },
    removeStep: (stepId) =>
      publish({ ...state, workflow: state.workflow.filter((step) => step.id !== stepId) }),
    setStepRole: (stepId, roleId) => updateStep(stepId, (step) => ({ ...step, roleId })),
    setStepInstructions: (stepId, instructions) =>
      updateStep(stepId, (step) => ({ ...step, instructions })),
    moveStep: (stepId, offset) => {
      const index = state.workflow.findIndex((step) => step.id === stepId);
      const target = index + offset;
      if (index < 0 || target < 0 || target >= state.workflow.length) return;
      const workflow = [...state.workflow];
      const [step] = workflow.splice(index, 1);
      workflow.splice(target, 0, step!);
      publish({ ...state, workflow });
    },
    setSubmitError: (submitError) => {
      state = { ...state, submitError };
      for (const listener of listeners) listener();
    },
  };
}
