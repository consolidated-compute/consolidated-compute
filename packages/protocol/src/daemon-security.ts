import { z } from "zod";

// Current clients put passwords directly in the WebSocket subprotocol. Initial
// setup must not save whitespace/Unicode that those transports cannot send.
export const DaemonSetupPasswordSchema = z.string().regex(/^[A-Za-z0-9._~-]{12,72}$/);
