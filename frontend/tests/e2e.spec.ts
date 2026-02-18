import { expect, test } from "@playwright/test";

test("auto demo run shows immersive usefulness and interactivity", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("single-story")).toContainText("corrects biased logs");
  await expect(page.getByText("Live build marker")).toHaveCount(0);
  await expect(page.getByText("UI version")).toHaveCount(0);

  await expect(page.getByTestId("controls")).toBeVisible();
  await expect(page.getByTestId("results-block")).toBeVisible();
  await expect(page.getByTestId("impact-strip")).toBeVisible();
  await expect(page.getByText("Minute-by-minute queue stabilization")).toBeVisible();
  await expect(page.getByTestId("timeline-minute")).toContainText("Minute");
  await expect(page.getByTestId("usefulness-line")).toContainText("Practical impact");
  await expect(page.getByTestId("operations-line")).toContainText("Operations impact");

  const recommendationBefore = (await page.getByTestId("recommendation-line").textContent()) ?? "";
  await page.getByTestId("mode-throughput").click();
  await expect(page.getByTestId("recommendation-line")).not.toHaveText(recommendationBefore);

  await page.getByTestId("horizon-year").click();
  await expect(page.getByTestId("kpi-success")).toContainText("Annual");

  await expect(page.getByTestId("weekly-slider")).toBeVisible();
  await expect(page.getByTestId("incident-cost-slider")).toBeVisible();
  await expect(page.getByTestId("timeline-play-toggle")).toBeVisible();
  await expect(page.getByTestId("replay-simulation")).toBeVisible();
  await expect(page.getByTestId("timeline-scrubber")).toBeVisible();
  await expect(page.getByTestId("timeline-verdict")).toContainText("Incident-room verdict");
  await expect(page.getByTestId("timeline-chart")).toBeVisible();
  await expect(page.getByTestId("apply-policy")).toBeVisible();
});
