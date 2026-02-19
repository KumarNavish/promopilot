import { expect, test } from "@playwright/test";

test("auto demo run is minimal, interactive, and value-forward", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("single-story")).toContainText("incident surge");
  await expect(page.getByText("Live build marker")).toHaveCount(0);
  await expect(page.getByText("UI version")).toHaveCount(0);
  await expect(page.getByTestId("controls")).toHaveCount(0);

  await expect(page.getByTestId("results-block")).toBeVisible();
  await expect(page.getByTestId("recommendation-line")).toContainText("Ship bias-adjusted policy");
  await expect(page.getByTestId("impact-strip")).toBeVisible();
  await expect(page.getByText("Minute-by-minute queue stabilization")).toBeVisible();

  await expect(page.getByTestId("timeline-minute")).toContainText("m");
  await expect(page.getByTestId("timeline-play-toggle")).toBeVisible();
  await page.getByTestId("timeline-play-toggle").click();
  await expect(page.getByTestId("timeline-play-toggle")).toHaveText("Play");

  await expect(page.getByTestId("replay-simulation")).toBeVisible();
  await expect(page.getByTestId("timeline-scrubber")).toBeVisible();
  await expect(page.getByTestId("timeline-chart")).toBeVisible();
  await expect(page.getByTestId("timeline-slo")).toContainText("SLO threshold");

  await page.getByTestId("timeline-scrubber").fill("12");
  await expect(page.getByTestId("timeline-minute")).toContainText("m12");

  await expect(page.getByTestId("kpi-success")).toBeVisible();
  await expect(page.getByTestId("kpi-incidents")).toBeVisible();
  await expect(page.getByTestId("kpi-risk-cost")).toBeVisible();
  await expect(page.getByTestId("apply-policy")).toBeVisible();
});
