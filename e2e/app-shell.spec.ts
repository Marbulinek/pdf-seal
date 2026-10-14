import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

test.describe('app shell', () => {
  test('opens on an empty Overview with the four sections', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle('PDF Seal :: Overview');
    await expect(page.locator('.section-nav-btn')).toHaveText(['Overview', 'Signatures', 'Versions', 'Certificates']);
    await expect(page.locator('.section-nav-btn[data-section="metadata"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#emptyStateViewer')).toBeVisible();
    await expect(page.locator('#btnShare')).toBeDisabled();
  });

  test('shows the server version in the footer', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('footer.site-footer')).toContainText(`v.${version}`);
  });

  test('switches sections through the top bar and the URL', async ({ page }) => {
    await page.goto('/');
    await page.locator('.section-nav-btn[data-section="revisions"]').click();
    await expect(page).toHaveURL(/\/versions$/);
    await expect(page.locator('#revisionsListPanel')).toBeVisible();

    await page.locator('.section-nav-btn[data-section="certificates"]').click();
    await expect(page).toHaveURL(/\/certificates$/);
    await expect(page.locator('#certificatesSummaryPanel')).toBeVisible();

    await page.goto('/signatures');
    await expect(page.locator('.section-nav-btn[data-section="signatures"]')).toHaveAttribute('aria-current', 'page');
  });

  test('renders "Page not found" with a 404 for an unknown URL', async ({ page }) => {
    const response = await page.goto('/no-such-page');
    expect(response?.status()).toBe(404);
    await expect(page.locator('main h1')).toHaveText('Page not found');
    await expect(page.locator('header.topbar')).toHaveCount(0);
  });

  test('answers unknown API routes with JSON 404', async ({ request }) => {
    const response = await request.get('/api/no-such-route');
    expect(response.status()).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });
});
