import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { writeJsonFileAtomic } from "../atomic-file.js";
import type {
  HubTeamRunAuthorizationPolicy,
  PersistedHubRelationshipIdentity,
  PersistedHubTeamRunAuthorizationTarget,
  PersistedHubTriggerIdentity,
} from "./team-run-authorization-model.js";
import {
  HubTeamRunAuthorizationDeniedError,
  HubTeamRunAuthorizationRepository,
  HubTeamRunSourceConflictError,
  HubTeamRunSourceTeamRunConflictError,
} from "./team-run-authorization-repository.js";

const firstTimestamp = "2026-09-03T16:30:00.000Z";
const secondTimestamp = "2026-09-03T16:31:00.000Z";
const windowClose = "2026-09-03T17:00:00.000Z";
const authorizationId = "htra_0123456789abcdef";
const secondAuthorizationId = "htra_fedcba9876543210";
const firstSourceId = "htrs_0123456789abcdef";
const secondSourceId = "htrs_fedcba9876543210";

function relationship(id = "relationship-1"): PersistedHubRelationshipIdentity {
  return { id, hubOrigin: "https://hub.example.com" };
}

function trigger(digest = "a".repeat(64)): PersistedHubTriggerIdentity {
  return {
    configurationId: "configuration-1",
    triggerId: "github.issue.opened",
    digest,
  };
}

function target(): PersistedHubTeamRunAuthorizationTarget {
  const posture = {
    source: { provider: "codex" },
    filesystemWrite: { status: "enforced" as const, summary: "Workspace write only." },
    networkAccess: { status: "policy_only" as const, summary: "Network follows policy." },
    toolShell: { status: "enforced" as const, summary: "Shell follows sandbox policy." },
    nativeDelegation: { status: "enforced" as const, summary: "Delegation is disabled." },
  };
  return {
    team: { id: "team_delivery", revision: 3, name: "Delivery Team" },
    assignment: { id: "asgn_0123456789abcdef", revision: 2, title: "Ship change" },
    workspace: {
      id: "wks_0123456789abcdef",
      projectId: "prj_0123456789abcdef",
      displayName: "feature/hub",
    },
    supervisor: { roleId: "role_supervisor", roleName: "Supervisor" },
    launches: [
      {
        roleId: "role_supervisor",
        roleName: "Supervisor",
        profileId: "profile_supervisor",
        provider: "codex",
        model: "gpt-5.6",
        securityPosture: posture,
      },
      {
        roleId: "role_builder",
        roleName: "Builder",
        profileId: "profile_builder",
        provider: "codex",
        model: "gpt-5.6",
        securityPosture: posture,
      },
    ],
    previewFingerprint: "b".repeat(64),
  };
}

function policy(): HubTeamRunAuthorizationPolicy {
  return {
    executionWindow: {
      type: "event",
      opensAt: "2026-09-03T16:00:00.000Z",
      closesAt: windowClose,
    },
    maxRuntimeMs: 15 * 60_000,
    maxActiveRunsOnHost: 4,
    maxActiveRunsForSource: 1,
    launchAllowlist: [{ provider: "codex", models: ["gpt-5.6"] }],
  };
}

function createInput(overrides: { relationshipId?: string; maxUses?: number } = {}) {
  return {
    relationship: relationship(overrides.relationshipId),
    trigger: trigger(),
    target: target(),
    policy: policy(),
    maxUses: overrides.maxUses ?? 2,
    approvedByPrincipalId: "principal-owner",
    expiresAt: windowClose,
  };
}

function reservationInput(
  overrides: {
    relationshipId?: string;
    authorizationId?: string;
    triggerRunId?: string;
    providerEventReceiptId?: string;
  } = {},
) {
  return {
    relationship: relationship(overrides.relationshipId),
    authorizationId: overrides.authorizationId ?? authorizationId,
    expectedAuthorizationRevision: 1,
    trigger: trigger(),
    triggerRunId: overrides.triggerRunId ?? "trigger-run-1",
    providerEventReceiptId: overrides.providerEventReceiptId ?? "receipt-1",
    deadlineAt: windowClose,
  };
}

describe("HubTeamRunAuthorizationRepository", () => {
  let paseoHome: string;
  let now: Date;
  let authorizationIds: string[];
  let sourceIds: string[];
  let repository: HubTeamRunAuthorizationRepository;

  beforeEach(async () => {
    paseoHome = await mkdtemp(join(tmpdir(), "hub-team-run-authority-"));
    now = new Date(firstTimestamp);
    authorizationIds = [authorizationId, secondAuthorizationId];
    sourceIds = [firstSourceId, secondSourceId];
    repository = new HubTeamRunAuthorizationRepository({
      paseoHome,
      now: () => now,
      createAuthorizationId: () => authorizationIds.shift()!,
      createSourceId: () => sourceIds.shift()!,
    });
  });

  afterEach(async () => {
    await rm(paseoHome, { recursive: true, force: true });
  });

  test("persists local approval, exact trigger identity, and admitted Team Run linkage", async () => {
    const approved = await repository.createAuthorization(createInput());
    const reserved = await repository.reserveSource(reservationInput());
    const linked = await repository.bindTeamRun({
      relationshipId: approved.relationship.id,
      triggerRunId: reserved.source.triggerRunId,
      teamRunId: "trun_0123456789abcdef",
    });

    const reloaded = new HubTeamRunAuthorizationRepository({ paseoHome });
    await expect(reloaded.getAuthorization(approved.id)).resolves.toEqual(approved);
    await expect(
      reloaded.getSource(approved.relationship.id, reserved.source.triggerRunId),
    ).resolves.toEqual(linked);
    await expect(
      reloaded.bindTeamRun({
        relationshipId: approved.relationship.id,
        triggerRunId: reserved.source.triggerRunId,
        teamRunId: "trun_0123456789abcdef",
      }),
    ).resolves.toEqual(linked);
    await expect(
      reloaded.bindTeamRun({
        relationshipId: approved.relationship.id,
        triggerRunId: reserved.source.triggerRunId,
        teamRunId: "trun_fedcba9876543210",
      }),
    ).rejects.toBeInstanceOf(HubTeamRunSourceTeamRunConflictError);
    expect(reserved).toMatchObject({
      replayed: false,
      source: {
        authorizationId,
        authorizationRevision: 1,
        triggerRunId: "trigger-run-1",
        providerEventReceiptId: "receipt-1",
        deadlineAt: windowClose,
        targetFingerprint: "b".repeat(64),
        teamRunId: null,
      },
    });
    expect(reserved.source.idempotencyKey).toMatch(/^hub-team-run:[a-f0-9]{64}$/);

    const stored = await readFile(join(paseoHome, "hub", "team-run-authority.json"), "utf8");
    expect(stored).not.toContain("providerOptions");
    expect(stored).not.toContain('"cwd"');
    expect(stored).not.toContain('"prompt"');
  });

  test("returns exact trigger retries without consuming another use", async () => {
    await repository.createAuthorization(createInput({ maxUses: 1 }));
    const first = await repository.reserveSource(reservationInput());
    const replay = await repository.reserveSource(reservationInput());

    expect(replay).toEqual({ ...first, replayed: true });
    await expect(
      repository.reserveSource(
        reservationInput({ triggerRunId: "trigger-run-2", providerEventReceiptId: "receipt-2" }),
      ),
    ).rejects.toMatchObject({
      code: "hub_team_run_not_authorized",
      issue: "use_limit_reached",
    });
  });

  test("rejects conflicting reuse of a relationship trigger-run identity", async () => {
    await repository.createAuthorization(createInput());
    await repository.reserveSource(reservationInput());

    await expect(
      repository.reserveSource(reservationInput({ providerEventReceiptId: "different-receipt" })),
    ).rejects.toBeInstanceOf(HubTeamRunSourceConflictError);
  });

  test("keeps trigger identities isolated by authenticated relationship", async () => {
    await repository.createAuthorization(createInput());
    await expect(
      repository.reserveSource(reservationInput({ relationshipId: "relationship-2" })),
    ).rejects.toMatchObject({ issue: "not_authorized" });
    await expect(
      repository.reserveSource({
        ...reservationInput(),
        relationship: { id: "relationship-1", hubOrigin: "https://other.example.com" },
      }),
    ).rejects.toMatchObject({ issue: "not_authorized" });

    const second = await repository.createAuthorization(
      createInput({ relationshipId: "relationship-2" }),
    );
    const secondRelationshipSource = await repository.reserveSource({
      ...reservationInput({
        relationshipId: "relationship-2",
        authorizationId: second.id,
      }),
      expectedAuthorizationRevision: second.revision,
    });
    const firstRelationshipSource = await repository.reserveSource(reservationInput());

    expect(secondRelationshipSource.source.triggerRunId).toBe("trigger-run-1");
    expect(firstRelationshipSource.source.triggerRunId).toBe("trigger-run-1");
    expect(secondRelationshipSource.source.idempotencyKey).not.toBe(
      firstRelationshipSource.source.idempotencyKey,
    );
  });

  test("rejects expired and revoked authorization before reserving a source", async () => {
    const expired = await repository.createAuthorization(createInput());
    now = new Date(windowClose);
    await expect(repository.reserveSource(reservationInput())).rejects.toMatchObject({
      issue: "expired",
    });

    now = new Date(secondTimestamp);
    const active = await repository.createAuthorization(createInput());
    await repository.revokeAuthorization({
      authorizationId: active.id,
      expectedRevision: active.revision,
      revokedByPrincipalId: "principal-owner",
      reason: "Trigger disabled",
    });
    await expect(
      repository.reserveSource(
        reservationInput({ authorizationId: active.id, triggerRunId: "trigger-run-2" }),
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<HubTeamRunAuthorizationDeniedError>>({
        issue: "revoked",
      }),
    );
    expect(expired.id).toBe(authorizationId);
  });

  test("enforces the approved event window and exact deadline", async () => {
    await repository.createAuthorization(createInput());
    now = new Date("2026-09-03T15:59:59.999Z");
    await expect(repository.reserveSource(reservationInput())).rejects.toMatchObject({
      issue: "outside_execution_window",
    });

    now = new Date(firstTimestamp);
    await expect(
      repository.reserveSource({
        ...reservationInput(),
        deadlineAt: "2026-09-03T16:59:00.000Z",
      }),
    ).rejects.toMatchObject({ issue: "deadline_mismatch" });
    await expect(repository.listSourcesForAuthorization(authorizationId)).resolves.toEqual([]);
  });

  test("orders source reservation before a queued revocation", async () => {
    const approved = await repository.createAuthorization(createInput());
    let releaseWrite!: () => void;
    let observeWrite!: () => void;
    const writeBlocked = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writeObserved = new Promise<void>((resolve) => {
      observeWrite = resolve;
    });
    let blockNextWrite = true;
    const gated = new HubTeamRunAuthorizationRepository({
      paseoHome,
      now: () => now,
      createSourceId: () => firstSourceId,
      writeJson: async (filePath, value) => {
        if (blockNextWrite) {
          blockNextWrite = false;
          observeWrite();
          await writeBlocked;
        }
        await writeJsonFileAtomic(filePath, value);
      },
    });

    const reservation = gated.reserveSource(reservationInput());
    await writeObserved;
    now = new Date(secondTimestamp);
    const revocation = gated.revokeAuthorization({
      authorizationId: approved.id,
      expectedRevision: approved.revision,
      revokedByPrincipalId: "principal-owner",
      reason: null,
    });
    releaseWrite();
    const [reserved, revoked] = await Promise.all([reservation, revocation]);

    expect(reserved.source.authorizationRevision).toBe(1);
    expect(revoked.revocation?.revokedAt).toBe(secondTimestamp);
    await expect(gated.listSourcesForAuthorization(approved.id)).resolves.toHaveLength(1);
  });

  test("rejects source reservation queued behind revocation", async () => {
    const approved = await repository.createAuthorization(createInput());
    let releaseWrite!: () => void;
    let observeWrite!: () => void;
    const writeBlocked = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writeObserved = new Promise<void>((resolve) => {
      observeWrite = resolve;
    });
    let blockNextWrite = true;
    const gated = new HubTeamRunAuthorizationRepository({
      paseoHome,
      now: () => now,
      createSourceId: () => firstSourceId,
      writeJson: async (filePath, value) => {
        if (blockNextWrite) {
          blockNextWrite = false;
          observeWrite();
          await writeBlocked;
        }
        await writeJsonFileAtomic(filePath, value);
      },
    });

    const revocation = gated.revokeAuthorization({
      authorizationId: approved.id,
      expectedRevision: approved.revision,
      revokedByPrincipalId: "principal-owner",
      reason: null,
    });
    await writeObserved;
    const reservation = gated.reserveSource(reservationInput());
    releaseWrite();
    await revocation;

    await expect(reservation).rejects.toMatchObject({ issue: "revoked" });
    await expect(gated.listSourcesForAuthorization(approved.id)).resolves.toEqual([]);
  });
});
