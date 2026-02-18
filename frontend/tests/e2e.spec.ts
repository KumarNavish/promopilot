import { expect, test } from "@playwright/test";

test("auto demo run is interactive and usefulness-first", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("single-story")).toContainText("auto-runs on load");
  await expect(page.getByText("Live build marker")).toHaveCount(0);
  await expect(page.getByText("UI version")).toHaveCount(0);

  await expect(page.getByTestId("controls")).toBeVisible();
  await expect(page.getByTestId("results-block")).toBeVisible();

  const recommendationBefore = (await page.getByTestId("recommendation-line").textContent()) ?? "";

  await page.getByTestId("mode-throughput").click();
  await expect(page.getByTestId("results-block")).toBeVisible();
  await expect(page.getByTestId("recommendation-line")).not.toHaveText(recommendationBefore);

  await expect(page.getByTestId("weekly-slider")).toBeVisible();
  await expect(page.getByTestId("incident-cost-slider")).toBeVisible();
  await expect(page.getByTestId("kpi-incidents")).toBeVisible();
  await expect(page.getByTestId("kpi-risk-cost")).toBeVisible();
  await expect(page.getByTestId("apply-policy")).toBeVisible();
});
