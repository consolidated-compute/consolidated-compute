import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useSessionStore } from "@/stores/session-store";
import { useHosts, useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import { useLocalDaemonServerIdState } from "@/hooks/use-is-local-daemon";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { settingsStyles } from "@/styles/settings";
import { SettingsSection } from "@/screens/settings/settings-section";
import { useIsCompactFormFactor } from "@/constants/layout";
import { confirmDialog } from "@/utils/confirm-dialog";
import { openSecuritySetupForm, type SecuritySetupPort } from "./security-setup-model";
import { createSecuritySetupPort } from "./security-setup-port";
import { securitySetupUrl } from "./security-setup-endpoint";

export function HostSecuritySetup({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const features = useSessionStore((s) => s.sessions[serverId]?.serverInfo?.features);
  const host = useHosts().find((h) => h.serverId === serverId);
  const snapshot = useHostRuntimeSnapshot(serverId);
  const local = useLocalDaemonServerIdState();
  const [port, setPort] = useState<SecuritySetupPort | null>(null);
  const [error, setError] = useState<string | null>(null);
  const desktop = local.status === "resolved" && local.serverId === serverId;
  const connection = host?.connections.find((c) => c.id === snapshot?.activeConnectionId);
  const open = useCallback(() => {
    if (connection?.type !== "directTcp") return;
    try {
      securitySetupUrl(connection);
      setPort(createSecuritySetupPort(serverId, desktop, connection));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Setup unavailable.");
    }
  }, [connection, desktop, serverId]);
  if (port)
    return (
      <SecuritySetupForm
        key={serverId}
        port={port}
        needsCode={local.status !== "resolved" || local.serverId !== serverId}
      />
    );
  if (features?.teamSupervisionAdmission === "available") return null;
  if (!features?.teamSupervision) return null;
  const supported =
    features.daemonSecuritySetup === true &&
    features.teamSupervisionAdmission === "authentication_required" &&
    local.status === "resolved" &&
    connection?.type === "directTcp";
  return (
    <SecuritySetupCard>
      <Text style={settingsStyles.rowHint}>
        {t(
          features.teamSupervisionAdmission === "environment_password_unsupported"
            ? "hostSecurity.environment"
            : "hostSecurity.required",
        )}
      </Text>
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
      {supported ? (
        <Button
          testID="host-security-open"
          onPress={open}
          variant="outline"
          size="sm"
          style={styles.action}
        >
          {t("hostSecurity.setup")}
        </Button>
      ) : (
        <Text style={settingsStyles.rowHint}>{t("hostSecurity.unsupported")}</Text>
      )}
    </SecuritySetupCard>
  );
}

function SecuritySetupForm({ port, needsCode }: { port: SecuritySetupPort; needsCode: boolean }) {
  const { t } = useTranslation();
  const [model] = useState(() => openSecuritySetupForm(port, needsCode));
  useEffect(() => () => model.close(), [model]);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const busy = state.stage === "saving" || state.stage === "restarting";
  const restart = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t("hostSecurity.restart"),
      message: t("hostSecurity.restartWarning"),
      confirmLabel: t("hostSecurity.restart"),
      cancelLabel: t("common.actions.cancel"),
      destructive: true,
    });
    if (confirmed) await model.restart();
  }, [model, t]);
  return (
    <SecuritySetupCard testID="host-security-form">
      {state.stage === "editing" || state.stage === "saving" ? (
        <>
          {needsCode ? (
            <>
              <Text style={settingsStyles.rowHint}>{t("hostSecurity.codeHelp")}</Text>
              <Text selectable>npm run cli -- daemon setup-code</Text>
              <Field label={t("hostSecurity.code")}>
                <FormTextInput
                  initialValue=""
                  onChangeText={model.setCode}
                  editable={!busy && !state.inputsLocked}
                  size={size}
                  autoCapitalize="none"
                  testID="host-security-code"
                />
              </Field>
            </>
          ) : null}
          <Text style={settingsStyles.rowHint}>{t("hostSecurity.passwordHelp")}</Text>
          <Field label={t("hostSecurity.password")}>
            <FormTextInput
              initialValue=""
              onChangeText={model.setPassword}
              secureTextEntry
              editable={!busy && !state.inputsLocked}
              size={size}
              testID="host-security-password"
            />
          </Field>
          <Field label={t("hostSecurity.confirm")}>
            <FormTextInput
              initialValue=""
              onChangeText={model.setConfirmation}
              secureTextEntry
              editable={!busy && !state.inputsLocked}
              size={size}
              testID="host-security-confirm"
            />
          </Field>
          <Button
            testID="host-security-save"
            disabled={!state.canSave || busy}
            loading={busy}
            onPress={model.save}
            size={size}
            style={styles.action}
          >
            {t("hostSecurity.save")}
          </Button>
        </>
      ) : null}
      {state.stage === "ready" ? <Text>{t("hostSecurity.ready")}</Text> : null}
      {state.stage === "saved" || state.stage === "restarting" ? (
        <>
          <Text style={settingsStyles.rowHint}>{t("hostSecurity.saved")}</Text>
          <Button
            testID="host-security-restart"
            disabled={busy}
            loading={busy}
            onPress={restart}
            variant="outline"
            size={size}
            style={styles.action}
          >
            {t("hostSecurity.restart")}
          </Button>
        </>
      ) : null}
      {state.error ? (
        <Text accessibilityRole="alert" testID="host-security-error">
          {state.error}
        </Text>
      ) : null}
    </SecuritySetupCard>
  );
}

function SecuritySetupCard({ children, testID }: { children: ReactNode; testID?: string }) {
  const { t } = useTranslation();
  return (
    <SettingsSection title={t("hostSecurity.title")} testID={testID}>
      <View style={settingsStyles.card}>
        <View style={styles.content}>{children}</View>
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { padding: theme.spacing[4], gap: theme.spacing[3] },
  action: { alignSelf: "flex-start" },
}));
