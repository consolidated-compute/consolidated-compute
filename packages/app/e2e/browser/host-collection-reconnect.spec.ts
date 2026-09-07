import { expect, test } from "../support/fixtures";
import { connectAssignmentsClient } from "../support/helpers/assignments";
import { getServerId } from "../support/helpers/server-id";

test("cold Assignment links and reloads follow the host from connecting to online", async ({
  page,
}) => {
  const client = await connectAssignmentsClient();
  try {
    const { assignment } = await client.createAssignment({
      title: "Cold-start Assignment",
      objective: "Read this Assignment without first opening a Workspace.",
      workItem: null,
    });
    await page.goto(`/assignments/${getServerId()}/${assignment.id}`);
    const detail = page.getByTestId(`assignment-detail-${getServerId()}-${assignment.id}`);
    await expect(detail).toBeVisible({ timeout: 30_000 });
    await expect(detail).toContainText(assignment.objective);
    await expect(page.getByTestId("assignments-new")).toBeEnabled();
    await page.reload();
    await expect(detail).toBeVisible({ timeout: 30_000 });
    await expect(detail).toContainText(assignment.objective);
    await expect(page.getByTestId("assignments-new")).toBeEnabled();
  } finally {
    await client.close();
  }
});
