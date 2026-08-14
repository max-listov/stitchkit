import { expect, type Page, test } from '@playwright/test';

async function gotoWithRealtime(page: Page): Promise<void> {
  const connected = page
    .waitForEvent('websocket', {
      predicate: (socket) => socket.url().includes('/socket.io/'),
    })
    .then((socket) =>
      socket.waitForEvent('framereceived', {
        predicate: ({ payload }) => typeof payload === 'string' && payload.startsWith('40'),
      }),
    );
  await page.goto('/en');
  await connected;
}

async function expectRepositorySummary(page: Page): Promise<void> {
  const summary = page.getByTestId('repository-summary');
  await expect(summary).toHaveCount(1);
  await expect(summary).toBeVisible();
  await expect(summary.getByText('max-listov/stitchkit', { exact: true })).toBeVisible();
}

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
  await expectRepositorySummary(page);
  expect(clientReads).toBe(0);
});

test('a server realtime event updates the TanStack cache without a client refetch', async ({
  context,
  page,
}) => {
  await gotoWithRealtime(page);
  const summary = page.getByTestId('repository-summary');
  await expect(summary).toBeVisible();
  const before = await summary.getAttribute('data-fetched-at');
  expect(before).not.toBeNull();

  // Sever the observer's HTTP read path completely, then refresh from a second
  // tab. The observer never invokes the mutation and cannot consume its HTTP
  // result, so only the Socket.IO event can update its TanStack cache.
  await page.route('**/api/repository', async (route) => {
    if (route.request().method() === 'GET') {
      await route.abort();
      return;
    }
    await route.continue();
  });
  const trigger = await context.newPage();
  await trigger.goto('/en');
  await trigger.getByRole('button', { name: 'Refresh repository data' }).click();
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
  await expectRepositorySummary(page);

  const refresh = page.getByRole('button', { name: 'Refresh repository data' });
  await expect(refresh).toHaveCSS('height', '32px');
  await expect(refresh).toHaveCSS('width', '32px');
  await expect(refresh.locator('.tabler-icon-refresh')).toHaveCount(1);
  await refresh.click();
  await expect(refresh).toHaveAttribute('aria-busy', 'true');
  await expect(refresh.locator('svg')).toHaveCount(1);
  await expect(refresh.locator('.tabler-icon-refresh')).toHaveClass(/animate-spin/);
});
