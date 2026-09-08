import type { HostConnection, HostProfile } from "./host-connection";

export class HostDeviceCredentialError extends Error {
  constructor(readonly code: "invalid_credential" | "host_not_found") {
    super(`Unable to save device credential: ${code}`);
    this.name = "HostDeviceCredentialError";
  }
}

export function resolveHostAuthentication(
  host: Pick<HostProfile, "deviceCredential">,
  connection: HostConnection,
): { deviceCredential: string } | { password: string } | Record<string, never> {
  // Presence selects device authentication even for a damaged credential: the SDK must
  // reject it, not fall back to a saved password or an anonymous connection.
  if (host.deviceCredential !== undefined) return { deviceCredential: host.deviceCredential };
  if (connection.type === "directTcp" && connection.password) {
    return { password: connection.password };
  }
  if (connection.type === "remoteSsh" && connection.daemonPassword) {
    return { password: connection.daemonPassword };
  }
  return {};
}
