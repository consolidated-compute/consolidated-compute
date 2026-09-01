import type { DaemonPermission, HubRelationshipStatus } from "@getpaseo/protocol/messages";

export type NormalizedHubRelationshipStatus = Omit<HubRelationshipStatus, "permissions"> & {
  permissions: DaemonPermission[];
};

export function normalizeHubRelationshipStatus(
  status: HubRelationshipStatus,
): NormalizedHubRelationshipStatus {
  // COMPAT(semanticHubPermissions): added in v0.7.0, remove after 2027-03-01 once the daemon floor is >= v0.7.0.
  const permissions =
    status.permissions ?? (status.scopes.includes("hub.execution.*") ? ["hub.execute"] : []);
  return { ...status, permissions };
}

export function normalizeHubRelationshipPayload<T extends { status: HubRelationshipStatus }>(
  payload: T,
): Omit<T, "status"> & { status: NormalizedHubRelationshipStatus } {
  return { ...payload, status: normalizeHubRelationshipStatus(payload.status) };
}
