import { expect, test } from "@playwright/test";

test("auto demo run shows visual AI policy learning and operational impact", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("single-story")).toContainText("debias");
  await expect(page.getByText("Live build marker")).toHaveCount(0);
  await expect(page.getByText("UI version")).toHaveCount(0);
  await expect(page.getByTestId("controls")).toHaveCount(0);

  await expect(page.getByTestId("results-block")).toBeVisible();
  await expect(page.getByTestId("policy-strip")).toBeVisible();
  await expect(page.getByTestId("phase-strip")).toBeVisible();
  await expect(page.getByTestId("learning-board")).toBeVisible();
  await expect(page.getByTestId("legend")).toBeVisible();

  await expect(page.getByTestId("actions-chip")).toContainText("actions");
  await expect(page.getByTestId("changes-chip")).toContainText("changes");

  await page.waitForTimeout(900);
  await expect(page.getByTestId("phase-0")).toBeVisible();
  await expect(page.getByTestId("phase-1")).toBeVisible();
  await expect(page.getByTestId("phase-2")).toBeVisible();
  await expect(page.getByTestId("phase-3")).toBeVisible();

  await expect(page.getByTestId("replay-simulation")).toBeVisible();
  await page.getByTestId("replay-simulation").click();

  await expect(page.getByTestId("kpi-incidents")).toContainText("Incidents / week");
  await expect(page.getByTestId("kpi-oncall")).toContainText("On-call h / week");
  await expect(page.getByTestId("kpi-risk-cost")).toContainText("Risk cost / week");
  await expect(page.getByTestId("apply-policy")).toBeVisible();
});
