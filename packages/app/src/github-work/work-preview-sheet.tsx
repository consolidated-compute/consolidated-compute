import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Linking, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { ExternalLink } from "lucide-react-native";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { toErrorMessage } from "@/utils/error-messages";
import {
  repositoryWorkToAssignmentReference,
  type Repository,
  type RepositoryWorkItem,
} from "./data";

const SNAP_POINTS = ["90%"];

interface WorkPreviewSheetProps {
  item: RepositoryWorkItem;
  repository: Repository;
  hostLabel: string;
  canCreate: boolean;
  onClose: () => void;
  onCreate: () => void;
}

export function WorkPreviewSheet({
  item,
  repository,
  hostLabel,
  canCreate,
  onClose,
  onCreate,
}: WorkPreviewSheetProps): ReactElement {
  const { t } = useTranslation();
  const header = useMemo(
    () => ({ title: `#${item.number} · ${repository.fullName}` }),
    [item.number, repository.fullName],
  );
  const [link, setLink] = useState<
    { kind: "idle" } | { kind: "pending" } | { kind: "error"; error: string }
  >({ kind: "idle" });
  const reference = useMemo(() => repositoryWorkToAssignmentReference(item), [item]);
  const openSource = useCallback(async () => {
    if (!reference || link.kind === "pending") return;
    setLink({ kind: "pending" });
    try {
      await Linking.openURL(reference.url);
      setLink({ kind: "idle" });
    } catch (error) {
      setLink({ kind: "error", error: toErrorMessage(error) });
    }
  }, [reference, link.kind]);
  const dismissError = useCallback(() => setLink({ kind: "idle" }), []);
  const footer = useMemo(
    () => (
      <View style={styles.actions}>
        <Button variant="secondary" onPress={onClose}>
          {t("common.actions.close")}
        </Button>
        {canCreate ? (
          <Button
            variant="default"
            onPress={onCreate}
            disabled={!reference}
            testID="github-work-create-assignment"
          >
            {t("assignments.actions.create")}
          </Button>
        ) : null}
      </View>
    ),
    [onClose, canCreate, onCreate, reference, t],
  );
  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      header={header}
      footer={footer}
      desktopMaxWidth={720}
      snapPoints={SNAP_POINTS}
      testID="github-work-preview"
    >
      <View style={styles.body}>
        <Text style={styles.title}>{item.title}</Text>
        <Text style={styles.meta}>
          {hostLabel} · GitHub · {repository.host}
        </Text>
        <Text style={styles.meta}>
          {item.state} · {item.labels.join(" · ")}
        </Text>
        <Text style={styles.meta} selectable>
          {item.url}
        </Text>
        <Button
          variant="outline"
          size="sm"
          leftIcon={ExternalLink}
          onPress={openSource}
          disabled={!reference || link.kind === "pending"}
          loading={link.kind === "pending"}
          testID="github-work-open-source"
        >
          {t("githubWork.openSource")}
        </Button>
        {link.kind === "error" ? (
          <Alert variant="error" title={t("githubWork.openFailed")} description={link.error}>
            <Button variant="outline" size="sm" onPress={openSource}>
              {t("common.actions.retry")}
            </Button>
            <Button variant="outline" size="sm" onPress={dismissError}>
              {t("common.actions.dismiss")}
            </Button>
          </Alert>
        ) : null}
        {!canCreate ? <Text style={styles.meta}>{t("githubWork.updateAssignments")}</Text> : null}
        {!reference ? <Alert variant="error" title={t("githubWork.invalidWorkItem")} /> : null}
        {item.bodyTruncated ? (
          <Text style={styles.meta}>{t("githubWork.bodyTruncated")}</Text>
        ) : null}
        <Text selectable style={styles.text} testID="github-work-body">
          {item.body || t("githubWork.noBody")}
        </Text>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[4] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.content },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
}));
