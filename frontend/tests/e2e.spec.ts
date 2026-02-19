import { expect, test } from "@playwright/test";

test("auto demo run communicates problem-to-solution through animated visuals", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Counterfactual Policy AI" })).toBeVisible();
  await expect(page.getByText("Live build marker")).toHaveCount(0);
  await expect(page.getByText("UI version")).toHaveCount(0);
  await expect(page.getByTestId("controls")).toHaveCount(0);

  await expect(page.getByTestId("results-block")).toBeVisible();
  await expect(page.getByTestId("hero-story")).toContainText("AI detects bias in observed policy logs");

  await expect(page.getByTestId("narrative-canvas")).toBeVisible();
  await expect(page.getByTestId("scene-problem")).toBeVisible();
  await expect(page.getByTestId("scene-ai")).toBeVisible();
  await expect(page.getByTestId("scene-value")).toBeVisible();

  await expect(page.getByTestId("timeline-canvas")).toBeVisible();
  await expect(page.getByTestId("timeline-phase")).toContainText("minute");
  await expect(page.getByTestId("line-naive")).toBeVisible();
  await expect(page.getByTestId("line-ai")).toBeVisible();
  await expect(page.getByTestId("timeline-playhead")).toHaveCount(1);

  await page.waitForTimeout(1000);
  await page.getByTestId("replay-simulation").click();

  await expect(page.getByTestId("recommendation-line")).toBeVisible();
  await expect(page.getByTestId("kpi-row")).toBeVisible();
  await expect(page.getByTestId("kpi-incidents")).toContainText("Incidents");
  await expect(page.getByTestId("kpi-success")).toContainText("Successful responses");
  await expect(page.getByTestId("kpi-changes")).toContainText("Segments corrected");
  await expect(page.getByTestId("apply-policy")).toBeVisible();
});
