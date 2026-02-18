import { expect, test } from "@playwright/test";

test("auto-demo renders recommendation and practical KPI impact", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("single-story")).toContainText("automatically corrects bias");
  await expect(page.getByTestId("version-chip")).toContainText("value-v3");

  await expect(page.getByTestId("results-block")).toBeVisible();
  await expect(page.getByTestId("recommendation-line")).toContainText("versus naive");
  await expect(page.getByTestId("kpi-success")).toBeVisible();
  await expect(page.getByTestId("kpi-incidents")).toBeVisible();
  await expect(page.getByTestId("kpi-risk-cost")).toBeVisible();
  await expect(page.getByTestId("apply-policy")).toBeVisible();

  await page.getByTestId("weekly-requests").fill("7000000");
  await page.getByTestId("incident-cost").fill("3000");
  await page.getByTestId("recalculate-impact").click();

  await expect(page.getByTestId("results-block")).toBeVisible();
  await expect(page.getByTestId("kpi-risk-cost")).toContainText("$");
});
