import { expect, test } from "@playwright/test";

test(
  "checkout completes",
  { tag: "@dogfood:AC-checkout" },
  async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Order complete" })).toBeVisible();
    await expect(page.locator("#confirmation")).toHaveText("Confirmation DF-100");
  },
);
