import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { WebSocket } from "ws";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

const protocol = "paseo.device-enrollment.v1";
const token = `cc_device_${"a".repeat(43)}`;

async function exchange(
  port: number,
  message: unknown,
  following: unknown[] = [],
): Promise<unknown[]> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, protocol);
  const messages: unknown[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  try {
    await Promise.all([
      once(socket, "open").then(() => {
        socket.send(JSON.stringify(message));
        for (const frame of following) socket.send(JSON.stringify(frame));
        return;
      }),
      once(socket, "close"),
    ]);
    return messages;
  } finally {
    socket.terminate();
  }
}

test("an invitation enrolls through a password-protected host without opening a session or activating device auth", async () => {
  const host = await createTestPaseoDaemon({ auth: { password: "operator-password" } });
  try {
    const store = host.daemon.deviceAccess;
    const invitation = store.createLocalInvitation({
      label: "Phone",
      permissions: ["workspace.read"],
    });
    const request = {
      type: "device.enroll.request",
      requestId: "enroll-1",
      code: invitation.code,
      token,
      permissions: ["access.manage"],
    };
    const messages = await exchange(host.port, request, [{ type: "hello", clientId: "attacker" }]);
    const admission = store.authenticate(token);
    expect(admission).toEqual({
      principalId: expect.any(String),
      credentialId: expect.any(String),
      permissions: ["workspace.read"],
    });
    expect(messages).toEqual([
      {
        type: "device.enroll.response",
        payload: { requestId: "enroll-1", status: "enrolled", ...admission },
      },
    ]);
    expect(store.isDeviceAuthenticationEnabled()).toBe(false);
    expect(await exchange(host.port, request)).toEqual(messages);
    expect(await exchange(host.port, { type: "hello", clientId: "attacker" })).toEqual([]);
    const persisted = await readFile(path.join(host.paseoHome, "device-access.json"), "utf8");
    expect(persisted).not.toContain(token);
    expect(persisted).not.toContain(invitation.code);
  } finally {
    await host.close();
  }
});

test("redemption returns stable errors without leaking storage details or consuming an invalid credential's invitation", async () => {
  const host = await createTestPaseoDaemon();
  try {
    const store = host.daemon.deviceAccess;
    const invitation = store.createLocalInvitation({
      label: "Phone",
      permissions: ["workspace.read"],
    });
    const request = {
      type: "device.enroll.request",
      requestId: "errors",
      code: invitation.code,
      token,
    };
    const errorResponse = (code: string) => [
      { type: "device.enroll.response", payload: { requestId: "errors", status: "error", code } },
    ];
    expect(await exchange(host.port, { ...request, token: "bad-credential" })).toEqual(
      errorResponse("credential_invalid"),
    );
    expect(await exchange(host.port, { ...request, code: "unknown-invitation" })).toEqual(
      errorResponse("invitation_invalid"),
    );
    await exchange(host.port, request);
    const admission = store.authenticate(token);
    if (!admission) throw new Error("Enrollment did not persist");
    expect(await exchange(host.port, { ...request, token: `cc_device_${"b".repeat(43)}` })).toEqual(
      errorResponse("invitation_consumed"),
    );
    const otherInvitation = store.createLocalInvitation({ label: "Other", permissions: [] });
    expect(await exchange(host.port, { ...request, code: otherInvitation.code })).toEqual(
      errorResponse("credential_already_enrolled"),
    );
    store.revokeCredential(admission.credentialId);
    expect(await exchange(host.port, request)).toEqual(errorResponse("credential_revoked"));
    await writeFile(
      path.join(host.paseoHome, "device-access.json"),
      "broken-registry-sensitive-data",
    );
    expect(await exchange(host.port, request)).toEqual(errorResponse("enrollment_unavailable"));
  } finally {
    await host.close();
  }
});

test("a device-authenticated host admits only the invitation exchange and retains its policy", async () => {
  const host = await createTestPaseoDaemon();
  try {
    const store = host.daemon.deviceAccess;
    const owner = store.createLocalInvitation({ label: "Owner", permissions: ["access.manage"] });
    store.enroll({ code: owner.code, token });
    store.enableDeviceAuthentication({ token });
    const invitation = store.createLocalInvitation({
      label: "Viewer",
      permissions: ["workspace.read"],
    });
    const viewerToken = `cc_device_${"b".repeat(43)}`;
    expect(
      await exchange(host.port, {
        type: "device.enroll.request",
        requestId: "viewer",
        code: invitation.code,
        token: viewerToken,
      }),
    ).toEqual([
      {
        type: "device.enroll.response",
        payload: {
          status: "enrolled",
          requestId: "viewer",
          principalId: expect.any(String),
          credentialId: expect.any(String),
          permissions: ["workspace.read"],
        },
      },
    ]);
    expect(store.isDeviceAuthenticationEnabled()).toBe(true);
    expect(
      await exchange(host.port, {
        type: "session",
        message: { type: "create_agent_request", requestId: "attack" },
      }),
    ).toEqual([]);
    expect(
      await exchange(host.port, {
        type: "device.enroll.request",
        requestId: "oversized",
        code: "x".repeat(3000),
        token,
      }),
    ).toEqual([]);
  } finally {
    await host.close();
  }
});
