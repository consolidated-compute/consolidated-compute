import { useCallback, useMemo, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { ChevronRight, Users } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AggregatedTeam } from "@/teams/data";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";

export function AssignmentTeamPickerSheet({
  teams,
  onClose,
  onSelect,
}: {
  teams: AggregatedTeam[];
  onClose: () => void;
  onSelect: (team: AggregatedTeam) => void;
}): ReactElement {
  const { t } = useTranslation();
  const header = useMemo<SheetHeader>(() => ({ title: t("assignments.runs.selectTeam") }), [t]);
  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      header={header}
      desktopMaxWidth={560}
      snapPoints={["70%"]}
      testID="assignment-team-picker"
    >
      <View style={styles.body}>
        {teams.map((team) => (
          <TeamRow key={team.key} team={team} onSelect={onSelect} />
        ))}
        {teams.length === 0 ? (
          <View style={styles.empty}>
            <Users size={28} color={styles.icon.color} />
            <Text style={styles.emptyText}>{t("assignments.runs.noTeams")}</Text>
          </View>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

function TeamRow({
  team,
  onSelect,
}: {
  team: AggregatedTeam;
  onSelect: (team: AggregatedTeam) => void;
}): ReactElement {
  const { t } = useTranslation();
  const press = useCallback(() => onSelect(team), [onSelect, team]);
  const style = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      (pressed || hovered) && styles.rowHovered,
    ],
    [],
  );
  return (
    <Pressable
      onPress={press}
      style={style}
      accessibilityRole="button"
      accessibilityLabel={t("assignments.runs.chooseTeam", { name: team.name })}
      testID={`assignment-team-${encodeURIComponent(team.serverId)}-${encodeURIComponent(team.id)}`}
    >
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{team.name}</Text>
        <Text style={styles.rowMeta}>
          {t("teams.roleStepCount", { roles: team.roles.length, steps: team.workflow.length })}
        </Text>
      </View>
      <ChevronRight size={16} color={styles.icon.color} />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { padding: theme.spacing[4], gap: theme.spacing[2] },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  rowHovered: { backgroundColor: theme.colors.surface2 },
  rowText: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  rowTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  rowMeta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  icon: { color: theme.colors.foregroundExtraMuted },
  empty: {
    minHeight: 180,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
  },
  emptyText: { color: theme.colors.foregroundMuted, textAlign: "center" },
}));
