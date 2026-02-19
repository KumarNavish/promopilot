import { expect, test } from "@playwright/test";

test("auto demo run shows visual problem-to-solution animation and policy impact", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Counterfactual Policy AI" })).toBeVisible();
  await expect(page.getByText("Live build marker")).toHaveCount(0);
  await expect(page.getByText("UI version")).toHaveCount(0);
  await expect(page.getByTestId("controls")).toHaveCount(0);

  await expect(page.getByTestId("results-block")).toBeVisible();
  await expect(page.getByTestId("hero-story")).toContainText("AI spots bias in observed logs");

  await expect(page.getByTestId("visual-first")).toBeVisible();
  await expect(page.getByTestId("policy-lane")).toBeVisible();
  await expect(page.getByTestId("policy-track")).toBeVisible();
  await expect(page.getByTestId("queue-stage")).toBeVisible();
  await expect(page.getByTestId("queue-timeline")).toBeVisible();
  await expect(page.getByTestId("timeline-minute-3")).toHaveClass(/apply/);

  await page.waitForTimeout(1200);
  await expect(page.getByTestId("timeline-minute-0")).toBeVisible();
  await expect(page.getByTestId("timeline-minute-11")).toBeVisible();

  await expect(page.getByTestId("recommendation-line")).toBeVisible();
  await expect(page.getByTestId("kpi-row")).toBeVisible();
  await expect(page.getByTestId("kpi-incidents")).toContainText("Incidents");
  await expect(page.getByTestId("kpi-success")).toContainText("Successful responses");
  await expect(page.getByTestId("kpi-changes")).toContainText("Segments corrected");

  await expect(page.getByTestId("replay-simulation")).toBeVisible();
  await page.getByTestId("replay-simulation").click();
  await expect(page.getByTestId("apply-policy")).toBeVisible();
});
