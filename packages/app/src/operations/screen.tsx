import { useIsFocused } from "@react-navigation/native";
import { RefreshCw } from "lucide-react-native";
import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { OperationsHostFacts, OperationsSummary } from "./model";
import { OperationsProjectRows } from "./rows";
import { resolveOperationsAvailability, type OperationsAvailability } from "./screen-state";
import { useOperationsData } from "./use-operations-data";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

export function OperationsScreen(): ReactElement {
  const isFocused = useIsFocused();
  if (!isFocused) return <View style={styles.container} />;
  return <OperationsScreenContent />;
}

function SummaryItem({ label, value, testID }: { label: string; value: number; testID: string }) {
  return (
    <View style={styles.summaryItem} testID={testID}>
      <Text style={styles.summaryValue}>{value}</Text>
      <Text style={styles.summaryLabel}>{label}</Text>
    </View>
  );
}

function Summary({ summary }: { summary: OperationsSummary }) {
  const { t } = useTranslation();
  return (
    <View
      style={styles.summary}
      accessibilityLabel={t("operations.summary.accessibility", {
        working: summary.working,
        attention: summary.attention,
        idle: summary.idle,
      })}
    >
      <SummaryItem
        label={t("operations.summary.working")}
        value={summary.working}
        testID="operations-summary-working"
      />
      <SummaryItem
        label={t("operations.summary.attention")}
        value={summary.attention}
        testID="operations-summary-attention"
      />
      <SummaryItem
        label={t("operations.summary.idle")}
        value={summary.idle}
        testID="operations-summary-idle"
      />
    </View>
  );
}

function hostIssueText(
  host: OperationsHostFacts,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (host.state.kind !== "offline" && host.state.kind !== "error") return "";
  if (host.state.kind === "error") {
    return t(
      host.state.hasLoadedDirectory
        ? "operations.availability.hostDataLastKnown"
        : "operations.availability.hostDataUnavailable",
      { host: host.serverName },
    );
  }
  if (host.state.hasLoadedDirectory) {
    return t("operations.availability.hostLastKnown", { host: host.serverName });
  }
  return t("operations.availability.hostUnavailable", { host: host.serverName });
}

function AvailabilityAlert({
  hosts,
  areAllHostsUnavailable,
}: {
  hosts: readonly OperationsHostFacts[];
  areAllHostsUnavailable: boolean;
}): ReactElement | null {
  const { t } = useTranslation();
  if (hosts.length === 0) return null;
  const description = hosts.map((host) => hostIssueText(host, t)).join("\n");
  return (
    <Alert
      variant={areAllHostsUnavailable ? "error" : "warning"}
      title={t(
        areAllHostsUnavailable
          ? "operations.availability.allUnavailable"
          : "operations.availability.partial",
      )}
      description={description}
      testID={
        areAllHostsUnavailable ? "operations-all-hosts-unavailable" : "operations-partial-hosts"
      }
    />
  );
}

function OperationsStatusAlerts({
  availability,
  isRevalidating,
  didManualRefreshFail,
}: {
  availability: OperationsAvailability;
  isRevalidating: boolean;
  didManualRefreshFail: boolean;
}): ReactElement | null {
  const { t } = useTranslation();
  const showUpdating = isRevalidating || availability.isPartiallyLoading;
  const showAvailability =
    availability.unavailableHosts.length > 0 && availability.body.kind !== "all_hosts_unavailable";
  if (!didManualRefreshFail && !showUpdating && !showAvailability) return null;

  return (
    <View style={styles.statusAlerts}>
      {didManualRefreshFail ? (
        <Alert
          variant="error"
          title={t("operations.availability.refreshFailed")}
          testID="operations-refresh-failed"
        />
      ) : null}
      {showUpdating ? (
        <Alert
          variant="info"
          title={t("operations.availability.updating")}
          testID="operations-revalidating"
        />
      ) : null}
      {showAvailability ? (
        <AvailabilityAlert
          hosts={availability.unavailableHosts}
          areAllHostsUnavailable={availability.areAllHostsUnavailable}
        />
      ) : null}
    </View>
  );
}

function OperationsScreenContent(): ReactElement {
  const { t } = useTranslation();
  const operations = useOperationsData();
  const availability = useMemo(() => resolveOperationsAvailability(operations), [operations]);
  const [isManualRefresh, setIsManualRefresh] = useState(false);
  const [didManualRefreshFail, setDidManualRefreshFail] = useState(false);
  const isRefreshing = isManualRefresh || operations.isRevalidating;
  const refresh = useCallback(() => {
    setDidManualRefreshFail(false);
    setIsManualRefresh(true);
    void operations
      .refreshAll()
      .catch(() => setDidManualRefreshFail(true))
      .finally(() => setIsManualRefresh(false));
  }, [operations]);
  const headerAction = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={RefreshCw}
        onPress={refresh}
        loading={isRefreshing}
        testID="operations-refresh"
      >
        {t("operations.actions.refresh")}
      </Button>
    ),
    [isRefreshing, refresh, t],
  );

  let body: ReactElement;
  if (availability.body.kind === "initial_loading") {
    body = (
      <View style={styles.centered} testID="operations-initial-loading">
        <ThemedLoadingSpinner size="large" />
      </View>
    );
  } else if (availability.body.kind === "all_hosts_unavailable") {
    body = (
      <View style={styles.centered} testID="operations-unavailable-empty">
        <Text style={styles.emptyTitle}>{t("operations.availability.allUnavailable")}</Text>
        <Text style={styles.emptyText}>{t("operations.availability.noData")}</Text>
        <Button variant="ghost" onPress={refresh} loading={isRefreshing}>
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  } else if (availability.body.kind === "empty") {
    body = (
      <View style={styles.centered} testID="operations-empty">
        <Text style={styles.emptyTitle}>{t("operations.empty")}</Text>
        <Text style={styles.emptyText}>{t("operations.emptyDescription")}</Text>
      </View>
    );
  } else {
    body = (
      <ScrollView
        style={styles.scroll}
        showsVerticalScrollIndicator={false}
        testID="operations-list"
      >
        <View style={styles.content}>
          <Summary summary={operations.summary} />
          <View style={styles.projects}>
            {operations.projects.map((project) => (
              <OperationsProjectRows key={project.key} project={project} />
            ))}
          </View>
        </View>
      </ScrollView>
    );
  }

  return (
    <View style={styles.container} testID="operations-screen">
      <MenuHeader title={t("operations.title")} rightContent={headerAction} />
      <OperationsStatusAlerts
        availability={availability}
        isRevalidating={operations.isRevalidating}
        didManualRefreshFail={didManualRefreshFail}
      />
      {body}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  content: {
    width: "100%",
    maxWidth: 960,
    alignSelf: "center",
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[6],
    },
    paddingVertical: theme.spacing[4],
    gap: theme.spacing[4],
  },
  statusAlerts: {
    width: "100%",
    maxWidth: 960,
    alignSelf: "center",
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[6],
    },
    paddingTop: theme.spacing[4],
    gap: theme.spacing[3],
  },
  summary: {
    flexDirection: "row",
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    overflow: "hidden",
  },
  summaryItem: {
    flex: 1,
    minHeight: 72,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[3],
  },
  summaryValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.normal,
  },
  summaryLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  projects: {
    gap: theme.spacing[6],
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[6],
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.normal,
    textAlign: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
