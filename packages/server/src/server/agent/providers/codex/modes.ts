export const DEFAULT_CODEX_MODE_ID = "auto";

export interface CodexModePreset {
  approvalPolicy: "untrusted" | "on-request" | "never";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  approvalsReviewer?: "auto_review";
}

export const CODEX_MODE_PRESETS: Record<string, CodexModePreset> = {
  "read-only": {
    approvalPolicy: "on-request",
    sandbox: "read-only",
  },
  auto: {
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  },
  "auto-review": {
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    approvalsReviewer: "auto_review",
  },
  "full-access": {
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  },
};
