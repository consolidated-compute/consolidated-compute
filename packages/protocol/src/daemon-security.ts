import { z } from "zod";

// Current clients put passwords directly in the WebSocket subprotocol. Initial
// setup must not save whitespace/Unicode that those transports cannot send.
export const DaemonSetupPasswordSchema = z.string().regex(/^[A-Za-z0-9._~-]{12,72}$/);

export const SecuritySetupErrorCodeSchema = z.enum([
  "password_invalid",
  "already_configured",
  "code_invalid_or_expired",
  "code_required",
  "storage_unavailable",
  "host_mismatch",
  "launcher_override",
  "device_authentication_enabled",
  "request_invalid",
  "request_failed",
]);
export const SecuritySetupFailureSchema = z.object({ code: SecuritySetupErrorCodeSchema });
const messages: Record<z.infer<typeof SecuritySetupErrorCodeSchema>, string> = {
  password_invalid: "Use a password matching the displayed length and character requirements.",
  already_configured: "This host already has a saved password. Setup cannot replace it.",
  code_invalid_or_expired:
    "Setup code is invalid or expired. Request a new code on the daemon host.",
  code_required: "Request a new setup code on the daemon host.",
  storage_unavailable: "Could not save host security. Check host storage and retry.",
  host_mismatch: "The selected host or connection changed. Reopen setup for the intended host.",
  launcher_override:
    "Remove the password override from the host launcher and restart safely before setup.",
  device_authentication_enabled:
    "This host uses a device credential. Saved-password setup cannot change device access.",
  request_invalid: "Invalid security setup request. Reopen setup and try again.",
  request_failed: "Host security setup failed. Check the connection and retry.",
};
export class SecuritySetupError extends Error {
  constructor(readonly code: z.infer<typeof SecuritySetupErrorCodeSchema>) {
    super(messages[code]);
    this.name = "SecuritySetupError";
  }
}
