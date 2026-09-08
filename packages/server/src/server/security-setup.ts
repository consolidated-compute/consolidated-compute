import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { writePrivateFileAtomicSync } from "./private-files.js";
import path from "node:path";
import { z } from "zod";
import { DaemonSetupPasswordSchema, SecuritySetupError } from "@getpaseo/protocol/daemon-security";
import { hashDaemonPassword, isBearerTokenValid } from "./auth.js";
import { loadPersistedConfig, savePersistedConfig } from "./persisted-config.js";

const CODE_LIFETIME_MS = 5 * 60_000;
const challengeSchema = z.object({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number(),
});
export const SecuritySetupInputSchema = z
  .object({
    serverId: z.string().min(1),
    code: z.string().min(1).max(128),
    password: DaemonSetupPasswordSchema,
  })
  .strict();

function challengePath(home: string): string {
  return path.join(home, "security-setup.json");
}

function digest(code: string): Buffer {
  return createHash("sha256").update(code).digest();
}

// Only local CLI/desktop code may issue this capability. Never expose issuance
// over the passwordless control plane or log the plaintext capability.
export function issueSecuritySetupCode(home: string, now = Date.now()): string {
  // Issuance may be retried after a lost save response; redemption still cannot
  // replace an existing password. CLI/desktop write only this challenge file.
  const code = randomBytes(24).toString("hex");
  try {
    writePrivateFileAtomicSync(
      challengePath(home),
      JSON.stringify({ digest: digest(code).toString("hex"), expiresAt: now + CODE_LIFETIME_MS }),
    );
  } catch {
    throw new SecuritySetupError("storage_unavailable");
  }
  return code;
}

export function completeSecuritySetup(input: {
  home: string;
  code: string;
  password: string;
  now?: number;
}): void {
  const parsedPassword = DaemonSetupPasswordSchema.safeParse(input.password);
  if (!parsedPassword.success) throw new SecuritySetupError("password_invalid");
  const password = parsedPassword.data;
  const persisted = loadPersistedConfig(input.home);
  let challenge: z.infer<typeof challengeSchema>;
  try {
    challenge = challengeSchema.parse(JSON.parse(readFileSync(challengePath(input.home), "utf8")));
  } catch {
    throw new SecuritySetupError("code_required");
  }
  if (
    challenge.expiresAt <= (input.now ?? Date.now()) ||
    !timingSafeEqual(digest(input.code), Buffer.from(challenge.digest, "hex"))
  ) {
    throw new SecuritySetupError("code_invalid_or_expired");
  }
  if (persisted.daemon?.auth?.password) {
    // A lost response may be retried with the same capability and password,
    // but this endpoint never replaces an existing credential.
    if (isBearerTokenValid({ password: persisted.daemon.auth.password, token: password })) return;
    throw new SecuritySetupError("already_configured");
  }
  // Synchronous read/validate/write: two requests cannot both claim this home.
  // The saved password is the consumed marker, even if the process exits next.
  try {
    savePersistedConfig(input.home, {
      ...persisted,
      daemon: { ...persisted.daemon, auth: { password: hashDaemonPassword(password) } },
    });
  } catch {
    throw new SecuritySetupError("storage_unavailable");
  }
}
