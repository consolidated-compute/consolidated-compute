import type { DirectTcpHostConnection } from "@/types/host-connection";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import { restartDesktopDaemon } from "@/desktop/daemon/desktop-daemon";
import type { SecuritySetupPort } from "./security-setup-model";
import { securitySetupUrl } from "./security-setup-endpoint";

export function createSecuritySetupPort(
  serverId: string,
  desktop: boolean,
  connection: DirectTcpHostConnection,
): SecuritySetupPort {
  const runtime = getHostRuntimeStore();
  const endpoint = securitySetupUrl(connection);
  return {
    async save(code, password) {
      if (desktop) {
        await invokeDesktopCommand("setup_desktop_daemon_security", { serverId, password });
      } else {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serverId, code, password }),
          signal: AbortSignal.timeout(15_000),
          redirect: "error",
          credentials: "omit",
        });
        const result: unknown = await response.json();
        if (!response.ok)
          throw new Error(
            typeof result === "object" &&
              result !== null &&
              "error" in result &&
              typeof result.error === "string"
              ? result.error
              : "Host security setup failed.",
          );
      }
    },
    async remember(password) {
      await runtime.upsertDirectConnection({
        serverId,
        endpoint: connection.endpoint,
        useTls: connection.useTls,
        password,
        awaitPersistence: true,
      });
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
