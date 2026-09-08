import type { WebSocket } from "ws";
import {
  DeviceEnrollmentErrorCodeSchema,
  DeviceEnrollmentRequestSchema,
  type DeviceEnrollmentResponse,
} from "@getpaseo/protocol/device-enrollment";
import { DeviceAccessError, type DeviceAccessStore } from "./device-access.js";

/** Invitation possession authorizes only redemption, never session admission. */
export function attachDeviceEnrollmentSocket(ws: WebSocket, store: DeviceAccessStore): void {
  // Keep both idle and closing sockets bounded. Never install session handlers,
  // echo the supplied secrets, or log peer-controlled close reasons/errors.
  const deadline = setTimeout(() => ws.terminate(), 10_000);
  deadline.unref();
  ws.once("close", () => clearTimeout(deadline));
  ws.on("error", () => ws.terminate());
  ws.once("message", (data, isBinary) => {
    let bytes: Buffer;
    if (Buffer.isBuffer(data)) bytes = data;
    else if (Array.isArray(data)) bytes = Buffer.concat(data);
    else bytes = Buffer.from(data);
    if (isBinary || bytes.length > 2048) {
      ws.close(1008, "Invalid enrollment request");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString());
    } catch {
      ws.close(1008, "Invalid enrollment request");
      return;
    }
    const request = DeviceEnrollmentRequestSchema.safeParse(parsed);
    if (!request.success) {
      ws.close(1008, "Invalid enrollment request");
      return;
    }
    let response: DeviceEnrollmentResponse;
    try {
      const admission = store.enroll(request.data);
      response = {
        type: "device.enroll.response",
        payload: { status: "enrolled", requestId: request.data.requestId, ...admission },
      };
    } catch (error) {
      const code = DeviceEnrollmentErrorCodeSchema.safeParse(
        error instanceof DeviceAccessError ? error.code : null,
      );
      response = {
        type: "device.enroll.response",
        payload: {
          status: "error",
          requestId: request.data.requestId,
          code: code.success ? code.data : "enrollment_unavailable",
        },
      };
    }
    ws.send(JSON.stringify(response));
    ws.close(1000, "Enrollment exchange complete");
  });
}
