import type { TeamSecurityFactDto, TeamSecurityPostureDto } from "@getpaseo/protocol/team/types";
import type { StatusBadgeVariant } from "@/components/ui/status-badge";

export type TeamSecurityPostureDimension = "filesystemWrite" | "networkAccess" | "toolShell";

export interface TeamSecurityPostureRow {
  dimension: TeamSecurityPostureDimension;
  fact: TeamSecurityFactDto;
  badgeVariant: StatusBadgeVariant;
}

const DIMENSIONS: readonly TeamSecurityPostureDimension[] = [
  "filesystemWrite",
  "networkAccess",
  "toolShell",
];

function badgeVariant(status: TeamSecurityFactDto["status"]): StatusBadgeVariant {
  if (status === "enforced") return "success";
  if (status === "policy_only") return "warning";
  return "muted";
}

export function buildTeamSecurityPostureRows(
  posture: TeamSecurityPostureDto,
): TeamSecurityPostureRow[] {
  return DIMENSIONS.map((dimension) => ({
    dimension,
    fact: posture[dimension],
    badgeVariant: badgeVariant(posture[dimension].status),
  }));
}
