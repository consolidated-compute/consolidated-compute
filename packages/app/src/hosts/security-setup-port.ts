import type { DirectTcpHostConnection } from "@/types/host-connection";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import { restartDesktopDaemon } from "@/desktop/daemon/desktop-daemon";
import type { SecuritySetupPort } from "./security-setup-model";
import { securitySetupUrl } from "./security-setup-endpoint";
import { SecuritySetupError, SecuritySetupFailureSchema } from "@getpaseo/protocol/daemon-security";

export function createSecuritySetupPort(
  serverId: string,
  desktop: boolean,
  connection: DirectTcpHostConnection,
): SecuritySetupPort {
  const runtime = getHostRuntimeStore();
  const endpoint = securitySetupUrl(connection);
  return {
    async save(code, password) {
      const host = runtime.getHosts().find((entry) => entry.serverId === serverId);
      if (
        !host ||
        !host.connections.some(
          (c) =>
            c.id === connection.id &&
            c.type === "directTcp" &&
            c.endpoint === connection.endpoint &&
            c.useTls === connection.useTls,
        )
      )
        throw new SecuritySetupError("host_mismatch");
      if (host.deviceCredential !== undefined)
        throw new SecuritySetupError("device_authentication_enabled");
      if (desktop) {
        const approval = await invokeDesktopCommand<{ code: string }>(
          "create_desktop_daemon_security_code",
          { serverId },
        );
        code = approval.code;
      }
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId, code, password }),
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
        credentials: "omit",
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        const failure = SecuritySetupFailureSchema.safeParse(result);
        throw new SecuritySetupError(failure.success ? failure.data.code : "request_failed");
      }
      if (
        typeof result !== "object" ||
        result === null ||
        !("restartRequired" in result) ||
        result.restartRequired !== true
      )
        throw new SecuritySetupError("request_failed");
    },
    async remember(password) {
      await runtime.saveSetupPassword(serverId, connection.id, password);
      if (runtime.getSnapshot(serverId)?.connectionStatus !== "online") {
        throw new SecuritySetupError("request_failed");
      }
    },
    async restart() {
      const startedAt = Date.now();
      if (desktop) await restartDesktopDaemon();
      else {
        const client = runtime.getClient(serverId);
        if (!client) throw new Error("Reconnect to the host before restarting.");
        await client.restartServer("settings");
      }
      while (Date.now() - startedAt < 30_000) {
        const snapshot = runtime.getSnapshot(serverId);
        if (
          snapshot?.connectionStatus === "online" &&
          snapshot.lastOnlineAt &&
          Date.parse(snapshot.lastOnlineAt) > startedAt &&
          useSessionStore.getState().sessions[serverId]?.serverInfo?.features
            ?.teamSupervisionAdmission === "available"
        )
          return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(
        "The host has not reconnected with security enabled. Check its connection and launcher before retrying.",
      );
    },
  };
}
