import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import type { OperationsHostFacts } from "./model";
import { shouldShowUnavailableHostsAlert, type OperationsAvailability } from "./screen-state";

type OperationsSurface = "operations" | "visual";

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

function providerSubagentIssueText(
  host: OperationsHostFacts,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  const state = host.providerSubagentActivity;
  if (state?.kind === "unsupported") {
    return t("operations.availability.providerSubagentsUnsupported", {
      host: host.serverName,
    });
  }
  if (state?.kind === "error") {
    return t(
      state.hasSnapshot
        ? "operations.availability.providerSubagentsLastKnown"
        : "operations.availability.providerSubagentsUnavailable",
      { host: host.serverName },
    );
  }
  return "";
}

function unavailableTestID(surface: OperationsSurface, areAllHostsUnavailable: boolean): string {
  if (surface === "visual") return "visual-partial-hosts";
  return areAllHostsUnavailable ? "operations-all-hosts-unavailable" : "operations-partial-hosts";
}

export function OperationsAvailabilityAlerts({
  availability,
  isRevalidating,
  didManualRefreshFail,
  surface,
}: {
  availability: OperationsAvailability;
  isRevalidating: boolean;
  didManualRefreshFail: boolean;
  surface: OperationsSurface;
}): ReactElement | null {
  const { t } = useTranslation();
  const showUpdating = isRevalidating || availability.isPartiallyLoading;
  const showUnavailable = shouldShowUnavailableHostsAlert(availability);
  const showProviderUnavailable = availability.providerSubagentIssueHosts.length > 0;
  if (!didManualRefreshFail && !showUpdating && !showUnavailable && !showProviderUnavailable) {
    return null;
  }

  return (
    <View style={styles.statusAlerts}>
      {didManualRefreshFail ? (
        <Alert
          variant="error"
          title={t(
            surface === "visual"
              ? "visual.availability.refreshFailed"
              : "operations.availability.refreshFailed",
          )}
          testID={`${surface}-refresh-failed`}
        />
      ) : null}
      {showUpdating ? (
        <Alert
          variant="info"
          title={t(
            surface === "visual"
              ? "visual.availability.updating"
              : "operations.availability.updating",
          )}
          testID={`${surface}-revalidating`}
        />
      ) : null}
      {showUnavailable ? (
        <Alert
          variant={availability.areAllHostsUnavailable ? "error" : "warning"}
          title={t(
            availability.areAllHostsUnavailable
              ? "operations.availability.allUnavailable"
              : "operations.availability.partial",
          )}
          description={availability.unavailableHosts
            .map((host) => hostIssueText(host, t))
            .join("\n")}
          testID={unavailableTestID(surface, availability.areAllHostsUnavailable)}
        />
      ) : null}
      {showProviderUnavailable ? (
        <Alert
          variant="warning"
          title={t("operations.availability.providerSubagentsPartial")}
          description={availability.providerSubagentIssueHosts
            .map((host) => providerSubagentIssueText(host, t))
            .join("\n")}
          testID={`${surface}-provider-subagents-partial`}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
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
}));
