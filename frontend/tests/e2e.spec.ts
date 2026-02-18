import { expect, test } from "@playwright/test";

test("auto-demo runs on load and shows minimal actionable output", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("single-story")).toBeVisible();
  await expect(page.getByTestId("single-story")).toContainText("automatically compare naive vs bias-adjusted");

  await expect(page.getByTestId("results-block")).toBeVisible();
  await expect(page.getByTestId("recommendation-line")).toBeVisible();
  await expect(page.getByTestId("recommendation-line")).toContainText("Decision:");
  await expect(page.getByTestId("policy-line")).toContainText("Policy to ship:");
  await expect(page.getByTestId("kpi-objective")).toBeVisible();
  await expect(page.getByTestId("kpi-incident")).toBeVisible();
  await expect(page.getByTestId("kpi-latency")).toBeVisible();
  await expect(page.getByTestId("apply-policy")).toBeVisible();
});
