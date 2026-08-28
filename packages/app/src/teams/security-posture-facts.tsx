import { type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { TeamSecurityPostureDto } from "@getpaseo/protocol/team/types";
import { StatusBadge } from "@/components/ui/status-badge";
import { buildTeamSecurityPostureRows } from "./security-posture";

export function TeamSecurityPostureFacts({
  posture,
  testIDPrefix,
}: {
  posture: TeamSecurityPostureDto;
  testIDPrefix: string;
}): ReactElement {
  const { t } = useTranslation();
  const rows = buildTeamSecurityPostureRows(posture);

  return (
    <View style={styles.container} testID={`${testIDPrefix}-facts`}>
      <Text style={styles.source}>
        {t("teams.runs.security.source", { provider: posture.source.provider })}
      </Text>
      {rows.map((row) => {
        const label = t(`teams.runs.security.dimensions.${row.dimension}`);
        const status = t(`teams.runs.security.status.${row.fact.status}`);
        return (
          <View
            key={row.dimension}
            accessible
            accessibilityLabel={`${label}. ${status}. ${row.fact.summary}`}
            style={styles.row}
            testID={`${testIDPrefix}-${row.dimension}-${row.fact.status}`}
          >
            <View style={styles.heading}>
              <Text style={styles.label}>{label}</Text>
              <StatusBadge label={status} variant={row.badgeVariant} />
            </View>
            <Text style={styles.summary}>{row.fact.summary}</Text>
          </View>
        );
      })}
    </View>
  );
}

export function TeamSecurityPostureNotice({
  kind,
  testID,
  message,
}: {
  kind: "legacy" | "update_required" | "pending" | "error";
  testID: string;
  message?: string;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <Text style={kind === "error" ? styles.error : styles.notice} testID={testID}>
      {message ?? t(`teams.runs.security.${kind}`)}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { gap: theme.spacing[3] },
  source: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  row: { gap: theme.spacing[2] },
  heading: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  label: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  summary: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, lineHeight: 20 },
  notice: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, lineHeight: 20 },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm, lineHeight: 20 },
}));
