import { describe, expect, it } from "vitest";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import {
  TEAM_AGENT_PROFILE_ID_MAX_CHARS,
  TEAM_INSTRUCTIONS_MAX_CHARS,
  TEAM_MAX_ROLES,
  TEAM_MAX_WORKFLOW_STEPS,
  TEAM_NAME_MAX_CHARS,
  TEAM_ROLE_NAME_MAX_CHARS,
  type TeamDefinitionDto,
} from "@getpaseo/protocol/team/types";
import { openTeamForm } from "./form-model";

const profiles: AgentProfile[] = [
  { id: "architect", name: "Architect", provider: "codex" },
  { id: "builder", name: "Builder", provider: "claude" },
];

const team: TeamDefinitionDto = {
  id: "team-1",
  revision: 3,
  name: "Delivery",
  instructions: "Ship safely.",
  roles: [
    { id: "planner", name: "Planner", instructions: "Plan.", profileId: "architect" },
    { id: "implementer", name: "Implementer", instructions: "Build.", profileId: "builder" },
  ],
  workflow: [
    { id: "plan", roleId: "planner", instructions: null },
    { id: "build", roleId: "implementer", instructions: "Follow the plan." },
  ],
  createdAt: "2026-08-26T12:00:00.000Z",
  updatedAt: "2026-08-26T12:00:00.000Z",
};

function idGenerator() {
  let next = 0;
  return (kind: "role" | "step") => `${kind}-${++next}`;
}

describe("Team form model", () => {
  it("preserves stable role and workflow IDs while reordering", () => {
    const form = openTeamForm({
      mode: "edit",
      hosts: [{ serverId: "host-a", label: "A" }],
      selectedServerId: "host-a",
      team,
      profilesByServerId: { "host-a": profiles },
    });

    expect(form.getState().canSubmit).toBe(false);
    form.moveStep("build", -1);

    expect(form.getState().workflow.map((step) => step.id)).toEqual(["build", "plan"]);
    expect(form.getState().submission).toMatchObject({
      kind: "update",
      expectedRevision: 3,
      patch: { workflow: [{ id: "build" }, { id: "plan" }] },
    });
  });

  it("clears host-local profile references when the create host changes", () => {
    const form = openTeamForm(
      {
        mode: "create",
        hosts: [
          { serverId: "host-a", label: "A" },
          { serverId: "host-b", label: "B" },
        ],
        selectedServerId: "host-a",
        profilesByServerId: { "host-a": profiles, "host-b": [] },
      },
      { generateId: idGenerator() },
    );
    const roleId = form.getState().roles[0]!.id;
    form.setRoleProfile(roleId, "architect", { label: "Architect" });

    form.setHost("host-b");

    expect(form.getState()).toMatchObject({
      selectedServerId: "host-b",
      roles: [{ profileId: "", profileDisplay: null }],
    });
  });

  it("blocks an edit whose saved profile disappeared until the role is repaired", () => {
    const form = openTeamForm({
      mode: "edit",
      hosts: [{ serverId: "host-a", label: "A" }],
      selectedServerId: "host-a",
      team,
      profilesByServerId: { "host-a": [profiles[1]!] },
    });

    expect(form.getState()).toMatchObject({
      validationIssue: "role_profile_missing",
      canSubmit: false,
    });
    expect(form.getState().roles[0]).toMatchObject({
      profileId: "architect",
      profileDisplay: { label: "architect" },
    });

    form.setRoleProfile("planner", "builder", { label: "Builder" });
    expect(form.getState().canSubmit).toBe(true);
  });

  it("preserves selected profile displays while catalog availability changes", () => {
    const form = openTeamForm({
      mode: "edit",
      hosts: [{ serverId: "host-a", label: "A" }],
      selectedServerId: "host-a",
      team,
      profilesByServerId: { "host-a": profiles },
    });

    expect(form.getState().roles[0]!.profileDisplay).toEqual({ label: "Architect" });

    form.applyProfiles("host-a", [{ ...profiles[0]!, name: "Renamed Architect" }, profiles[1]!]);
    expect(form.getState().roles[0]!.profileDisplay).toEqual({ label: "Architect" });

    form.applyProfiles("host-a", [profiles[1]!]);
    expect(form.getState()).toMatchObject({
      validationIssue: "role_profile_missing",
      canSubmit: false,
    });
    expect(form.getState().roles[0]!.profileDisplay).toEqual({ label: "Architect" });
  });

  it("resolves profile displays once when an initial catalog finishes loading", () => {
    const form = openTeamForm({
      mode: "edit",
      hosts: [{ serverId: "host-a", label: "A" }],
      selectedServerId: "host-a",
      team,
      profilesByServerId: { "host-a": null },
    });

    expect(form.getState().roles[0]!.profileDisplay).toEqual({ label: "architect" });

    form.applyProfiles("host-a", profiles);
    expect(form.getState().roles[0]!.profileDisplay).toEqual({ label: "Architect" });

    form.applyProfiles("host-a", [{ ...profiles[0]!, name: "Renamed Architect" }, profiles[1]!]);
    expect(form.getState().roles[0]!.profileDisplay).toEqual({ label: "Architect" });
  });

  it("enforces the daemon character limits before submission", () => {
    const longProfileId = "p".repeat(TEAM_AGENT_PROFILE_ID_MAX_CHARS + 1);
    const form = openTeamForm({
      mode: "edit",
      hosts: [{ serverId: "host-a", label: "A" }],
      selectedServerId: "host-a",
      team,
      profilesByServerId: {
        "host-a": [...profiles, { id: longProfileId, name: "Long", provider: "codex" }],
      },
    });

    form.setName("n".repeat(TEAM_NAME_MAX_CHARS + 1));
    expect(form.getState()).toMatchObject({ validationIssue: "name_too_long", canSubmit: false });
    form.setName(team.name);

    form.setInstructions("i".repeat(TEAM_INSTRUCTIONS_MAX_CHARS + 1));
    expect(form.getState()).toMatchObject({
      validationIssue: "instructions_too_long",
      canSubmit: false,
    });
    form.setInstructions(team.instructions);

    form.setRoleName("planner", "r".repeat(TEAM_ROLE_NAME_MAX_CHARS + 1));
    expect(form.getState()).toMatchObject({
      validationIssue: "role_name_too_long",
      canSubmit: false,
    });
    form.setRoleName("planner", team.roles[0]!.name);

    form.setRoleInstructions("planner", "i".repeat(TEAM_INSTRUCTIONS_MAX_CHARS + 1));
    expect(form.getState()).toMatchObject({
      validationIssue: "role_instructions_too_long",
      canSubmit: false,
    });
    form.setRoleInstructions("planner", team.roles[0]!.instructions);

    form.setRoleProfile("planner", longProfileId, { label: "Long" });
    expect(form.getState()).toMatchObject({
      validationIssue: "role_profile_too_long",
      canSubmit: false,
    });
    form.setRoleProfile("planner", "architect", { label: "Architect" });

    form.setStepInstructions("plan", "i".repeat(TEAM_INSTRUCTIONS_MAX_CHARS + 1));
    expect(form.getState()).toMatchObject({
      validationIssue: "step_instructions_too_long",
      canSubmit: false,
    });
  });

  it("prevents adding roles and workflow steps beyond daemon limits", () => {
    const form = openTeamForm(
      {
        mode: "create",
        hosts: [{ serverId: "host-a", label: "A" }],
        selectedServerId: "host-a",
        profilesByServerId: { "host-a": profiles },
      },
      { generateId: idGenerator() },
    );

    for (let index = 0; index < TEAM_MAX_ROLES + 2; index += 1) form.addRole();
    for (let index = 0; index < TEAM_MAX_WORKFLOW_STEPS + 2; index += 1) form.addStep();

    expect(form.getState()).toMatchObject({ canAddRole: false, canAddStep: false });
    expect(form.getState().roles).toHaveLength(TEAM_MAX_ROLES);
    expect(form.getState().workflow).toHaveLength(TEAM_MAX_WORKFLOW_STEPS);
  });

  it("removes workflow occurrences when their role is deleted", () => {
    const form = openTeamForm({
      mode: "edit",
      hosts: [{ serverId: "host-a", label: "A" }],
      selectedServerId: "host-a",
      team,
      profilesByServerId: { "host-a": profiles },
    });

    form.removeRole("planner");

    expect(form.getState().roles.map((role) => role.id)).toEqual(["implementer"]);
    expect(form.getState().workflow.map((step) => step.id)).toEqual(["build"]);
  });

  it("blocks submission when the selected host stops being eligible", () => {
    const form = openTeamForm({
      mode: "edit",
      hosts: [{ serverId: "host-a", label: "A" }],
      selectedServerId: "host-a",
      team,
      profilesByServerId: { "host-a": profiles },
    });

    form.setName("Delivery updated");
    expect(form.getState().canSubmit).toBe(true);

    form.applyHosts([]);
    expect(form.getState()).toMatchObject({
      validationIssue: "host_required",
      canSubmit: false,
      submission: null,
    });
  });
});
