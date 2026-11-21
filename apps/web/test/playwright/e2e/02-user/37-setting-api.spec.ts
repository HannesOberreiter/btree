import type { Page, Route } from '@playwright/test';
import { t } from '../../support/i18n';
import { expect, test } from '../../support/user-helpers';

// All API changes in these tests are mocked, so the API status of the
// test company does not change.

// The activate or the deactivate button, depending on the API status.
function statusButton(page: Page) {
  return page.locator('.q-btn').filter({
    hasText: new RegExp(`^(${t('activate')}|${t('deactivate')})$`)
  });
}

function unlockButton(page: Page) {
  return page.locator('.q-btn').filter({ hasText: t('unlockAPI') });
}

async function fulfillError(route: Route, statusCode: number) {
  await route.fulfill({
    status: statusCode,
    contentType: 'application/json',
    body: JSON.stringify({ statusCode, code: 'HTTP_ERROR', message: '' })
  });
}

test.describe('user - Setting API', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('setting/profile/api');
    await expect(statusButton(page)).toBeVisible();
  });

  test('asks for the password before a change', async ({ page, dataCy }) => {
    let requests = 0;
    await page.route('**/api/v1/company', async route => {
      requests++;
      await route.continue();
    });

    await statusButton(page).click();

    await expect(dataCy('notification')).toContainText(
      t('validations.required').replace('{field}', t('password'))
    );
    await expect(statusButton(page)).toBeEnabled();
    expect(requests).toBe(0);
  });

  test('shows the loading state and the error of a slow request', async ({
    page,
    dataCy
  }) => {
    let release = () => {};
    const released = new Promise<void>(resolve => {
      release = resolve;
    });
    await page.route('**/api/v1/company', async route => {
      if (route.request().method() !== 'PATCH') {
        await route.continue();
        return;
      }
      await released;
      await fulfillError(route, 500);
    });

    await page.locator('input[name="password"]').fill('password');
    await statusButton(page).click();

    await expect(statusButton(page)).toBeDisabled();
    await expect(dataCy('notification')).not.toBeAttached();

    release();
    await expect(dataCy('notification')).toContainText(t('error.unknown'));
    await expect(statusButton(page)).toBeEnabled();
  });

  test('shows the error when the API key cannot be loaded', async ({
    page,
    dataCy
  }) => {
    await page.route('**/api/v1/company', async route => {
      if (route.request().method() !== 'PATCH') {
        await route.continue();
        return;
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ id: 0, api_active: true })
      });
    });
    await page.route('**/api/v1/user/checkpassword', route =>
      fulfillError(route, 402)
    );
    await page.locator('input[name="password"]').fill('password');
    if (!(await unlockButton(page).isVisible())) {
      await statusButton(page).click();
    }

    await unlockButton(page).click();

    await expect(dataCy('notification')).toContainText(t('error.premium'));
    await expect(unlockButton(page)).toBeEnabled();
  });
});
