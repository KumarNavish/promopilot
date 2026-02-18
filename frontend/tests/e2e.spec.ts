import { expect, test } from "@playwright/test";

test("policy generation renders minimal decision UI", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("generate-policy").click();

  await expect(page.getByTestId("results-block")).toBeVisible();
  await expect(page.getByTestId("recommendation-line")).toBeVisible();
  await expect(page.getByTestId("kpi-objective")).toBeVisible();
  await expect(page.getByTestId("kpi-incident")).toBeVisible();
  await expect(page.getByTestId("kpi-latency")).toBeVisible();
  await expect(page.getByTestId("result-footnote")).toBeVisible();
  await expect(page.getByTestId("apply-policy")).toBeVisible();

  const recommendation = await page.getByTestId("recommendation-line").innerText();
  expect(recommendation.length).toBeGreaterThan(20);
});
