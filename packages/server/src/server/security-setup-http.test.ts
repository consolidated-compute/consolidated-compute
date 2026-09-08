import { expect, test } from "vitest";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { getOrCreateServerId } from "./server-id.js";
import { issueSecuritySetupCode } from "./security-setup.js";
import { loadPersistedConfig } from "./persisted-config.js";
import { hashDaemonPassword, isBearerTokenValid } from "./auth.js";

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
    const rejected = await submit(serverId, "wrong-code");
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ code: "code_invalid_or_expired" });
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

test("a running authenticated daemon cannot be reconfigured through initial setup", async () => {
  const password = "already-authenticated";
  const host = await createTestPaseoDaemon({ auth: { password: hashDaemonPassword(password) } });
  try {
    const response = await fetch(`http://127.0.0.1:${host.port}/api/security/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${password}` },
      body: JSON.stringify({
        serverId: getOrCreateServerId(host.paseoHome),
        code: issueSecuritySetupCode(host.paseoHome),
        password: "different-password",
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "already_configured" });
    expect(loadPersistedConfig(host.paseoHome).daemon?.auth?.password).toBeUndefined();
  } finally {
    await host.close();
  }
});
