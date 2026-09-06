import { router, usePathname, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import { useCallback } from "react";
import { GitPullRequest } from "lucide-react-native";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { buildGitHubWorkRoute } from "@/utils/host-routes";

export function GitHubWorkSidebarItem({ onBeforeNavigate }: { onBeforeNavigate?: () => void }) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const navigate = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildGitHubWorkRoute() as Href);
  }, [onBeforeNavigate]);
  return (
    <SidebarHeaderRow
      icon={GitPullRequest}
      label={t("githubWork.title")}
      onPress={navigate}
      isActive={pathname === buildGitHubWorkRoute()}
      testID="sidebar-github-work"
      variant="compact"
    />
  );
}
