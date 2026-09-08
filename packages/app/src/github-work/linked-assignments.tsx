import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AssignmentDto } from "@getpaseo/protocol/assignment/types";
import { useAssignmentList } from "@/assignments/use-assignments";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { SettingsSection } from "@/screens/settings/settings-section";
import { assignmentReferencesRepositoryWork, type RepositoryWorkItem } from "./data";

interface LinkedAssignmentsProps {
  serverId: string;
  hostLabel: string;
  item: RepositoryWorkItem;
  onOpen: (serverId: string, assignment: AssignmentDto) => void;
}

export function LinkedAssignments({ serverId, hostLabel, item, onOpen }: LinkedAssignmentsProps) {
  const { t } = useTranslation();
  const query = useAssignmentList(serverId);
  const assignments = (query.data?.assignments ?? []).filter((assignment) =>
    assignmentReferencesRepositoryWork(assignment.workItem, item),
  );
  const issues = query.data?.issues ?? [];
  const empty = query.isSuccess && issues.length === 0 && assignments.length === 0;
  const { refetch, isFetching } = query;
  const refresh = useCallback(() => void refetch(), [refetch]);
  const refreshButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        onPress={refresh}
        loading={isFetching}
        disabled={isFetching}
      >
        {t("githubWork.refresh")}
      </Button>
    ),
    [refresh, isFetching, t],
  );
  return (
    <SettingsSection
      title={t("githubWork.linkedAssignments")}
      testID="github-work-linked-assignments"
      flush
      trailing={refreshButton}
    >
      {query.isLoading ? <LoadingSpinner color={styles.meta.color} /> : null}
      {query.isError ? (
        <Alert
          variant="error"
          title={t("assignments.errors.load")}
          description={query.error.message}
        >
          <Button
            variant="outline"
            size="sm"
            onPress={refresh}
            loading={isFetching}
            disabled={isFetching}
          >
            {t("common.actions.retry")}
          </Button>
        </Alert>
      ) : null}
      {issues.map((issue) => (
        <Alert
          key={issue.fileName}
          variant="warning"
          title={issue.fileName}
          description={issue.message}
        />
      ))}
      {empty ? <Text style={styles.meta}>{t("githubWork.noLinkedAssignments")}</Text> : null}
      {assignments.map((assignment) => (
        <LinkedAssignmentRow
          key={assignment.id}
          assignment={assignment}
          serverId={serverId}
          hostLabel={hostLabel}
          onOpen={onOpen}
        />
      ))}
    </SettingsSection>
  );
}

function LinkedAssignmentRow({
  assignment,
  serverId,
  hostLabel,
  onOpen,
}: Omit<LinkedAssignmentsProps, "item"> & { assignment: AssignmentDto }) {
  const { t } = useTranslation();
  const open = useCallback(() => onOpen(serverId, assignment), [onOpen, serverId, assignment]);
  return (
    <View style={styles.assignment} testID={`github-work-assignment-${assignment.id}`}>
      <View style={styles.identity}>
        <Text style={styles.title}>{assignment.title}</Text>
        <Text style={styles.meta} selectable numberOfLines={1}>
          {assignment.id}
        </Text>
      </View>
      <StatusBadge label={t(`assignments.status.${assignment.state.status}`)} />
      <Button
        variant="outline"
        size="sm"
        accessibilityLabel={t("assignments.openAssignment", {
          title: assignment.title,
          host: hostLabel,
        })}
        onPress={open}
      >
        {t("githubWork.openAssignment")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  assignment: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  identity: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
