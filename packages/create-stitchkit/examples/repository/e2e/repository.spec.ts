import { expect, test } from '@playwright/test';

test('renders and refreshes the repository example', async ({ page }) => {
  await page.route('**/api/repository/refresh', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 750));
    await route.continue();
  });
  await page.goto('/en');
  await expect(page.getByText('max-listov/stitchkit')).toBeVisible();

  const refresh = page.getByRole('button', { name: 'Refresh repository data' });
  await expect(refresh).toHaveCSS('height', '32px');
  await expect(refresh).toHaveCSS('width', '32px');
  await expect(refresh.locator('.tabler-icon-refresh')).toHaveCount(1);
  await refresh.click();
  await expect(refresh).toHaveAttribute('aria-busy', 'true');
  await expect(refresh.locator('svg')).toHaveCount(1);
  await expect(refresh.locator('.tabler-icon-refresh')).toHaveClass(/animate-spin/);
});
