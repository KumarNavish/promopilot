import { expect, test } from "@playwright/test";

test("policy generation and method divergence", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("generate-policy").click();

  await expect(page.getByTestId("results-block")).toBeVisible();
  await expect(page.getByTestId("recommendation-panel")).toBeVisible();
  await expect(page.getByTestId("recommendation-line")).toBeVisible();
  await expect(page.getByTestId("kpi-objective")).toBeVisible();
  await expect(page.getByTestId("kpi-discount")).toBeVisible();
  await expect(page.getByTestId("kpi-net-value")).toBeVisible();
  await expect(page.getByTestId("apply-policy")).toBeVisible();
});
