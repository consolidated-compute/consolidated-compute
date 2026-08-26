import { describe, expect, it } from "vitest";
import { resolveActiveTeamKey } from "./screen-state";

describe("Teams screen state", () => {
  it("retains a routed Team identity after its cache entry is deleted", () => {
    expect(
      resolveActiveTeamKey({ kind: "detail", serverId: "host-a", teamId: "team-a" }, null),
    ).toBe("host-a:team-a");
  });

  it("tracks a newly selected Team while an earlier deletion is pending", () => {
    expect(
      resolveActiveTeamKey(
        { kind: "detail", serverId: "host-a", teamId: "team-b" },
        { key: "host-a:team-b" },
      ),
    ).toBe("host-a:team-b");
  });

  it("uses the selected Team on the desktop list route", () => {
    expect(resolveActiveTeamKey({ kind: "list" }, { key: "host-a:team-a" })).toBe("host-a:team-a");
  });
});
