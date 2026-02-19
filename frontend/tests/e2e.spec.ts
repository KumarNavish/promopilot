import { expect, test } from "@playwright/test";

test("auto demo run shows visual AI policy learning and operational impact", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Counterfactual Policy AI" })).toBeVisible();
  await expect(page.getByText("Live build marker")).toHaveCount(0);
  await expect(page.getByText("UI version")).toHaveCount(0);
  await expect(page.getByTestId("controls")).toHaveCount(0);

  await expect(page.getByTestId("results-block")).toBeVisible();
  await expect(page.getByTestId("phase-strip")).toBeVisible();
  await expect(page.getByTestId("visual-key")).toBeVisible();
  await expect(page.getByTestId("decision-film")).toBeVisible();

  await page.waitForTimeout(900);
  await expect(page.getByTestId("phase-0")).toBeVisible();
  await expect(page.getByTestId("phase-1")).toBeVisible();
  await expect(page.getByTestId("phase-2")).toBeVisible();
  await expect(page.getByTestId("phase-3")).toBeVisible();

  await expect(page.getByTestId("replay-simulation")).toBeVisible();
  await page.getByTestId("replay-simulation").click();

  await expect(page.getByTestId("policy-line")).toContainText("Ship now:");
  await expect(page.getByTestId("kpi-changes")).toContainText("Wrong picks fixed");
  await expect(page.getByTestId("kpi-incidents")).toContainText("Incidents avoided / 10k");
  await expect(page.getByTestId("kpi-success")).toContainText("Success gain / 10k");
  await expect(page.getByTestId("apply-policy")).toBeVisible();
});
