import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TeamRunPreviewDto } from "@getpaseo/protocol/team/types";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { PersistedAssignmentRecord } from "../assignment/model.js";
import { AssignmentStateConflictError } from "../assignment/repository.js";
import { serializeHostPersistenceMutation } from "../persistence-mutation.js";
import type { PersistedTeamDefinition } from "../team/model.js";
import { TeamRevisionConflictError } from "../team/repository.js";
import {
  TeamSecurityPreviewStaleError,
  TeamSupervisedRunAuthenticationRequiredError,
} from "../team/service.js";
import { TeamNativeDelegationUnenforcedError } from "../team/supervision.js";
import { HubTeamRunAuthorizationRepository } from "./team-run-authorization-repository.js";
import {
  HubTeamRunAuthorizationService,
  type ApproveHubTeamRunAuthorizationInput,
  type HubTeamRunAuthorizationPreflight,
} from "./team-run-authorization-service.js";

const timestamp = "2026-09-03T16:30:00.000Z";
const windowClose = "2026-09-03T17:00:00.000Z";
const fingerprint = "b".repeat(64);

function definition(): PersistedTeamDefinition {
  return {
    id: "team_delivery",
    revision: 3,
    name: "Delivery Team",
    instructions: "Coordinate the Assignment without widening authority.",
    roles: [
      {
        id: "role_supervisor",
        name: "Supervisor",
        instructions: "Plan bounded work and escalate exceptions.",
        profileId: "profile_supervisor",
      },
      {
        id: "role_builder",
        name: "Builder",
        instructions: "Implement the accepted plan.",
        profileId: "profile_builder",
      },
      {
        id: "role_reviewer",
        name: "Reviewer",
        instructions: "Review the implementation.",
        profileId: "profile_reviewer",
      },
      {
        id: "role_unused",
        name: "Unused",
        instructions: "Remain outside this supervised plan.",
        profileId: "profile_unused",
      },
    ],
    workflow: [
      { id: "step_build", roleId: "role_builder", instructions: null },
      { id: "step_review", roleId: "role_reviewer", instructions: null },
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function assignment(
  state: PersistedAssignmentRecord["state"] = { status: "open" },
): PersistedAssignmentRecord {
  return {
    id: "asgn_0123456789abcdef",
    revision: 2,
    title: "Ship Hub authorization",
    objective: "OBJECTIVE_MUST_NOT_ENTER_AUTHORITY_STORAGE",
    workItem: null,
    state,
    createdAt: timestamp,
    updatedAt: assignmentUpdatedAt(state),
  };
}

function assignmentUpdatedAt(state: PersistedAssignmentRecord["state"]): string {
  if (state.status === "completed") return state.completedAt;
  if (state.status === "canceled") return state.canceledAt;
  return timestamp;
}

function posture(
  provider = "codex",
  nativeDelegationStatus: "enforced" | "policy_only" = "enforced",
) {
  return {
    source: { provider },
    filesystemWrite: { status: "enforced" as const, summary: "Workspace write only." },
    networkAccess: { status: "policy_only" as const, summary: "Network follows policy." },
    toolShell: { status: "enforced" as const, summary: "Shell follows sandbox policy." },
    nativeDelegation: {
      status: nativeDelegationStatus,
      summary:
        nativeDelegationStatus === "enforced" ? "Delegation disabled." : "Prompt policy only.",
    },
  };
}

function preview(
  previewFingerprint = fingerprint,
  nativeDelegationStatus: "enforced" | "policy_only" = "enforced",
): TeamRunPreviewDto {
  const roles = definition().roles.map((role) => ({
    roleId: role.id,
    roleName: role.name,
    resolvedLaunch: {
      profileId: role.profileId,
      provider: "codex",
      model: role.id === "role_reviewer" ? "gpt-5.6-terra" : "gpt-5.6-sol",
      modeId: "workspace-write",
      thinkingOptionId: "high",
      featureValues: { web_search: false },
      providerOptions: { secretBoundary: "PROVIDER_OPTIONS_MUST_NOT_ENTER_STORAGE" },
      securityPosture: posture("codex", nativeDelegationStatus),
    },
  }));
  return {
    workspace: {
      workspaceId: "wks_0123456789abcdef",
      projectId: "prj_0123456789abcdef",
      cwd: "/private/WORKSPACE_PATH_MUST_NOT_ENTER_STORAGE",
      displayName: "feature/hub-authority",
    },
    roles,
    fingerprint: previewFingerprint,
  } as TeamRunPreviewDto;
}

function approvalInput(): ApproveHubTeamRunAuthorizationInput {
  return {
    relationship: { id: "relationship-1", hubOrigin: "https://hub.example.com" },
    trigger: {
      configurationId: "configuration-1",
      triggerId: "github.issue.opened",
      digest: "a".repeat(64),
    },
    teamId: "team_delivery",
    expectedTeamRevision: 3,
    assignmentId: "asgn_0123456789abcdef",
    expectedAssignmentRevision: 2,
    workspaceId: "wks_0123456789abcdef",
    supervisorRoleId: "role_supervisor",
    expectedPreviewFingerprint: fingerprint,
    policy: {
      executionWindow: {
        type: "event",
        opensAt: "2026-09-03T16:00:00.000Z",
        closesAt: windowClose,
      },
      maxRuntimeMs: 15 * 60_000,
      maxActiveRunsOnHost: 4,
      maxActiveRunsForSource: 1,
    },
    maxUses: 2,
    expiresAt: windowClose,
    approvedByPrincipalId: "principal-owner",
  };
}

describe("HubTeamRunAuthorizationService", () => {
  let paseoHome: string;
  let currentDefinition: PersistedTeamDefinition;
  let currentAssignment: PersistedAssignmentRecord;
  let currentPreview: TeamRunPreviewDto;
  let admissionStatus: ReturnType<HubTeamRunAuthorizationPreflight["getSupervisedAdmissionStatus"]>;
  let previewRun: ReturnType<typeof vi.fn>;
  let repository: HubTeamRunAuthorizationRepository;
  let service: HubTeamRunAuthorizationService;

  beforeEach(async () => {
    paseoHome = await mkdtemp(join(tmpdir(), "hub-team-run-authorization-service-"));
    currentDefinition = definition();
    currentAssignment = assignment();
    currentPreview = preview();
    admissionStatus = "available";
    previewRun = vi.fn(async () => currentPreview);
    repository = new HubTeamRunAuthorizationRepository({
      paseoHome,
      now: () => new Date(timestamp),
      createAuthorizationId: () => "htra_0123456789abcdef",
      createSourceId: () => "htrs_0123456789abcdef",
    });
    service = new HubTeamRunAuthorizationService({
      repository,
      teams: { getDefinition: async () => currentDefinition },
      assignments: { getAssignment: async () => currentAssignment },
      preflight: {
        getSupervisedAdmissionStatus: () => admissionStatus,
        previewRun,
      },
    });
  });

  afterEach(async () => {
    await rm(paseoHome, { recursive: true, force: true });
  });

  test("approves only the exact supervised target and persists a sanitized posture", async () => {
    const approved = await service.approve(approvalInput());

    expect(approved).toMatchObject({
      id: "htra_0123456789abcdef",
      relationship: { id: "relationship-1", hubOrigin: "https://hub.example.com" },
      target: {
        team: { id: "team_delivery", revision: 3, name: "Delivery Team" },
        assignment: {
          id: "asgn_0123456789abcdef",
          revision: 2,
          title: "Ship Hub authorization",
        },
        workspace: {
          id: "wks_0123456789abcdef",
          projectId: "prj_0123456789abcdef",
          displayName: "feature/hub-authority",
        },
        supervisor: { roleId: "role_supervisor", roleName: "Supervisor" },
        previewFingerprint: fingerprint,
      },
      unattendedPolicy: {
        source: { type: "hub", scopeId: "htra_0123456789abcdef" },
        launchAllowlist: [{ provider: "codex", models: ["gpt-5.6-sol", "gpt-5.6-terra"] }],
      },
      approvedBy: { principalId: "principal-owner", approvedAt: timestamp },
      maxUses: 2,
      revocation: null,
    });
    expect(approved.target.launches.map((launch) => launch.roleId)).toEqual([
      "role_supervisor",
      "role_builder",
      "role_reviewer",
    ]);
    await expect(service.listAuthorizations("relationship-1")).resolves.toEqual([approved]);

    const stored = await readFile(join(paseoHome, "hub", "team-run-authority.json"), "utf8");
    expect(stored).not.toContain("OBJECTIVE_MUST_NOT_ENTER_AUTHORITY_STORAGE");
    expect(stored).not.toContain("WORKSPACE_PATH_MUST_NOT_ENTER_STORAGE");
    expect(stored).not.toContain("PROVIDER_OPTIONS_MUST_NOT_ENTER_STORAGE");
  });

  test("rejects stale Team, Assignment, and preview facts before approval", async () => {
    await expect(
      service.approve({ ...approvalInput(), expectedTeamRevision: 2 }),
    ).rejects.toBeInstanceOf(TeamRevisionConflictError);

    currentAssignment = assignment({
      status: "completed",
      completedAt: "2026-09-03T16:31:00.000Z",
    });
    await expect(service.approve(approvalInput())).rejects.toBeInstanceOf(
      AssignmentStateConflictError,
    );

    currentAssignment = assignment();
    await expect(
      service.approve({ ...approvalInput(), expectedPreviewFingerprint: "c".repeat(64) }),
    ).rejects.toBeInstanceOf(TeamSecurityPreviewStaleError);
    await expect(repository.listAuthorizations()).resolves.toEqual([]);
  });

  test("rejects approval when the daemon or a selected profile cannot enforce supervision", async () => {
    admissionStatus = "authentication_required";
    await expect(service.approve(approvalInput())).rejects.toBeInstanceOf(
      TeamSupervisedRunAuthenticationRequiredError,
    );

    admissionStatus = "available";
    currentPreview = preview(fingerprint, "policy_only");
    await expect(service.approve(approvalInput())).rejects.toBeInstanceOf(
      TeamNativeDelegationUnenforcedError,
    );
  });

  test("revalidates target facts before consuming authority and preserves exact retries", async () => {
    const approved = await service.approve(approvalInput());
    const sourceInput = {
      relationship: approved.relationship,
      authorizationId: approved.id,
      trigger: approved.trigger,
      triggerRunId: "trigger-run-1",
      providerEventReceiptId: "receipt-1",
      deadlineAt: windowClose,
    };

    currentPreview = preview("c".repeat(64));
    await expect(service.reserve(sourceInput)).rejects.toBeInstanceOf(
      TeamSecurityPreviewStaleError,
    );
    await expect(repository.listSourcesForAuthorization(approved.id)).resolves.toEqual([]);

    currentPreview = preview();
    const reserved = await service.reserve(sourceInput);
    expect(reserved).toMatchObject({
      replayed: false,
      teamRunInput: {
        teamId: "team_delivery",
        expectedRevision: 3,
        assignmentId: "asgn_0123456789abcdef",
        expectedAssignmentRevision: 2,
        workspaceId: "wks_0123456789abcdef",
        supervisorRoleId: "role_supervisor",
        expectedPreviewFingerprint: fingerprint,
        unattendedPolicy: {
          source: { type: "hub", scopeId: approved.id },
        },
      },
    });

    await service.revoke({
      authorizationId: approved.id,
      expectedRevision: approved.revision,
      revokedByPrincipalId: "principal-owner",
      reason: "Stop future events",
    });
    currentDefinition = { ...currentDefinition, revision: 4 };
    previewRun.mockRejectedValue(new Error("replay must not consult mutable target state"));
    const replay = await service.reserve(sourceInput);
    expect(replay.source).toEqual(reserved.source);
    expect(replay.replayed).toBe(true);
    expect(previewRun).toHaveBeenCalledTimes(3);
  });

  test("serializes target validation and source reservation against host mutations", async () => {
    const approved = await service.approve(approvalInput());
    let releaseValidation!: () => void;
    let observeValidation!: () => void;
    const validationBlocked = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const validationObserved = new Promise<void>((resolve) => {
      observeValidation = resolve;
    });
    previewRun.mockImplementationOnce(async () => {
      observeValidation();
      await validationBlocked;
      return currentPreview;
    });

    const reservation = service.reserve({
      relationship: approved.relationship,
      authorizationId: approved.id,
      trigger: approved.trigger,
      triggerRunId: "trigger-run-atomic",
      providerEventReceiptId: "receipt-atomic",
      deadlineAt: windowClose,
    });
    await validationObserved;
    let sourcesVisibleBeforeMutation = -1;
    const mutation = serializeHostPersistenceMutation(
      repository.persistenceBoundaryKey,
      async () => {
        sourcesVisibleBeforeMutation = (await repository.listSourcesForAuthorization(approved.id))
          .length;
        currentDefinition = { ...currentDefinition, revision: 4 };
      },
    );
    releaseValidation();

    await reservation;
    await mutation;
    expect(sourcesVisibleBeforeMutation).toBe(1);
  });
});
