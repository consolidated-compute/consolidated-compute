import type { ReactElement } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import type { TeamRunSupervisionSummaryDto } from "@getpaseo/protocol/team/types";
import { StatusBadge } from "@/components/ui/status-badge";
import { teamRunSupervisionPresentation } from "./supervision-data";

export function TeamRunSupervisionBadge({
  summary,
}: {
  summary: TeamRunSupervisionSummaryDto;
}): ReactElement {
  const { t } = useTranslation();
  const presentation = teamRunSupervisionPresentation(summary);
  const label = presentation.labelKey ? t(presentation.labelKey) : presentation.fallbackLabel;
  return (
    <View
      testID={`team-run-supervision-badge-${summary.pendingHumanRequest ? "review" : "status"}`}
    >
      <StatusBadge label={label} variant={presentation.variant} />
    </View>
  );
}
