import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('renders the hydrated starter application and catalogue', async ({ page }) => {
  await page.goto('/en');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'Build the product, not the plumbing',
  );
  await expect(page.getByText('max-listov/stitchkit')).toBeVisible();
  await page.getByRole('link', { name: /UI system/ }).click();
  await expect(page).toHaveURL(/\/en\/ui\/components$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('UI components');
});

test('publishes complete page metadata and a reachable Open Graph card', async ({
  page,
  request,
}) => {
  await page.goto('/en/ui/themes');
  await expect(page).toHaveTitle('Theme system · Stitchkit Starter');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    /\/en\/ui\/themes$/,
  );
  await expect(page.locator('meta[property="og:description"]')).toHaveAttribute(
    'content',
    /View Transition/,
  );

  const imageUrl = await page.locator('meta[property="og:image"]').getAttribute('content');
  expect(imageUrl).not.toBeNull();
  if (!imageUrl) throw new Error('Open Graph image URL is missing');
  const imageResponse = await request.get(imageUrl);
  expect(imageResponse.status()).toBe(200);
  expect(imageResponse.headers()['content-type']).toContain('image/png');

  const sitemapResponse = await request.get('/sitemap.xml');
  expect(sitemapResponse.status()).toBe(200);
  expect(await sitemapResponse.text()).toContain('/ru/ui/themes');
});

test('spins the refresh icon in place while its action is pending', async ({ page }) => {
  await page.route('**/api/repository/refresh', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 750));
    await route.continue();
  });
  await page.goto('/en');

  const refresh = page.getByRole('button', { name: 'Refresh repository data' });
  await expect(refresh).toHaveCSS('height', '32px');
  await expect(refresh).toHaveCSS('width', '32px');
  await expect(refresh.locator('.tabler-icon-refresh')).toHaveCount(1);
  await refresh.click();
  await expect(refresh).toHaveAttribute('aria-busy', 'true');
  await expect(refresh.locator('svg')).toHaveCount(1);
  await expect(refresh.locator('.tabler-icon-refresh')).toHaveClass(/animate-spin/);
});

test('switches catalogue sections and component tabs', async ({ page }) => {
  await page.goto('/en/ui');
  await expect(page).toHaveURL(/\/en\/ui\/components$/);

  const navigationTrigger = page.getByRole('button', { name: 'Open navigation' });
  const mobileNavigation = await navigationTrigger.isVisible();
  if (mobileNavigation) await navigationTrigger.click();

  await expect(page.getByRole('link', { name: 'UI components', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  if (mobileNavigation) await page.getByRole('button', { name: 'Close navigation' }).click();
  await page.getByRole('tab', { name: 'Feedback' }).click();
  await expect(page.getByRole('tab', { name: 'Feedback' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('button', { name: 'Open project' }).click();
  await expect(page.getByText('Project opened')).toBeVisible();
  await page.getByRole('button', { name: 'Success toast' }).click();
  await expect(page.getByText('Changes saved')).toBeVisible();

  if (mobileNavigation) await navigationTrigger.click();
  await page.getByRole('link', { name: 'Theme system', exact: true }).click();
  await expect(page).toHaveURL(/\/en\/ui\/themes$/);
});

test('uses one matching focus border for inputs and textareas', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/en/ui/components');
  await page.getByRole('tab', { name: 'Forms' }).click();

  const input = page.getByLabel('Project name');
  const textarea = page.getByLabel('Description');
  const inputFocus = await input.evaluate((element) => {
    element.focus();
    const style = getComputedStyle(element);
    return {
      borderColor: style.borderColor,
      boxShadow: style.boxShadow,
      outlineStyle: style.outlineStyle,
    };
  });
  const textareaFocus = await textarea.evaluate((element) => {
    element.focus();
    const style = getComputedStyle(element);
    return {
      borderColor: style.borderColor,
      boxShadow: style.boxShadow,
      outlineStyle: style.outlineStyle,
    };
  });

  expect(textareaFocus).toEqual(inputFocus);
  expect(textareaFocus.boxShadow).toBe('none');
  expect(textareaFocus.outlineStyle).toBe('none');
});

test('has no serious accessibility violations on the main surfaces', async ({ page }) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });

  for (const path of ['/en', '/en/ui/components', '/en/ui/themes', '/en/ui/blocks']) {
    await page.goto(path);
    await expect(page.locator('html')).not.toHaveClass(/theme-transitioning/);
    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious',
    );
    expect(blocking, `${path}: ${blocking.map((item) => item.id).join(', ')}`).toEqual([]);
  }
});

test('keeps the mobile surface inside the viewport', async ({ page }) => {
  await page.goto('/en/ui/blocks');
  const viewport = await page.evaluate(() => ({
    horizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
    verticalOverflow: document.documentElement.scrollHeight - window.innerHeight,
  }));
  expect(viewport.horizontalOverflow).toBeLessThanOrEqual(1);
  expect(viewport.verticalOverflow).toBeLessThanOrEqual(1);

  const content = page.getByTestId('catalogue-content');
  const scrollSurface = await content.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(scrollSurface.scrollHeight).toBeGreaterThan(scrollSurface.clientHeight);
});

test('keeps the desktop starter inside one viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/en');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollHeight - window.innerHeight,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test('keeps long localized navigation labels inside the mobile drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/ru/ui/components');
  await page.getByRole('button', { name: 'Open navigation' }).click();

  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();
  const overflow = await drawer.evaluate((element) => ({
    drawer: element.scrollWidth - element.clientWidth,
    labels: [...element.querySelectorAll('nav a span')].map(
      (label) => label.scrollWidth - label.clientWidth,
    ),
    page: document.documentElement.scrollWidth - window.innerWidth,
  }));

  expect(overflow.drawer).toBeLessThanOrEqual(1);
  expect(overflow.labels.every((value) => value <= 1)).toBe(true);
  expect(overflow.page).toBeLessThanOrEqual(1);
});

test('provides a server-first synchronized theme system', async ({ context, page }) => {
  const consoleProblems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleProblems.push(message.text());
    }
  });

  await page.goto('/en/ui/themes');
  await expect(page.getByTestId('theme-state-selected')).not.toContainText('hydrating');
  await expect(page.locator('#theme-scope-light')).toHaveClass(/light/);
  await expect(page.locator('#theme-scope-dark')).toHaveClass(/dark/);

  const supportsViewTransitions = await page.evaluate(
    () => typeof document.startViewTransition === 'function',
  );
  if (supportsViewTransitions) {
    await page.getByRole('button', { name: 'Radial reveal', exact: true }).click();
    await page.getByRole('button', { name: '400 ms', exact: true }).click();
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme-transition', 'radial');
    await expect(page.locator('html')).not.toHaveAttribute('data-theme-transition', 'radial');
  }

  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#242428');
  await expect(
    page.getByAltText('Application shell selected by the resolved theme'),
  ).toHaveAttribute('src', '/theme-dark.svg');

  const secondPage = await context.newPage();
  await secondPage.goto('/en/ui/themes');
  await expect(secondPage.locator('html')).toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await expect(secondPage.locator('html')).toHaveClass(/light/);

  await page.getByRole('button', { name: 'System', exact: true }).click();
  await expect(page.getByTestId('theme-state-selected')).toContainText('system');
  const themeCookie = (await context.cookies()).find(
    (cookie) => cookie.name === 'stitchkit-starter-theme',
  );
  expect(themeCookie?.value).toBe('system');
  await page.reload();
  await expect(page.getByTestId('theme-state-server-cookie')).toContainText('system');
  expect(
    consoleProblems.filter((message) =>
      /hydration|useServerInsertedHTML|inline script/i.test(message),
    ),
  ).toEqual([]);
});

test('falls back to an immediate theme update for reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/en/ui/themes');
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(page.locator('html')).not.toHaveAttribute('data-theme-transition');
});
