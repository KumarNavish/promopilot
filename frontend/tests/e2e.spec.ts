import { expect, test } from "@playwright/test";

test("auto-demo renders recommendation and practical KPI impact", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("single-story")).toContainText("automatically corrects bias");
  await expect(page.getByTestId("version-chip")).toContainText("value-v4");

  await expect(page.getByTestId("results-block")).toBeVisible();
  await expect(page.getByTestId("before-after-strip")).toBeVisible();
  await expect(page.getByTestId("naive-policy")).toBeVisible();
  await expect(page.getByTestId("dr-policy")).toBeVisible();
  await expect(page.getByTestId("strip-delta")).toContainText("Weekly risk-cost delta");
  await expect(page.getByTestId("recommendation-line")).toContainText("expected");
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
