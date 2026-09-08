import type { DirectTcpHostConnection } from "@/types/host-connection";

export function securitySetupUrl(connection: DirectTcpHostConnection): string {
  const url = new URL(`${connection.useTls ? "https" : "http"}://${connection.endpoint}`);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Invalid host endpoint.");
  }
  if (!connection.useTls && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Use HTTPS or a loopback connection for password setup.");
  }
  return new URL("/api/security/setup", url).href;
}
