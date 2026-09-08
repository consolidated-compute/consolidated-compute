import { DaemonSetupPasswordSchema } from "@getpaseo/protocol/daemon-security";

export interface SecuritySetupPort {
  save(code: string, password: string): Promise<void>;
  remember(password: string): Promise<void>;
  restart(): Promise<void>;
}

export function openSecuritySetupForm(port: SecuritySetupPort, needsCode: boolean) {
  let state = {
    code: "",
    password: "",
    confirmation: "",
    stage: "editing" as "editing" | "saving" | "saved" | "restarting" | "ready",
    error: null as string | null,
    canSave: false,
    inputsLocked: false,
  };
  let daemonSaved = false;
  let closed = false;
  const listeners = new Set<() => void>();
  function publish() {
    state = {
      ...state,
      canSave:
        state.stage === "editing" &&
        (!needsCode || state.code.trim().length > 0) &&
        DaemonSetupPasswordSchema.safeParse(state.password).success &&
        state.password === state.confirmation,
    };
    if (!closed) for (const listener of listeners) listener();
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      closed = true;
      state = { ...state, password: "", confirmation: "", code: "", canSave: false };
      listeners.clear();
    },
    setCode(code: string) {
      if (!closed && state.stage === "editing" && !daemonSaved) {
        state = { ...state, code };
        publish();
      }
    },
    setPassword(password: string) {
      if (!closed && state.stage === "editing" && !daemonSaved) {
        state = { ...state, password };
        publish();
      }
    },
    setConfirmation(confirmation: string) {
      if (!closed && state.stage === "editing" && !daemonSaved) {
        state = { ...state, confirmation };
        publish();
      }
    },
    async save() {
      if (closed || !state.canSave) return;
      const { password, code } = state;
      state = { ...state, stage: "saving", error: null };
      publish();
      try {
        if (!daemonSaved) {
          await port.save(code.trim(), password);
          daemonSaved = true;
          if (!closed) state = { ...state, inputsLocked: true };
        }
        // Finish credential storage even if the operator closes the form after
        // the daemon save; do not lose the credential needed after restart.
        await port.remember(password);
        if (closed) return;
        state = { ...state, stage: "saved", password: "", confirmation: "", code: "" };
      } catch (error) {
        if (closed) return;
        state = {
          ...state,
          stage: "editing",
          error: error instanceof Error ? error.message : "Security setup failed.",
        };
      }
      publish();
    },
    async restart() {
      if (closed || state.stage !== "saved") return;
      state = { ...state, stage: "restarting", error: null };
      publish();
      try {
        await port.restart();
        if (closed) return;
        state = { ...state, stage: "ready" };
      } catch (error) {
        if (closed) return;
        state = {
          ...state,
          stage: "saved",
          error: error instanceof Error ? error.message : "Restart failed.",
        };
      }
      publish();
    },
  };
}
