import { expect, test } from "@playwright/test";

test("auto demo run shows visual AI policy learning and operational impact", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Counterfactual Policy AI" })).toBeVisible();
  await expect(page.getByText("Live build marker")).toHaveCount(0);
  await expect(page.getByText("UI version")).toHaveCount(0);
  await expect(page.getByTestId("controls")).toHaveCount(0);

  await expect(page.getByTestId("results-block")).toBeVisible();
  await expect(page.getByTestId("hero-story")).toContainText("AI corrected");
  await expect(page.getByTestId("spotlight")).toBeVisible();
  await expect(page.getByTestId("lane-observed")).toBeVisible();
  await expect(page.getByTestId("lane-corrected")).toBeVisible();
  await expect(page.getByTestId("segment-tabs")).toBeVisible();
  await expect(page.getByTestId("segment-tab-0")).toBeVisible();

  await page.waitForTimeout(900);
  await expect(page.getByTestId("spotlight-step")).toBeVisible();
  await page.getByTestId("segment-tab-1").click();
  await expect(page.getByTestId("spotlight-step")).toContainText("2/");
  await page.getByTestId("auto-tour").click();

  await expect(page.getByTestId("replay-simulation")).toBeVisible();
  await page.getByTestId("replay-simulation").click();

  await expect(page.getByTestId("policy-line")).toContainText("Ship now:");
  await expect(page.getByTestId("kpi-changes")).toContainText("Policies corrected");
  await expect(page.getByTestId("kpi-incidents")).toContainText("Incidents avoided / 10k");
  await expect(page.getByTestId("kpi-success")).toContainText("Success gain / 10k");
  await expect(page.getByTestId("apply-policy")).toBeVisible();
});
