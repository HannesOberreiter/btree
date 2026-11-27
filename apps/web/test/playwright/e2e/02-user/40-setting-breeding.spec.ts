import process from 'node:process';
import { expect, test } from '../../support/user-helpers';

const backendURL =
  process.env.PLAYWRIGHT_BACKEND_URL ?? 'http://localhost:8101';
const apiOrigin = process.env.PLAYWRIGHT_API_ORIGIN ?? 'http://localhost:8001';

test.describe('user - Setting Breeding', () => {
  // The breeding mode is a company setting. Switch it off after each test,
  // so that the other tests see the personal field settings.
  test.afterEach(async ({ request }) => {
    const response = await request.patch(`${backendURL}/api/v1/company`, {
      headers: { origin: apiOrigin },
      data: { breeding_system: null }
    });
    expect(response.ok()).toBe(true);
  });

  test('switch on, lock the field settings and check queen names', async ({
    page,
    dataCy
  }) => {
    await page.goto('setting/breeding');
    await expect(dataCy('page-setting-breeding')).toBeAttached();

    const patch = page.waitForResponse(
      response =>
        response.request().method() === 'PATCH' &&
        response.url().includes('/v1/company')
    );
    await dataCy('setting-breeding-system')
      .getByRole('radio', { name: 'BeeBreed' })
      .click();
    const response = await patch;
    expect(response.ok()).toBe(true);
    expect(response.request().postDataJSON()).toEqual({
      breeding_system: 'beebreed'
    });
    await expect(
      dataCy('setting-breeding-system').getByRole('radio', { name: 'BeeBreed' })
    ).toHaveAttribute('aria-checked', 'true');

    await page.goto('setting/field');
    await expect(dataCy('setting-field-breeding-locked')).toBeVisible();
    await expect(dataCy('setting-field-rating-temper')).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    await expect(dataCy('setting-field-rating-temper')).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await expect(dataCy('setting-field-rating-max')).toHaveAttribute(
      'aria-valuenow',
      '4'
    );
    await expect(dataCy('setting-field-rating-brood')).not.toHaveAttribute(
      'aria-disabled',
      'true'
    );
    await expect(
      dataCy('setting-field-rating-spring_development')
    ).toHaveAttribute('aria-disabled', 'true');

    await page.goto('new/queen');
    const name = dataCy('queen-name');
    const warning = dataCy('queen-breeding-warning');
    await name.fill('Queen 1');
    await expect(warning).toBeVisible();
    // The default birth date is today.
    const year = new Date().getFullYear();
    await name.fill(`DE-44-101-1-${year - 1}`);
    await expect(warning).toBeVisible();
    await name.fill(`DE-44-101-1-${year}`);
    await expect(warning).not.toBeAttached();
  });

  test('checkup form saves the breeding ratings', async ({
    page,
    request,
    dataCy,
    selectFirstHive
  }) => {
    const response = await request.patch(`${backendURL}/api/v1/company`, {
      headers: { origin: apiOrigin },
      data: { breeding_system: 'beebreed' }
    });
    expect(response.ok()).toBe(true);
    // The login of the fixture stored the company before the change.
    await page.addInitScript(() => {
      const company = JSON.parse(localStorage.getItem('company') ?? '{}');
      company.breeding_system = 'beebreed';
      localStorage.setItem('company', JSON.stringify(company));
    });
    await page.goto('/new/quicktool/checkup');
    await expect(dataCy('form-quicktool')).toBeAttached();

    await dataCy('checkup-rating').click();
    const row = dataCy('checkup-rating-colony_strength');
    await expect(row).toBeVisible();
    await expect(dataCy('checkup-rating-spring_development')).toBeVisible();
    // The breeding scale has 4 stars.
    const stars = row.locator('.q-rating__icon-container');
    await expect(stars).toHaveCount(4);
    await stars.nth(2).click();

    await selectFirstHive();
    const post = page.waitForRequest(
      req => req.method() === 'POST' && req.url().includes('/v1/checkup')
    );
    await dataCy('btn-form-save').click({ force: true });
    const body = (await post).postDataJSON();
    expect(body.colony_strength).toBe(3);
    await dataCy('btn-form-undo').click({ force: true });
    await expect(dataCy('notification')).toBeAttached();
  });

  test('edit shows the stars of an unrated breeding rating', async ({
    page,
    request,
    dataCy
  }) => {
    const headers = { origin: apiOrigin };
    const hiveResponse = await request.get(
      `${backendURL}/api/v1/hive?limit=1`,
      {
        headers
      }
    );
    const hives = ((await hiveResponse.json()) as { results: { id: number }[] })
      .results;
    expect(hives).toHaveLength(1);
    const hiveId = hives[0]?.id;
    // An old or imported checkup has no value in the new rating columns.
    // The second checkup has a value, so a multi-row edit shows
    // "multiple values".
    const note = `Breeding unrated ${Date.now()}`;
    for (const [suffix, rating] of [
      ['a', {}],
      ['b', { colony_strength: 2 }]
    ] as const) {
      const created = await request.post(`${backendURL}/api/v1/checkup`, {
        headers,
        data: {
          hive_ids: [hiveId],
          date: new Date().toISOString().slice(0, 10),
          interval: 0,
          repeat: 0,
          note: `${note} ${suffix}`,
          ...rating
        }
      });
      expect(created.ok()).toBe(true);
    }
    const response = await request.patch(`${backendURL}/api/v1/company`, {
      headers,
      data: { breeding_system: 'beebreed' }
    });
    expect(response.ok()).toBe(true);
    await page.addInitScript(() => {
      const company = JSON.parse(localStorage.getItem('company') ?? '{}');
      company.breeding_system = 'beebreed';
      localStorage.setItem('company', JSON.stringify(company));
      localStorage.setItem(
        'table-visible-checkup',
        JSON.stringify(['date', 'hive.name', 'note'])
      );
    });
    const rating = dataCy('checkup-rating-colony_strength');
    const stars = rating.locator('.q-rating__icon-container');

    await page.goto('/table/checkup');
    const row = page.locator('tbody > tr').filter({ hasText: `${note} a` });
    await expect(row).toHaveCount(1);
    await row.locator('.q-checkbox').click();
    await dataCy('btn-table-edit').click();
    await dataCy('checkup-rating').click();
    await expect(stars).toHaveCount(4);
    await page.keyboard.press('Escape');
    await expect(dataCy('form-quicktool')).not.toBeAttached();

    // Multi-row edit: the field is off until the user switches it on.
    const rows = page.locator('tbody > tr').filter({ hasText: note });
    await expect(rows).toHaveCount(2);
    await page
      .locator('tbody > tr')
      .filter({ hasText: `${note} b` })
      .locator('.q-checkbox')
      .click();
    await expect(page.locator('tbody > tr.selected')).toHaveCount(2);
    await dataCy('btn-table-edit').click();
    await dataCy('checkup-rating').click();
    await expect(rating).toBeVisible();
    await expect(stars).toHaveCount(0);
    await rating.locator('.fa-pen').click();
    await expect(stars).toHaveCount(4);
    await page.keyboard.press('Escape');
  });

  test('map harvest types to the harvest sections', async ({
    page,
    request,
    dataCy
  }) => {
    const headers = { origin: apiOrigin };
    const optionURL = `${backendURL}/api/v1/option/harvest_types`;
    const name = `Breeding section ${Date.now()}`;
    const created = await request.post(optionURL, {
      headers,
      data: { name, unit: 'kg' }
    });
    expect(created.ok()).toBe(true);
    const typeId = (await created.json()).id as number;
    // Delete the type also when the test fails.
    try {
      const response = await request.patch(`${backendURL}/api/v1/company`, {
        headers,
        data: { breeding_system: 'beebreed' }
      });
      expect(response.ok()).toBe(true);

      await page.goto('setting/breeding');
      await expect(dataCy('setting-breeding-sections')).toBeVisible();

      const pick = async (section: string) => {
        const patch = page.waitForResponse(
          res =>
            res.request().method() === 'PATCH' &&
            res.url().includes('/v1/option/harvest_types')
        );
        await dataCy(`setting-breeding-section-${section}`).click();
        await page.getByRole('option', { name: `${name} (kg)` }).click();
        const res = await patch;
        expect(res.ok()).toBe(true);
        expect(res.request().postDataJSON()).toEqual({
          ids: [typeId],
          data: { breeding_section: section }
        });
        await page.keyboard.press('Escape');
      };

      await pick('early');
      await expect(dataCy('setting-breeding-section-early')).toContainText(
        name
      );
      // A type is in one section only, so it leaves the early section.
      await pick('summer');
      await expect(dataCy('setting-breeding-section-summer')).toContainText(
        name
      );
      await expect(dataCy('setting-breeding-section-early')).not.toContainText(
        name
      );
    } finally {
      const deleted = await request.patch(`${optionURL}/batchDelete`, {
        headers,
        data: { ids: [typeId] }
      });
      expect(deleted.ok()).toBe(true);
    }
  });
});
