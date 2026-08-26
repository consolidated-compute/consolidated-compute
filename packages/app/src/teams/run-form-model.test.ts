import { describe, expect, it } from "vitest";
import type { AgentFeature, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import type { TeamDefinitionDto } from "@getpaseo/protocol/team/types";
import { TEAM_OBJECTIVE_MAX_CHARS } from "@getpaseo/protocol/team/types";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import {
  buildTeamRunWorkspaceOptions,
  buildTeamRunFeatureRequest,
  openTeamRunForm,
  type TeamRunWorkspaceOption,
} from "./run-form-model";

function team(): TeamDefinitionDto {
  return {
    id: "team-1",
    revision: 3,
    name: "Delivery",
    instructions: "Ship carefully",
    roles: [
      {
        id: "planner",
        name: "Planner",
        instructions: "Plan the work",
        profileId: "architect",
      },
    ],
    workflow: [{ id: "plan", roleId: "planner", instructions: null }],
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  };
}

const workspace: TeamRunWorkspaceOption = {
  workspaceId: "workspace-1",
  cwd: "/repo",
  display: { label: "main", description: "Project" },
};

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "architect",
    name: "Architect",
    provider: "codex",
    model: "gpt-5.6",
    modeId: "plan",
    thinkingOptionId: "high",
    featureValues: { web: true },
    ...overrides,
  };
}

function provider(overrides: Partial<ProviderSnapshotEntry> = {}): ProviderSnapshotEntry {
  return {
    provider: "codex",
    status: "ready",
    enabled: true,
    models: [
      {
        provider: "codex",
        id: "gpt-5.6",
        label: "GPT-5.6",
        thinkingOptions: [{ id: "high", label: "High" }],
      },
    ],
    modes: [{ id: "plan", label: "Plan" }],
    ...overrides,
  };
}

const webFeature: AgentFeature = {
  type: "toggle",
  id: "web",
  label: "Web",
  value: false,
};

describe("Team Run form model", () => {
  it("offers only active Workspaces in stable display order", () => {
    const descriptor = (input: {
      id: string;
      name: string;
      projectDisplayName: string;
      archivingAt: string | null;
    }) =>
      ({
        ...input,
        title: null,
        workspaceDirectory: `/repo/${input.id}`,
      }) as WorkspaceDescriptor;
    expect(
      buildTeamRunWorkspaceOptions([
        descriptor({ id: "b", name: "Review", projectDisplayName: "Paseo", archivingAt: null }),
        descriptor({
          id: "gone",
          name: "Old",
          projectDisplayName: "Paseo",
          archivingAt: "2026-08-26T00:00:00.000Z",
        }),
        descriptor({ id: "a", name: "Main", projectDisplayName: "CC", archivingAt: null }),
      ]),
    ).toEqual([
      { workspaceId: "a", cwd: "/repo/a", display: { label: "Main", description: "CC" } },
      {
        workspaceId: "b",
        cwd: "/repo/b",
        display: { label: "Review", description: "Paseo" },
      },
    ]);
  });

  it("freezes one retry-safe submission after Workspace and profile readiness", () => {
    const model = openTeamRunForm(
      { serverId: "host-a", team: team(), workspaces: [workspace], profiles: [profile()] },
      { generateIdempotencyKey: () => "retry-key" },
    );

    expect(model.getState().validationIssue).toBe("objective_required");
    model.setObjective("  Implement issue 49  ");
    expect(model.getState().validationIssue).toBe("profiles_loading");
    model.applyProviderCatalog("workspace-1", workspace.cwd, [provider()]);
    expect(model.getState().roleResolutions[0]?.status).toBe("features_loading");
    const request = buildTeamRunFeatureRequest(
      model.getState().roleResolutions[0]!,
      workspace.cwd,
    )!;
    model.applyFeatureCatalog("planner", request.requestKey, [webFeature]);

    expect(model.getState().roleResolutions).toEqual([
      {
        roleId: "planner",
        roleName: "Planner",
        profileId: "architect",
        profileName: "Architect",
        provider: "codex",
        model: "gpt-5.6",
        modeId: "plan",
        thinkingOptionId: "high",
        featureValues: { web: true },
        status: "ready",
      },
    ]);
    expect(model.getState().submission).toEqual({
      serverId: "host-a",
      teamId: "team-1",
      expectedRevision: 3,
      idempotencyKey: "retry-key",
      objective: "Implement issue 49",
      workspaceId: "workspace-1",
    });

    model.setSubmitError("Connection lost");
    model.setObjective("Implement issue 49 again");
    expect(model.getState().submission?.idempotencyKey).toBe("retry-key");
  });

  it("blocks a missing or duplicated Agent Profile explicitly", () => {
    const missing = openTeamRunForm({
      serverId: "host-a",
      team: team(),
      workspaces: [workspace],
      profiles: [],
    });
    missing.setObjective("Plan");
    missing.applyProviderCatalog("workspace-1", workspace.cwd, [provider()]);
    expect(missing.getState().roleResolutions[0]?.status).toBe("profile_missing");
    expect(missing.getState().validationIssue).toBe("profile_unavailable");

    missing.applyProfiles([profile(), profile({ name: "Duplicate" })]);
    expect(missing.getState().roleResolutions[0]?.status).toBe("profile_ambiguous");
  });

  it.each([
    ["provider_unavailable", provider({ enabled: false })],
    ["model_unavailable", provider({ models: [] })],
    ["mode_unavailable", provider({ modes: [] })],
    [
      "thinking_unavailable",
      provider({
        models: [{ provider: "codex", id: "gpt-5.6", label: "GPT-5.6" }],
      }),
    ],
  ] as const)("blocks %s launch settings", (status, entry) => {
    const model = openTeamRunForm({
      serverId: "host-a",
      team: team(),
      workspaces: [workspace],
      profiles: [profile()],
    });
    model.setObjective("Plan");
    model.applyProviderCatalog("workspace-1", workspace.cwd, [entry]);
    expect(model.getState().roleResolutions[0]?.status).toBe(status);
    expect(model.getState().canSubmit).toBe(false);
  });

  it("blocks unavailable or invalid feature settings", () => {
    const model = openTeamRunForm({
      serverId: "host-a",
      team: team(),
      workspaces: [workspace],
      profiles: [profile()],
    });
    model.setObjective("Plan");
    model.applyProviderCatalog("workspace-1", workspace.cwd, [provider()]);
    const request = buildTeamRunFeatureRequest(
      model.getState().roleResolutions[0]!,
      workspace.cwd,
    )!;
    model.applyFeatureCatalog("planner", request.requestKey, []);
    expect(model.getState().roleResolutions[0]?.status).toBe("feature_unavailable");
    expect(model.getState().canSubmit).toBe(false);

    model.applyFeatureCatalog("planner", request.requestKey, null);
    expect(model.getState().roleResolutions[0]?.status).toBe("feature_unavailable");
  });

  it("ignores a late feature result after the selected profile changes", () => {
    const model = openTeamRunForm({
      serverId: "host-a",
      team: team(),
      workspaces: [workspace],
      profiles: [profile()],
    });
    model.setObjective("Plan");
    model.applyProviderCatalog("workspace-1", workspace.cwd, [provider()]);
    const originalRequest = buildTeamRunFeatureRequest(
      model.getState().roleResolutions[0]!,
      workspace.cwd,
    )!;

    model.applyProfiles([profile({ featureValues: { shell: true } })]);
    const changedRequest = buildTeamRunFeatureRequest(
      model.getState().roleResolutions[0]!,
      workspace.cwd,
    )!;
    expect(changedRequest.requestKey).not.toBe(originalRequest.requestKey);

    model.applyFeatureCatalog("planner", originalRequest.requestKey, [webFeature]);
    expect(model.getState().roleResolutions[0]?.status).toBe("features_loading");

    model.applyFeatureCatalog("planner", changedRequest.requestKey, [
      { type: "toggle", id: "shell", label: "Shell", value: false },
    ]);
    expect(model.getState().roleResolutions[0]?.status).toBe("ready");
  });

  it("validates thinking against the resolved default model", () => {
    const model = openTeamRunForm({
      serverId: "host-a",
      team: team(),
      workspaces: [workspace],
      profiles: [profile({ model: undefined, featureValues: {} })],
    });
    model.setObjective("Plan");
    model.applyProviderCatalog("workspace-1", workspace.cwd, [
      provider({
        models: [
          {
            provider: "codex",
            id: "gpt-default",
            label: "GPT default",
            isDefault: true,
            thinkingOptions: [{ id: "high", label: "High" }],
          },
        ],
      }),
    ]);
    expect(model.getState().roleResolutions[0]).toMatchObject({
      model: "gpt-default",
      thinkingOptionId: "high",
      status: "ready",
    });
  });

  it("retains the selected display but blocks submission when the Workspace disappears", () => {
    const model = openTeamRunForm({
      serverId: "host-a",
      team: team(),
      workspaces: [workspace],
      profiles: [profile()],
    });
    model.setObjective("Plan");
    model.applyProviderCatalog("workspace-1", workspace.cwd, [provider()]);
    model.applyWorkspaces([]);

    expect(model.getState().selectedWorkspaceDisplay).toEqual(workspace.display);
    expect(model.getState().validationIssue).toBe("workspace_missing");
    expect(model.getState().submission).toBeNull();
  });

  it("ignores a late provider catalog from the previously selected Workspace", () => {
    const other = {
      workspaceId: "workspace-2",
      cwd: "/other",
      display: { label: "review" },
    };
    const model = openTeamRunForm({
      serverId: "host-a",
      team: team(),
      workspaces: [workspace, other],
      profiles: [profile()],
    });
    model.setWorkspace("workspace-1", workspace.display);
    model.setWorkspace("workspace-2", other.display);
    model.setObjective("Plan");
    model.applyProviderCatalog("workspace-1", workspace.cwd, [provider()]);

    expect(model.getState().validationIssue).toBe("profiles_loading");
  });

  it("rejects a provider result for an earlier path under the same Workspace ID", () => {
    const model = openTeamRunForm({
      serverId: "host-a",
      team: team(),
      workspaces: [workspace],
      profiles: [profile({ featureValues: {} })],
    });
    model.setObjective("Plan");
    model.applyProviderCatalog("workspace-1", workspace.cwd, [provider()]);
    expect(model.getState().canSubmit).toBe(true);

    model.applyWorkspaces([{ ...workspace, cwd: "/moved" }]);
    model.applyProviderCatalog("workspace-1", workspace.cwd, [provider()]);
    expect(model.getState()).toMatchObject({
      selectedWorkspaceCwd: "/moved",
      validationIssue: "profiles_loading",
      canSubmit: false,
    });

    model.applyProviderCatalog("workspace-1", "/moved", [provider()]);
    expect(model.getState().canSubmit).toBe(true);
  });

  it("enforces the daemon Objective limit", () => {
    const model = openTeamRunForm({
      serverId: "host-a",
      team: team(),
      workspaces: [workspace],
      profiles: [profile()],
    });
    model.setObjective("x".repeat(TEAM_OBJECTIVE_MAX_CHARS + 1));
    model.applyProviderCatalog("workspace-1", workspace.cwd, [provider()]);
    expect(model.getState().validationIssue).toBe("objective_too_long");
  });

  it("rejects every late adapter input after close", () => {
    const model = openTeamRunForm({
      serverId: "host-a",
      team: team(),
      workspaces: [workspace],
      profiles: [profile()],
    });
    const stateAtClose = model.getState();
    model.close();
    model.setObjective("Late objective");
    model.applyWorkspaces([]);
    model.applyProfiles([]);
    model.applyProviderCatalog("workspace-1", workspace.cwd, [provider()]);
    model.applyFeatureCatalog("planner", "late", []);
    expect(model.getState()).toBe(stateAtClose);
  });
});
