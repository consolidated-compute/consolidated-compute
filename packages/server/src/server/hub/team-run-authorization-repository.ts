import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { writeJsonFileAtomic } from "../atomic-file.js";
import {
  hostPersistenceBoundaryKey,
  serializeHostPersistenceMutation,
} from "../persistence-mutation.js";
import {
  generateHubTeamRunAuthorizationId,
  generateHubTeamRunSourceId,
  PersistedHubRelationshipIdentitySchema,
  PersistedHubTeamRunAuthorityStoreSchema,
  PersistedHubTeamRunAuthorizationSchema,
  PersistedHubTeamRunSourceSchema,
  PersistedHubTriggerIdentitySchema,
  type HubTeamRunAuthorizationPolicy,
  type PersistedHubRelationshipIdentity,
  type PersistedHubTeamRunAuthorization,
  type PersistedHubTeamRunAuthorizationTarget,
  type PersistedHubTeamRunAuthorityStore,
  type PersistedHubTeamRunSource,
  type PersistedHubTriggerIdentity,
} from "./team-run-authorization-model.js";

const STORE_FILE_NAME = "team-run-authority.json";

export interface CreateHubTeamRunAuthorizationInput {
  relationship: PersistedHubRelationshipIdentity;
  trigger: PersistedHubTriggerIdentity;
  target: PersistedHubTeamRunAuthorizationTarget;
  policy: HubTeamRunAuthorizationPolicy;
  maxUses: number;
  approvedByPrincipalId: string;
  expiresAt: string;
}

export interface RevokeHubTeamRunAuthorizationInput {
  authorizationId: string;
  expectedRevision: number;
  revokedByPrincipalId: string;
  reason: string | null;
}

export interface ReserveHubTeamRunSourceInput {
  relationship: PersistedHubRelationshipIdentity;
  authorizationId: string;
  expectedAuthorizationRevision: number;
  trigger: PersistedHubTriggerIdentity;
  triggerRunId: string;
  providerEventReceiptId: string;
  deadlineAt: string;
}

export type InspectHubTeamRunSourceInput = Omit<
  ReserveHubTeamRunSourceInput,
  "expectedAuthorizationRevision"
>;

export interface HubTeamRunSourceInspection {
  authorization: PersistedHubTeamRunAuthorization;
  existingSource: PersistedHubTeamRunSource | null;
}

export interface HubTeamRunSourceReservation {
  authorization: PersistedHubTeamRunAuthorization;
  source: PersistedHubTeamRunSource;
  replayed: boolean;
}

export interface BindHubTeamRunSourceInput {
  relationshipId: string;
  triggerRunId: string;
  teamRunId: string;
}

export interface HubTeamRunAuthorizationRepositoryOptions {
  paseoHome: string;
  now?: () => Date;
  writeJson?: (filePath: string, value: unknown) => Promise<void>;
  createAuthorizationId?: () => string;
  createSourceId?: () => string;
}

export type HubTeamRunAuthorizationDeniedIssue =
  | "not_authorized"
  | "revision_changed"
  | "revoked"
  | "expired"
  | "outside_execution_window"
  | "deadline_mismatch"
  | "use_limit_reached";

export class HubTeamRunAuthorizationNotFoundError extends Error {
  readonly code = "hub_team_run_authorization_not_found";

  constructor(readonly authorizationId: string) {
    super(`Hub Team Run authorization not found: ${authorizationId}`);
    this.name = "HubTeamRunAuthorizationNotFoundError";
  }
}

export class HubTeamRunAuthorizationRevisionConflictError extends Error {
  readonly code = "hub_team_run_authorization_revision_conflict";

  constructor(
    readonly authorizationId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Hub Team Run authorization revision conflict for ${authorizationId}: expected ${expectedRevision}, found ${actualRevision}`,
    );
    this.name = "HubTeamRunAuthorizationRevisionConflictError";
  }
}

export class HubTeamRunAuthorizationDeniedError extends Error {
  readonly code = "hub_team_run_not_authorized";

  constructor(readonly issue: HubTeamRunAuthorizationDeniedIssue) {
    super("This Hub trigger is not authorized to start the requested Team Run");
    this.name = "HubTeamRunAuthorizationDeniedError";
  }
}

export class HubTeamRunSourceConflictError extends Error {
  readonly code = "hub_team_run_source_conflict";

  constructor(
    readonly relationshipId: string,
    readonly triggerRunId: string,
  ) {
    super("This Hub trigger-run identity is already bound to different immutable facts");
    this.name = "HubTeamRunSourceConflictError";
  }
}

export class HubTeamRunSourceNotFoundError extends Error {
  readonly code = "hub_team_run_source_not_found";

  constructor(
    readonly relationshipId: string,
    readonly triggerRunId: string,
  ) {
    super("Hub Team Run source not found");
    this.name = "HubTeamRunSourceNotFoundError";
  }
}

export class HubTeamRunSourceTeamRunConflictError extends Error {
  readonly code = "hub_team_run_source_team_run_conflict";

  constructor(
    readonly relationshipId: string,
    readonly triggerRunId: string,
    readonly existingTeamRunId: string,
  ) {
    super("This Hub trigger-run identity is already bound to a different Team Run");
    this.name = "HubTeamRunSourceTeamRunConflictError";
  }
}

export class HubTeamRunAuthorizationRepository {
  readonly persistenceBoundaryKey: string;
  private readonly filePath: string;
  private readonly now: () => Date;
  private readonly writeJson: (filePath: string, value: unknown) => Promise<void>;
  private readonly createAuthorizationId: () => string;
  private readonly createSourceId: () => string;

  constructor(options: HubTeamRunAuthorizationRepositoryOptions) {
    const paseoHome = resolve(options.paseoHome);
    this.persistenceBoundaryKey = hostPersistenceBoundaryKey(paseoHome);
    this.filePath = join(paseoHome, "hub", STORE_FILE_NAME);
    this.now = options.now ?? (() => new Date());
    this.writeJson = options.writeJson ?? writeJsonFileAtomic;
    this.createAuthorizationId = options.createAuthorizationId ?? generateHubTeamRunAuthorizationId;
    this.createSourceId = options.createSourceId ?? generateHubTeamRunSourceId;
  }

  async createAuthorization(
    input: CreateHubTeamRunAuthorizationInput,
  ): Promise<PersistedHubTeamRunAuthorization> {
    return this.serializeMutation(async () => {
      const store = await this.readStore();
      const authorizationId = this.generateAvailableAuthorizationId(store);
      const timestamp = this.now().toISOString();
      const authorization = PersistedHubTeamRunAuthorizationSchema.parse({
        id: authorizationId,
        revision: 1,
        relationship: PersistedHubRelationshipIdentitySchema.parse(input.relationship),
        trigger: PersistedHubTriggerIdentitySchema.parse(input.trigger),
        target: input.target,
        unattendedPolicy: {
          ...input.policy,
          source: { type: "hub", scopeId: authorizationId },
        },
        maxUses: input.maxUses,
        approvedBy: {
          principalId: input.approvedByPrincipalId,
          approvedAt: timestamp,
        },
        revocation: null,
        expiresAt: input.expiresAt,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await this.writeStore({
        ...store,
        authorizations: [...store.authorizations, authorization],
      });
      return authorization;
    });
  }

  async getAuthorization(
    authorizationId: string,
  ): Promise<PersistedHubTeamRunAuthorization | null> {
    const store = await this.readStore();
    return store.authorizations.find((entry) => entry.id === authorizationId) ?? null;
  }

  async listAuthorizations(relationshipId?: string): Promise<PersistedHubTeamRunAuthorization[]> {
    const store = await this.readStore();
    return store.authorizations.filter(
      (authorization) =>
        relationshipId === undefined || authorization.relationship.id === relationshipId,
    );
  }

  async revokeAuthorization(
    input: RevokeHubTeamRunAuthorizationInput,
  ): Promise<PersistedHubTeamRunAuthorization> {
    return this.serializeMutation(async () => {
      const store = await this.readStore();
      const index = store.authorizations.findIndex(
        (authorization) => authorization.id === input.authorizationId,
      );
      if (index < 0) throw new HubTeamRunAuthorizationNotFoundError(input.authorizationId);
      const current = store.authorizations[index]!;
      if (current.revision !== input.expectedRevision) {
        throw new HubTeamRunAuthorizationRevisionConflictError(
          current.id,
          input.expectedRevision,
          current.revision,
        );
      }
      if (current.revocation) return current;

      const timestamp = this.now().toISOString();
      const revoked = PersistedHubTeamRunAuthorizationSchema.parse({
        ...current,
        revision: 2,
        revocation: {
          principalId: input.revokedByPrincipalId,
          revokedAt: timestamp,
          reason: input.reason,
        },
        updatedAt: timestamp,
      });
      const authorizations = store.authorizations.slice();
      authorizations[index] = revoked;
      await this.writeStore({ ...store, authorizations });
      return revoked;
    });
  }

  async getSource(
    relationshipId: string,
    triggerRunId: string,
  ): Promise<PersistedHubTeamRunSource | null> {
    const store = await this.readStore();
    return findSource(store, relationshipId, triggerRunId) ?? null;
  }

  async listSourcesForAuthorization(authorizationId: string): Promise<PersistedHubTeamRunSource[]> {
    const store = await this.readStore();
    return store.sources.filter((source) => source.authorizationId === authorizationId);
  }

  async inspectSourceReservation(
    input: InspectHubTeamRunSourceInput,
  ): Promise<HubTeamRunSourceInspection> {
    const store = await this.readStore();
    const relationship = PersistedHubRelationshipIdentitySchema.parse(input.relationship);
    const trigger = PersistedHubTriggerIdentitySchema.parse(input.trigger);
    const existing = findSource(store, relationship.id, input.triggerRunId);
    if (existing) {
      if (!matchesReservationRequest(existing, { ...input, relationship, trigger })) {
        throw new HubTeamRunSourceConflictError(relationship.id, input.triggerRunId);
      }
      const authorization = store.authorizations.find(
        (candidate) => candidate.id === existing.authorizationId,
      );
      if (!authorization) throw new HubTeamRunAuthorizationDeniedError("not_authorized");
      return { authorization, existingSource: existing };
    }

    const authorization = this.requireReservableAuthorization(store, {
      ...input,
      relationship,
      trigger,
      expectedAuthorizationRevision:
        store.authorizations.find((candidate) => candidate.id === input.authorizationId)
          ?.revision ?? 0,
    });
    return { authorization, existingSource: null };
  }

  async reserveSource(input: ReserveHubTeamRunSourceInput): Promise<HubTeamRunSourceReservation> {
    return this.serializeMutation(async () => {
      const store = await this.readStore();
      const relationship = PersistedHubRelationshipIdentitySchema.parse(input.relationship);
      const trigger = PersistedHubTriggerIdentitySchema.parse(input.trigger);
      const existing = findSource(store, relationship.id, input.triggerRunId);
      if (existing) {
        if (!matchesReservation(existing, { ...input, relationship, trigger })) {
          throw new HubTeamRunSourceConflictError(relationship.id, input.triggerRunId);
        }
        const authorization = store.authorizations.find(
          (candidate) => candidate.id === existing.authorizationId,
        );
        if (!authorization) {
          throw new HubTeamRunAuthorizationDeniedError("not_authorized");
        }
        return { authorization, source: existing, replayed: true };
      }

      const authorization = this.requireReservableAuthorization(store, {
        ...input,
        relationship,
        trigger,
      });
      const sourceId = this.generateAvailableSourceId(store);
      const timestamp = this.now().toISOString();
      const source = PersistedHubTeamRunSourceSchema.parse({
        id: sourceId,
        relationship,
        authorizationId: authorization.id,
        authorizationRevision: authorization.revision,
        trigger,
        triggerRunId: input.triggerRunId,
        providerEventReceiptId: input.providerEventReceiptId,
        deadlineAt: input.deadlineAt,
        targetFingerprint: authorization.target.previewFingerprint,
        idempotencyKey: createHubTeamRunIdempotencyKey(relationship.id, input.triggerRunId),
        teamRunId: null,
        reservedAt: timestamp,
        updatedAt: timestamp,
      });
      await this.writeStore({ ...store, sources: [...store.sources, source] });
      return { authorization, source, replayed: false };
    });
  }

  async bindTeamRun(input: BindHubTeamRunSourceInput): Promise<PersistedHubTeamRunSource> {
    return this.serializeMutation(async () => {
      const store = await this.readStore();
      const index = store.sources.findIndex(
        (source) =>
          source.relationship.id === input.relationshipId &&
          source.triggerRunId === input.triggerRunId,
      );
      if (index < 0) {
        throw new HubTeamRunSourceNotFoundError(input.relationshipId, input.triggerRunId);
      }
      const current = store.sources[index]!;
      if (current.teamRunId === input.teamRunId) return current;
      if (current.teamRunId !== null) {
        throw new HubTeamRunSourceTeamRunConflictError(
          input.relationshipId,
          input.triggerRunId,
          current.teamRunId,
        );
      }
      const source = PersistedHubTeamRunSourceSchema.parse({
        ...current,
        teamRunId: input.teamRunId,
        updatedAt: this.now().toISOString(),
      });
      const sources = store.sources.slice();
      sources[index] = source;
      await this.writeStore({ ...store, sources });
      return source;
    });
  }

  private requireReservableAuthorization(
    store: PersistedHubTeamRunAuthorityStore,
    input: ReserveHubTeamRunSourceInput,
  ): PersistedHubTeamRunAuthorization {
    const authorization = store.authorizations.find(
      (candidate) => candidate.id === input.authorizationId,
    );
    if (
      !authorization ||
      !isDeepStrictEqual(authorization.relationship, input.relationship) ||
      !isDeepStrictEqual(authorization.trigger, input.trigger)
    ) {
      throw new HubTeamRunAuthorizationDeniedError("not_authorized");
    }
    if (authorization.revocation) {
      throw new HubTeamRunAuthorizationDeniedError("revoked");
    }
    if (authorization.revision !== input.expectedAuthorizationRevision) {
      throw new HubTeamRunAuthorizationDeniedError("revision_changed");
    }

    const now = this.now().getTime();
    if (now >= Date.parse(authorization.expiresAt)) {
      throw new HubTeamRunAuthorizationDeniedError("expired");
    }
    const executionWindow = authorization.unattendedPolicy.executionWindow;
    if (
      executionWindow.type !== "event" ||
      now < Date.parse(executionWindow.opensAt) ||
      now >= Date.parse(executionWindow.closesAt)
    ) {
      throw new HubTeamRunAuthorizationDeniedError("outside_execution_window");
    }
    if (input.deadlineAt !== executionWindow.closesAt) {
      throw new HubTeamRunAuthorizationDeniedError("deadline_mismatch");
    }
    const uses = store.sources.filter(
      (source) => source.authorizationId === authorization.id,
    ).length;
    if (uses >= authorization.maxUses) {
      throw new HubTeamRunAuthorizationDeniedError("use_limit_reached");
    }
    return authorization;
  }

  private async readStore(): Promise<PersistedHubTeamRunAuthorityStore> {
    try {
      const contents = await readFile(this.filePath, "utf8");
      return PersistedHubTeamRunAuthorityStoreSchema.parse(JSON.parse(contents));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, authorizations: [], sources: [] };
      }
      throw error;
    }
  }

  private async writeStore(store: PersistedHubTeamRunAuthorityStore): Promise<void> {
    await this.writeJson(this.filePath, PersistedHubTeamRunAuthorityStoreSchema.parse(store));
  }

  private serializeMutation<T>(mutation: () => Promise<T>): Promise<T> {
    return serializeHostPersistenceMutation(this.persistenceBoundaryKey, mutation);
  }

  private generateAvailableAuthorizationId(store: PersistedHubTeamRunAuthorityStore): string {
    let id = this.createAuthorizationId();
    while (store.authorizations.some((authorization) => authorization.id === id)) {
      id = this.createAuthorizationId();
    }
    return id;
  }

  private generateAvailableSourceId(store: PersistedHubTeamRunAuthorityStore): string {
    let id = this.createSourceId();
    while (store.sources.some((source) => source.id === id)) {
      id = this.createSourceId();
    }
    return id;
  }
}

function findSource(
  store: PersistedHubTeamRunAuthorityStore,
  relationshipId: string,
  triggerRunId: string,
): PersistedHubTeamRunSource | undefined {
  return store.sources.find(
    (source) => source.relationship.id === relationshipId && source.triggerRunId === triggerRunId,
  );
}

function matchesReservation(
  source: PersistedHubTeamRunSource,
  input: ReserveHubTeamRunSourceInput,
): boolean {
  return isDeepStrictEqual(
    {
      relationship: source.relationship,
      authorizationId: source.authorizationId,
      authorizationRevision: source.authorizationRevision,
      trigger: source.trigger,
      triggerRunId: source.triggerRunId,
      providerEventReceiptId: source.providerEventReceiptId,
      deadlineAt: source.deadlineAt,
    },
    {
      relationship: input.relationship,
      authorizationId: input.authorizationId,
      authorizationRevision: input.expectedAuthorizationRevision,
      trigger: input.trigger,
      triggerRunId: input.triggerRunId,
      providerEventReceiptId: input.providerEventReceiptId,
      deadlineAt: input.deadlineAt,
    },
  );
}

function matchesReservationRequest(
  source: PersistedHubTeamRunSource,
  input: InspectHubTeamRunSourceInput,
): boolean {
  return isDeepStrictEqual(
    {
      relationship: source.relationship,
      authorizationId: source.authorizationId,
      trigger: source.trigger,
      triggerRunId: source.triggerRunId,
      providerEventReceiptId: source.providerEventReceiptId,
      deadlineAt: source.deadlineAt,
    },
    {
      relationship: input.relationship,
      authorizationId: input.authorizationId,
      trigger: input.trigger,
      triggerRunId: input.triggerRunId,
      providerEventReceiptId: input.providerEventReceiptId,
      deadlineAt: input.deadlineAt,
    },
  );
}

export function createHubTeamRunIdempotencyKey(
  relationshipId: string,
  triggerRunId: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([relationshipId, triggerRunId]))
    .digest("hex");
  return `hub-team-run:${digest}`;
}
