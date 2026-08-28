import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { toErrorMessage } from "@/utils/error-messages";
import type { TeamRunFormModel, TeamRunFormState } from "./run-form-model";

export function useTeamRunFormSecurityPreview(
  model: TeamRunFormModel,
  state: TeamRunFormState,
): void {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(state.serverId);
  const connected = useHostRuntimeIsConnected(state.serverId);
  const serverInfo = useSessionStore((store) => store.sessions[state.serverId]?.serverInfo ?? null);
  const request = state.securityPreviewRequest;
  const requestKey = request?.requestKey ?? null;

  useEffect(() => {
    if (!serverInfo) return;
    model.applySecurityPreviewCapability(serverInfo.features?.teamRunPreview === true);
  }, [model, serverInfo]);

  const query = useFetchQuery({
    queryKey: ["teamRunSecurityPreview", state.serverId, requestKey],
    dataShape: "value",
    staleTimeMs: 0,
    enabled: Boolean(client && connected && request),
    retry: false,
    queryFn: async () => {
      if (!client || !request) throw new Error(t("workspace.terminal.hostDisconnected"));
      const payload = await client.previewTeamRun(request.input);
      return payload.preview;
    },
  });

  useEffect(() => {
    if (!requestKey || !query.data) return;
    model.applySecurityPreview(requestKey, query.data);
  }, [model, query.data, requestKey]);

  useEffect(() => {
    if (!requestKey || !query.isError) return;
    model.applySecurityPreviewError(requestKey, toErrorMessage(query.error));
  }, [model, query.error, query.isError, requestKey]);
}
