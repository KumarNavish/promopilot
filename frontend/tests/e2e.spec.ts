import { expect, test } from "@playwright/test";

test("auto demo run shows visual AI policy learning and operational impact", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Counterfactual Policy AI" })).toBeVisible();
  await expect(page.getByText("Live build marker")).toHaveCount(0);
  await expect(page.getByText("UI version")).toHaveCount(0);
  await expect(page.getByTestId("controls")).toHaveCount(0);

  await expect(page.getByTestId("results-block")).toBeVisible();
  await expect(page.getByTestId("hero-story")).toContainText("Problem -> AI correction -> business value.");
  await expect(page.getByTestId("mission-rail")).toBeVisible();
  await expect(page.getByTestId("mission-problem")).toContainText("Problem");
  await expect(page.getByTestId("mission-action")).toContainText("AI action");
  await expect(page.getByTestId("mission-value")).toContainText("Usefulness");

  await expect(page.getByTestId("spotlight")).toBeVisible();
  await expect(page.getByTestId("lane-observed")).toBeVisible();
  await expect(page.getByTestId("lane-corrected")).toBeVisible();
  await expect(page.getByTestId("decision-swap")).toBeVisible();
  await expect(page.getByTestId("connector")).toBeVisible();
  await expect(page.getByTestId("segment-tabs")).toBeVisible();
  await expect(page.getByTestId("segment-tab-0")).toBeVisible();

  await page.waitForTimeout(900);
  await expect(page.getByTestId("spotlight-step")).toBeVisible();
  await page.getByTestId("segment-tab-1").click();
  await expect(page.getByTestId("spotlight-step")).toContainText("Segment 2 of");
  await page.getByTestId("auto-tour").click();

  await expect(page.getByTestId("replay-simulation")).toBeVisible();
  await page.getByTestId("replay-simulation").click();

  await expect(page.getByTestId("impact-board")).toBeVisible();
  await expect(page.getByTestId("kpi-changes")).toContainText("Delta");
  await expect(page.getByTestId("kpi-incidents")).toContainText("Current");
  await expect(page.getByTestId("kpi-success")).toContainText("AI");
  await expect(page.getByTestId("apply-policy")).toBeVisible();
});
