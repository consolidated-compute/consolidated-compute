import { z } from "zod";
import { DaemonPermissionSchema } from "./messages.js";

// A separate, one-exchange protocol: never a control-plane session. Successful
// subprotocol negotiation alone is not enrollment; require the typed response.
export const DEVICE_ENROLLMENT_PROTOCOL = "paseo.device-enrollment.v1";

export const DeviceEnrollmentRequestSchema = z.object({
  type: z.literal("device.enroll.request"),
  requestId: z.string().min(1).max(128),
  code: z.string().min(1).max(128),
  token: z.string().min(1).max(128),
});

export const DeviceEnrollmentErrorCodeSchema = z.enum([
  "credential_invalid",
  "invitation_invalid",
  "invitation_expired",
  "invitation_consumed",
  "credential_revoked",
  "credential_already_enrolled",
  "enrollment_unavailable",
]);

export const DeviceEnrollmentResponseSchema = z.object({
  type: z.literal("device.enroll.response"),
  payload: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("enrolled"),
      requestId: z.string(),
      principalId: z.string().uuid(),
      credentialId: z.string().uuid(),
      permissions: z.array(DaemonPermissionSchema),
    }),
    z.object({
      status: z.literal("error"),
      requestId: z.string(),
      code: DeviceEnrollmentErrorCodeSchema,
    }),
  ]),
});

export type DeviceEnrollmentResponse = z.infer<typeof DeviceEnrollmentResponseSchema>;
