import { expect, test } from "@playwright/test";

test("policy generation and method divergence", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("generate-policy").click();

  await expect(page.getByTestId("results-block")).toBeVisible();
  await expect(page.getByTestId("recommendation-panel")).toBeVisible();
  await expect(page.getByTestId("shift-panel")).toBeVisible();

  await page.getByTestId("toggle-diagnostics").click();
  await expect(page.getByTestId("before-after-strip")).toBeVisible();
  await expect(page.getByTestId("policy-card-naive")).toBeVisible();
  await expect(page.getByTestId("policy-card-dr")).toBeVisible();

  const naiveDiscount = await page.getByTestId("naive-discount-0").innerText();
  const drDiscount = await page.getByTestId("dr-discount-0").innerText();
  expect(naiveDiscount).not.toEqual(drDiscount);

  await page.getByTestId("toggle-naive").click();
  await expect(page.getByTestId("dose-response-chart")).toBeVisible();
  await page.getByTestId("toggle-dr").click();
  await expect(page.getByTestId("dose-response-chart")).toBeVisible();
});
