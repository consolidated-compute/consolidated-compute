import { expect, test } from "vitest";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { getOrCreateServerId } from "./server-id.js";
import { issueSecuritySetupCode } from "./security-setup.js";
import { loadPersistedConfig } from "./persisted-config.js";
import { isBearerTokenValid } from "./auth.js";

test("initial security setup requires a host-bound local code and does not restart", async () => {
  const host = await createTestPaseoDaemon();
  try {
    const serverId = getOrCreateServerId(host.paseoHome);
    const code = issueSecuritySetupCode(host.paseoHome);
    const password = "isolated-setup-password";
    const submit = (target: string, capability: string) =>
      fetch(`http://127.0.0.1:${host.port}/api/security/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: target, code: capability, password }),
      });
    expect((await submit("another-host", code)).status).toBe(400);
    expect((await submit(serverId, "wrong-code")).status).toBe(409);
    expect(loadPersistedConfig(host.paseoHome).daemon?.auth?.password).toBeUndefined();
    const saved = await submit(serverId, code);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ restartRequired: true });
    expect(
      isBearerTokenValid({
        password: loadPersistedConfig(host.paseoHome).daemon?.auth?.password,
        token: password,
      }),
    ).toBe(true);
    expect((await submit(serverId, code)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${host.port}/api/status`)).status).toBe(200);
  } finally {
    await host.close();
  }
});
