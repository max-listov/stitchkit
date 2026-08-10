import { expect, test } from '@playwright/test';

test('prefetched data hydrates without a loading flash or a client refetch', async ({
  page,
  request,
}) => {
  // The SSR document itself carries the prefetched repository data — the
  // dehydration envelope is not empty.
  const document = await request.get('/en');
  expect(await document.text()).toContain('max-listov/stitchkit');

  // Block the browser-side read entirely: the page must still render the data
  // from the hydration envelope — never refetching, never flashing a loader.
  let clientReads = 0;
  await page.route('**/api/repository', async (route) => {
    if (route.request().method() === 'GET') {
      clientReads += 1;
      await route.abort();
      return;
    }
    await route.continue();
  });
  await page.goto('/en');
  await expect(page.getByText('max-listov/stitchkit')).toBeVisible();
  expect(clientReads).toBe(0);
});

test('a server realtime event updates the TanStack cache without a client refetch', async ({
  page,
}) => {
  await page.goto('/en');
  const summary = page.getByTestId('repository-summary');
  await expect(summary).toBeVisible();
  const before = await summary.getAttribute('data-fetched-at');
  expect(before).not.toBeNull();

  // Sever the refetch path completely: the refresh mutation invalidates the
  // query, but its refetch is aborted here — so the ONLY way the summary can
  // carry a new snapshot is the Socket.IO event through the cache bridge.
  await page.route('**/api/repository', async (route) => {
    if (route.request().method() === 'GET') {
      await route.abort();
      return;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Refresh repository data' }).click();
  await expect(summary).not.toHaveAttribute('data-fetched-at', before ?? '', {
    timeout: 10_000,
  });
});

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
