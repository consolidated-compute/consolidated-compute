import { describe, expect, it } from "vitest";
import { forgeSearchItemToWorkItem, pluginAttachmentItemToWorkItem } from "./work-item";

describe("Assignment Work Item adapters", () => {
  it("captures only a bounded forge reference snapshot", () => {
    expect(
      forgeSearchItemToWorkItem({
        kind: "issue",
        forge: "github",
        number: 71,
        title: "Assignment surfaces",
        url: "https://github.com/owner/repo/issues/71",
        state: "OPEN",
        body: "must not be copied",
        labels: ["roadmap"],
        projectPath: "owner/repo",
      }),
    ).toEqual({
      sourceId: "github",
      sourceLabel: "GitHub",
      resourceType: "issue",
      resourceId: "owner/repo:issue:71",
      identifier: "#71",
      title: "Assignment surfaces",
      url: "https://github.com/owner/repo/issues/71",
    });
  });

  it("captures plugin resource identity without its text body", () => {
    expect(
      pluginAttachmentItemToWorkItem("linear", "issues", "Linear issues", {
        id: "ENG-12",
        identifier: "ENG-12",
        title: "Implement UI",
        subtitle: "Open",
        url: "https://linear.app/example/issue/ENG-12",
        text: "must not be copied",
        resourceType: "Project Issue",
      }),
    ).toEqual({
      sourceId: "plugin:linear:issues",
      sourceLabel: "Linear issues",
      resourceType: "project-issue",
      resourceId: "ENG-12",
      identifier: "ENG-12",
      title: "Implement UI",
      url: "https://linear.app/example/issue/ENG-12",
    });
  });
});
