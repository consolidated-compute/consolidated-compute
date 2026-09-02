import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { addConnectedHostAndReload, waitForConnectedHost } from "../support/helpers/hosts";
import { startSupervisedTeamSurfaceScenario } from "../support/helpers/supervised-team-scenario";
import { exerciseSupervisedTeamSurface } from "../support/helpers/supervised-team-ui";

test("resolves provider permission and a durable supervised checkpoint", async ({ page }) => {
  test.setTimeout(120_000);
  const scenario = await startSupervisedTeamSurfaceScenario({
    serverId: "srv_supervised_browser_surface",
  });

  try {
    await gotoAppShell(page);
    await addConnectedHostAndReload(page, {
      serverId: scenario.serverId,
      label: "Supervised browser host",
      password: scenario.password,
      port: scenario.port,
    });
    await expect(page.getByTestId("menu-button")).toBeVisible({ timeout: 30_000 });
    await waitForConnectedHost(page, {
      serverId: scenario.serverId,
      endpoint: `localhost:${scenario.port}`,
    });
    await exerciseSupervisedTeamSurface(page, scenario);
  } finally {
    await scenario.cleanup();
  }
});
