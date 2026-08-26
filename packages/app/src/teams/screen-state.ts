import { teamKey } from "./data";

export type TeamsView = { kind: "list" } | { kind: "detail"; serverId: string; teamId: string };

export function resolveActiveTeamKey(
  view: TeamsView,
  selectedTeam: { key: string } | null,
): string | null {
  if (view.kind === "detail") return teamKey(view.serverId, view.teamId);
  return selectedTeam?.key ?? null;
}
