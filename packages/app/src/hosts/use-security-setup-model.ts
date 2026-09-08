import { useEffect, useState, useSyncExternalStore } from "react";
import { openSecuritySetupForm, type SecuritySetupPort } from "./security-setup-model";

export function useSecuritySetupModel(port: SecuritySetupPort, needsCode: boolean) {
  const [model] = useState(() => openSecuritySetupForm(port, needsCode));
  useEffect(() => () => model.close(), [model]);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  return { model, state };
}
