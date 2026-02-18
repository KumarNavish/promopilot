import { expect, test } from "@playwright/test";

test("auto AI run shows pipeline, recommendation, and export action", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("single-story")).toContainText("doubly-robust counterfactual simulation");
  await expect(page.getByTestId("version-chip")).toContainText("value-v5");

  await expect(page.getByTestId("run-panel")).toBeVisible();
  await expect(page.getByTestId("run-step-0")).toBeVisible();
  await expect(page.getByTestId("run-step-3")).toBeVisible();

  await expect(page.getByTestId("results-block")).toBeVisible();
  await expect(page.getByTestId("recommendation-line")).toContainText("AI recommendation");
  await expect(page.getByTestId("evidence-line")).toContainText("Counterfactual engine evaluated");
  await expect(page.getByTestId("kpi-success")).toBeVisible();
  await expect(page.getByTestId("kpi-incidents")).toBeVisible();
  await expect(page.getByTestId("kpi-risk-cost")).toBeVisible();
  await expect(page.getByTestId("apply-policy")).toBeVisible();
});
