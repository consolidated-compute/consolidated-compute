import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DaemonSetupPasswordSchema } from "@getpaseo/protocol/daemon-security";
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

// Trusted local callers can retry after a lost IPC response without issuing
// another code. This is deliberately not exposed over HTTP.
export function completeLocalSecuritySetup(home: string, password: string): void {
  const saved = loadPersistedConfig(home).daemon?.auth?.password;
  if (saved) {
    if (isBearerTokenValid({ password: saved, token: password })) return;
    throw new Error("This host already has a saved password.");
  }
  completeSecuritySetup({ home, code: issueSecuritySetupCode(home), password });
}

// Only local CLI/desktop code may issue this capability. Never expose issuance
// over the passwordless control plane or log the plaintext capability.
export function issueSecuritySetupCode(home: string, now = Date.now()): string {
  if (loadPersistedConfig(home).daemon?.auth?.password) {
    throw new Error("This host already has a saved password.");
  }
  const code = randomBytes(24).toString("hex");
  writeFileSync(
    challengePath(home),
    JSON.stringify({ digest: digest(code).toString("hex"), expiresAt: now + CODE_LIFETIME_MS }),
    { mode: 0o600 },
  );
  return code;
}

export function completeSecuritySetup(input: {
  home: string;
  code: string;
  password: string;
  now?: number;
}): void {
  const password = SecuritySetupInputSchema.shape.password.parse(input.password);
  const persisted = loadPersistedConfig(input.home);
  let challenge: z.infer<typeof challengeSchema>;
  try {
    challenge = challengeSchema.parse(JSON.parse(readFileSync(challengePath(input.home), "utf8")));
  } catch {
    throw new Error("Request a new setup code on the daemon host.");
  }
  if (
    challenge.expiresAt <= (input.now ?? Date.now()) ||
    !timingSafeEqual(digest(input.code), Buffer.from(challenge.digest, "hex"))
  ) {
    throw new Error("Setup code is invalid or expired. Request a new code on the daemon host.");
  }
  if (persisted.daemon?.auth?.password) {
    // A lost response may be retried with the same capability and password,
    // but this endpoint never replaces an existing credential.
    if (isBearerTokenValid({ password: persisted.daemon.auth.password, token: password })) return;
    throw new Error("This host already has a saved password.");
  }
  // Synchronous read/validate/write: two requests cannot both claim this home.
  // The saved password is the consumed marker, even if the process exits next.
  savePersistedConfig(input.home, {
    ...persisted,
    daemon: { ...persisted.daemon, auth: { password: hashDaemonPassword(password) } },
  });
}
