import type { ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AssignmentArtifactDto } from "@getpaseo/protocol/assignment/types";
import { MarkdownRenderer } from "@/components/markdown/renderer";

export function AssignmentArtifactCard({
  artifact,
  serverId,
}: {
  artifact: AssignmentArtifactDto;
  serverId: string;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View
      style={styles.card}
      testID={`assignment-artifact-${encodeURIComponent(serverId)}-${encodeURIComponent(artifact.assignmentId)}-${encodeURIComponent(artifact.id)}`}
    >
      <View style={styles.heading}>
        <View style={styles.titleBlock}>
          <Text style={styles.title}>{artifact.title}</Text>
          <Text style={styles.meta}>
            {artifact.kind} · {artifact.producer.roleId} · {artifact.producer.stepId}
          </Text>
        </View>
        <Text style={styles.meta}>
          {t("assignments.artifacts.bytes", {
            included: artifact.includedBytes,
            original: artifact.originalBytes,
          })}
          {` · ${t(
            artifact.truncated
              ? "assignments.artifacts.truncated"
              : "assignments.artifacts.complete",
          )}`}
        </Text>
      </View>
      <View style={styles.content}>
        <MarkdownRenderer text={artifact.content} compact />
      </View>
      <Text style={styles.provenance}>
        {t("assignments.artifacts.producer", {
          run: artifact.producer.teamRunId,
          agent: artifact.producer.agentId,
          revision: artifact.assignmentRevision,
        })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.spacing[3],
    padding: theme.spacing[4],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  heading: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  titleBlock: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  content: {
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
  },
  provenance: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm },
}));
