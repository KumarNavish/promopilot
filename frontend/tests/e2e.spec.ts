import { expect, test } from "@playwright/test";

test("auto demo run is minimal, interactive, and value-forward", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("single-story")).toContainText("AI reweighted biased logs");
  await expect(page.getByText("Live build marker")).toHaveCount(0);
  await expect(page.getByText("UI version")).toHaveCount(0);
  await expect(page.getByTestId("controls")).toHaveCount(0);

  await expect(page.getByTestId("results-block")).toBeVisible();
  await expect(page.getByTestId("recommendation-line")).toContainText("Apply now:");
  await expect(page.getByTestId("usefulness-line")).toContainText("on-call hours");
  await expect(page.getByTestId("impact-strip")).toBeVisible();
  await expect(page.getByText("AI run (auto)")).toBeVisible();

  await expect(page.getByTestId("timeline-minute")).toContainText("m");
  await expect(page.getByTestId("replay-simulation")).toBeVisible();
  await expect(page.getByTestId("ai-steps")).toBeVisible();
  await expect(page.getByTestId("timeline-chart")).toBeVisible();
  await expect(page.getByTestId("timeline-slo")).toContainText("Outcome:");

  await page.waitForTimeout(900);
  const minuteBeforeReplay = (await page.getByTestId("timeline-minute").textContent()) ?? "";
  await page.getByTestId("replay-simulation").click();
  await expect(page.getByTestId("timeline-minute")).not.toHaveText(minuteBeforeReplay);

  await expect(page.getByTestId("kpi-success")).toBeVisible();
  await expect(page.getByTestId("kpi-incidents")).toBeVisible();
  await expect(page.getByTestId("kpi-risk-cost")).toBeVisible();
  await expect(page.getByTestId("apply-policy")).toBeVisible();
});
