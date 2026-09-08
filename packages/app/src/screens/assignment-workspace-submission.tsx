import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";

export function AssignmentWorkspaceSubmission({
  assignmentId,
  isPending,
  clientReady,
  sourceDirectory,
  serverId,
  selectedServerId,
  onReturn,
  onCreate,
  children,
}: {
  assignmentId?: string;
  isPending: boolean;
  clientReady: boolean;
  sourceDirectory: string | null;
  serverId: string;
  selectedServerId: string;
  onReturn: () => void;
  onCreate: () => Promise<void>;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  if (!assignmentId) return children;
  return (
    <View style={styles.actions}>
      <Button variant="secondary" onPress={onReturn} disabled={isPending}>
        {t("assignments.actions.backToAssignment")}
      </Button>
      <Button
        variant="default"
        onPress={onCreate}
        disabled={isPending || !clientReady || !sourceDirectory || selectedServerId !== serverId}
        loading={isPending}
        testID="assignment-workspace-create"
      >
        {t("assignments.actions.createWorkspace")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[6],
    paddingBottom: theme.spacing[6],
  },
}));
