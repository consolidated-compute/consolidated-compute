import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

test("device downloads require both current device authority and a single-use file token", async () => {
  const host = await createTestPaseoDaemon();
  let client: DaemonClient | null = null;
  const credential = `cc_device_${"a".repeat(43)}`;
  try {
    const store = host.daemon.deviceAccess;
    const invitation = store.createLocalInvitation({
      label: "Downloads",
      permissions: ["access.manage", "workspace.read"],
    });
    const admission = store.enroll({ code: invitation.code, token: credential });
    store.enableDeviceAuthentication({ token: credential });
    await writeFile(
      path.join(host.paseoHome, "download-proof.txt"),
      "exact device download payload",
    );
    client = new DaemonClient({
      url: `ws://127.0.0.1:${host.port}/ws`,
      clientId: "device-download",
      deviceCredential: credential,
      reconnect: { enabled: false },
    });
    await client.connect();
    const token = await client.requestDownloadToken(host.paseoHome, "download-proof.txt");
    expect(token.error).toBeNull();
    if (!token.token) throw new Error("Missing file token");
    const url = `http://127.0.0.1:${host.port}/api/files/download?token=${encodeURIComponent(token.token)}`;
    expect((await fetch(url)).status).toBe(401);
    const init = { headers: { Authorization: `Bearer ${credential}` }, redirect: "error" as const };
    const response = await fetch(url, init);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("exact device download payload");
    expect((await fetch(url, init)).status).toBe(403);
    const next = await client.requestDownloadToken(host.paseoHome, "download-proof.txt");
    if (!next.token) throw new Error("Missing second file token");
    store.revokeCredential(admission.credentialId);
    expect(
      (
        await fetch(
          `http://127.0.0.1:${host.port}/api/files/download?token=${encodeURIComponent(next.token)}`,
          init,
        )
      ).status,
    ).toBe(401);
  } finally {
    await client?.close();
    await host.close();
  }
});
