import { expect, test } from "@playwright/test";

test("interactive run produces decision and practical value", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("single-story")).toBeVisible();
  await expect(page.getByTestId("version-chip")).toContainText("interactive-v2");
  await expect(page.getByTestId("empty-state")).toContainText("click Run");

  await page.getByTestId("generate-policy").click();

  await expect(page.getByTestId("results-block")).toBeVisible();
  await expect(page.getByTestId("recommendation-line")).toContainText("Decision:");
  await expect(page.getByTestId("policy-line")).toContainText("Policy to ship:");
  await expect(page.getByTestId("utility-card")).toBeVisible();
  await expect(page.getByTestId("no-ai-line")).toContainText("Without AI optimization");
  await expect(page.getByTestId("next-action-line")).toContainText("Next action:");
  await expect(page.getByTestId("kpi-objective")).toBeVisible();
  await expect(page.getByTestId("kpi-incident")).toBeVisible();
  await expect(page.getByTestId("kpi-latency")).toBeVisible();
  await expect(page.getByTestId("apply-policy")).toBeVisible();
});
