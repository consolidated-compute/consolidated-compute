import { describe, expect, it } from "vitest";
import { buildTeamSecurityPostureRows } from "./security-posture";

describe("buildTeamSecurityPostureRows", () => {
  it("maps every frozen posture fact to its semantic badge", () => {
    expect(
      buildTeamSecurityPostureRows({
        source: { provider: "codex" },
        filesystemWrite: { status: "enforced", summary: "Filesystem evidence" },
        networkAccess: { status: "policy_only", summary: "Network evidence" },
        toolShell: { status: "unavailable", summary: "Tool evidence" },
      }),
    ).toEqual([
      {
        dimension: "filesystemWrite",
        fact: { status: "enforced", summary: "Filesystem evidence" },
        badgeVariant: "success",
      },
      {
        dimension: "networkAccess",
        fact: { status: "policy_only", summary: "Network evidence" },
        badgeVariant: "warning",
      },
      {
        dimension: "toolShell",
        fact: { status: "unavailable", summary: "Tool evidence" },
        badgeVariant: "muted",
      },
    ]);
  });
});
