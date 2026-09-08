import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DaemonPermissionSchema, type DaemonPermission } from "@getpaseo/protocol/messages";

const permissionsSchema = z.array(DaemonPermissionSchema).max(32);
const labelSchema = z.string().trim().min(1).max(120);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const credentialTokenSchema = z.string().regex(/^cc_device_[A-Za-z0-9_-]{43}$/);
const principalSchema = z.object({
  id: z.string().uuid(),
  label: labelSchema,
  permissions: permissionsSchema,
  createdAt: z.number().int().nonnegative(),
  revokedAt: z.number().int().nonnegative().nullable(),
});
const credentialSchema = z.object({
  id: z.string().uuid(),
  principalId: z.string().uuid(),
  digest: digestSchema,
  createdAt: z.number().int().nonnegative(),
  revokedAt: z.number().int().nonnegative().nullable(),
});
const invitationSchema = z.object({
  digest: digestSchema,
  label: labelSchema,
  permissions: permissionsSchema,
  expiresAt: z.number().int().nonnegative(),
  credentialId: z.string().uuid().nullable(),
});
const registrySchema = z
  .object({
    principals: z.array(principalSchema),
    credentials: z.array(credentialSchema),
    invitations: z.array(invitationSchema),
  })
  .superRefine((state, context) => {
    const unique = (values: string[]) => new Set(values).size === values.length;
    if (
      !unique(state.principals.map((p) => p.id)) ||
      !unique(state.credentials.map((c) => c.id)) ||
      !unique(state.credentials.map((c) => c.digest)) ||
      !unique(state.invitations.map((i) => i.digest)) ||
      state.credentials.some((c) => !state.principals.some((p) => p.id === c.principalId)) ||
      state.invitations.some(
        (i) => i.credentialId !== null && !state.credentials.some((c) => c.id === i.credentialId),
      )
    ) {
      context.addIssue({ code: "custom", message: "Invalid device access references" });
    }
  });
type Registry = z.infer<typeof registrySchema>;

const deviceAccessErrorMessages = {
  credential_invalid: "Invalid device credential",
  invitation_invalid: "Invalid device invitation",
  invitation_expired: "Device invitation expired",
  invitation_consumed: "Device invitation already consumed",
  credential_revoked: "Device credential revoked",
  credential_already_enrolled: "Device credential already enrolled",
  invitation_limit_reached: "Too many pending device invitations",
  credential_not_found: "Unknown device credential",
  principal_not_found: "Unknown device principal",
} as const;

export type DeviceAccessErrorCode = keyof typeof deviceAccessErrorMessages;

export class DeviceAccessError extends Error {
  constructor(public readonly code: DeviceAccessErrorCode) {
    super(deviceAccessErrorMessages[code]);
    this.name = "DeviceAccessError";
  }
}

export interface DeviceAdmission {
  principalId: string;
  credentialId: string;
  permissions: DaemonPermission[];
}

function digest(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * Single-daemon-owned store. Mutation methods require trusted host authority;
 * they are not RPC authorization checks. Do not open a second writer process.
 * Only digests of high-entropy client credentials and local invitation codes
 * are persisted. This does not isolate the daemon from same-user processes.
 */
export class DeviceAccessStore {
  private readonly file: string;
  private readonly now: () => number;

  constructor(input: { home: string; now?: () => number }) {
    this.file = path.join(input.home, "device-access.json");
    this.now = input.now ?? Date.now;
  }

  createLocalInvitation(input: { label: string; permissions: DaemonPermission[] }): {
    code: string;
    expiresAt: number;
  } {
    const state = this.read();
    const label = labelSchema.parse(input.label);
    const permissions = [...new Set(permissionsSchema.parse(input.permissions))];
    const code = `cc_pair_${randomBytes(32).toString("base64url")}`;
    const expiresAt = this.now() + 300_000;
    state.invitations = state.invitations.filter(
      (i) => i.credentialId !== null || i.expiresAt > this.now(),
    );
    if (state.invitations.filter((i) => i.credentialId === null).length >= 100) {
      throw new DeviceAccessError("invitation_limit_reached");
    }
    state.invitations.push({
      digest: digest(code),
      label,
      permissions,
      expiresAt,
      credentialId: null,
    });
    this.write(state);
    return { code, expiresAt };
  }

  // The client must generate and retain 32 random bytes before enrollment.
  // Retrying the same code/token recovers a lost response without storing or
  // returning the plaintext credential on the daemon.
  enroll({ code, token }: { code: string; token: string }): DeviceAdmission {
    if (!credentialTokenSchema.safeParse(token).success) {
      throw new DeviceAccessError("credential_invalid");
    }
    const state = this.read();
    const invitation = state.invitations.find((i) => i.digest === digest(code));
    if (!invitation) throw new DeviceAccessError("invitation_invalid");
    const tokenDigest = digest(token);
    if (invitation.credentialId !== null) {
      const credential = state.credentials.find((c) => c.id === invitation.credentialId);
      if (!credential || credential.digest !== tokenDigest)
        throw new DeviceAccessError("invitation_consumed");
      const admission = this.admission(state, credential);
      if (!admission) throw new DeviceAccessError("credential_revoked");
      return admission;
    }
    if (invitation.expiresAt <= this.now()) throw new DeviceAccessError("invitation_expired");
    if (state.credentials.some((c) => c.digest === tokenDigest))
      throw new DeviceAccessError("credential_already_enrolled");
    const now = this.now();
    const principal = {
      id: randomUUID(),
      label: invitation.label,
      permissions: invitation.permissions,
      createdAt: now,
      revokedAt: null,
    };
    const credential = {
      id: randomUUID(),
      principalId: principal.id,
      digest: tokenDigest,
      createdAt: now,
      revokedAt: null,
    };
    state.principals.push(principal);
    state.credentials.push(credential);
    invitation.credentialId = credential.id;
    this.write(state);
    return {
      principalId: principal.id,
      credentialId: credential.id,
      permissions: [...principal.permissions],
    };
  }

  authenticate(token: string | null): DeviceAdmission | null {
    const state = this.read();
    if (token === null || !credentialTokenSchema.safeParse(token).success) return null;
    const credential = state.credentials.find((c) => c.digest === digest(token));
    return credential ? this.admission(state, credential) : null;
  }

  revokeCredential(id: string): void {
    const state = this.read();
    const credential = state.credentials.find((c) => c.id === id);
    if (!credential) throw new DeviceAccessError("credential_not_found");
    credential.revokedAt ??= this.now();
    this.write(state);
  }

  revokePrincipal(id: string): void {
    const state = this.read();
    const principal = state.principals.find((p) => p.id === id);
    if (!principal) throw new DeviceAccessError("principal_not_found");
    principal.revokedAt ??= this.now();
    this.write(state);
  }

  setPrincipalPermissions({
    principalId,
    permissions,
  }: {
    principalId: string;
    permissions: DaemonPermission[];
  }): void {
    const state = this.read();
    const principal = state.principals.find((p) => p.id === principalId);
    if (!principal) throw new DeviceAccessError("principal_not_found");
    principal.permissions = [...new Set(permissionsSchema.parse(permissions))];
    this.write(state);
  }

  private admission(
    state: Registry,
    credential: z.infer<typeof credentialSchema>,
  ): DeviceAdmission | null {
    const principal = state.principals.find((p) => p.id === credential.principalId);
    if (!principal || principal.revokedAt !== null || credential.revokedAt !== null) return null;
    return {
      principalId: principal.id,
      credentialId: credential.id,
      permissions: [...principal.permissions],
    };
  }

  private read(): Registry {
    let contents: string;
    try {
      contents = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { principals: [], credentials: [], invitations: [] };
      throw new Error("Cannot read device access storage", { cause: error });
    }
    try {
      return registrySchema.parse(JSON.parse(contents));
    } catch (error) {
      throw new Error("Invalid device access storage", { cause: error });
    }
  }

  private write(state: Registry): void {
    const data = JSON.stringify(registrySchema.parse(state));
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, data, { flag: "wx", mode: 0o600 });
      renameSync(temp, this.file);
    } finally {
      rmSync(temp, { force: true });
    }
  }
}
