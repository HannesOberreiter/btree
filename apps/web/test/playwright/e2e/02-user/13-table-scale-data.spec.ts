import Chance from 'chance';
import { t } from '../../support/i18n';
import { expect, test } from '../../support/user-helpers';

const chance = new Chance(12_345);

test.describe('user - Scale Data Table', () => {
  const form = 'form-scale-data';

  test.beforeEach(async ({ page }) => {
    await page.goto('/table/scale_data');
  });

  test('create Scale', async ({ page, dataCy }) => {
    await expect(page.locator('.q-table')).toBeAttached();

    await dataCy('btn-dropdown-scale').click();
    await dataCy('btn-new-scale').click();
    await expect(dataCy('form-scale')).toBeAttached();
    await page.locator('[name=scale]').fill(chance.province());
    await page.locator('[name=dev_eui]').fill('zz-b3-d5-7e-d0-01-23-45');
    await dataCy('btn-form-save').click();
    await expect(
      dataCy('form-scale').getByText(t('validations.devEui'))
    ).toBeVisible();
    const devEui = Array.from({ length: 8 }, () =>
      Math.floor(Math.random() * 256)
        .toString(16)
        .padStart(2, '0')
    ).join('-');
    await page.locator('[name=dev_eui]').fill(devEui);
    await dataCy('btn-form-save').click();
    await expect(dataCy(form)).not.toBeAttached();
  });

  test('create, Edit, Delete', async ({
    page,
    dataCy,
    tableEditRow,
    tableDeleteRow
  }) => {
    const weight = '999.99';
    await dataCy('btn-table-new').click();
    await expect(dataCy(form)).toBeAttached();
    await page.locator('[name=weight]').fill(weight);
    await dataCy('btn-form-save').click();
    await expect(dataCy(form)).not.toBeAttached();

    await tableEditRow(form, '999');
    await tableDeleteRow('999');
  });

  test('keeps an empty value empty', async ({
    page,
    dataCy,
    tableDeleteRow
  }) => {
    const weight = '998.88';
    const temperature = page.locator('[name="scale.temperature1"]');
    const request = (method: string) =>
      page.waitForRequest(
        req => req.method() === method && req.url().endsWith('/v1/scale_data')
      );

    await dataCy('btn-table-new').click();
    await expect(dataCy(form)).toBeAttached();
    await expect(temperature).toHaveValue('');
    await page.locator('[name=weight]').fill(weight);
    const created = request('POST');
    await dataCy('btn-form-save').click();
    expect((await created).postDataJSON()).toMatchObject({
      weight: Number(weight),
      temp1: null,
      humidity: null
    });
    await expect(dataCy(form)).not.toBeAttached();

    const row = page.locator('tbody > tr').filter({ hasText: '998' });
    await expect(row).toHaveCount(1);
    await row.locator('.q-checkbox').click();
    await dataCy('btn-table-edit').click();
    await expect(page.locator('[name=weight]')).toHaveValue(weight);
    await expect(temperature).toHaveValue('');
    const updated = request('PATCH');
    await dataCy('btn-form-update').click();
    expect((await updated).postDataJSON().data).toMatchObject({ temp1: null });
    await expect(dataCy(form)).not.toBeAttached();
    await row.locator('.q-checkbox').click();

    await tableDeleteRow('998');
  });

  test('edit of rows with different values keeps the values', async ({
    page,
    dataCy,
    tableDeleteRow
  }) => {
    const weights = ['997.11', '996.22'] as const;
    const weight = page.locator('[name=weight]');
    const temperature = page.locator('[name="scale.temperature1"]');
    const rowOf = (text: string) =>
      page.locator('tbody > tr').filter({ hasText: text });
    const rows = [rowOf(weights[0]), rowOf(weights[1])];
    const first = rowOf(weights[0]);
    const patch = () =>
      page.waitForRequest(
        req => req.method() === 'PATCH' && req.url().endsWith('/v1/scale_data')
      );

    for (const text of weights) {
      await dataCy('btn-table-new').click();
      await expect(dataCy(form)).toBeAttached();
      await weight.fill(text);
      if (text === weights[0]) {
        await temperature.fill('12.5');
      }
      await dataCy('btn-form-save').click();
      await expect(dataCy(form)).not.toBeAttached();
      await expect(rowOf(text)).toHaveCount(1);
    }

    // The weight, the temperature and the timestamp differ. The humidity is
    // empty in both rows.
    for (const row of rows) {
      await row.locator('.q-checkbox').click();
    }
    await dataCy('btn-table-edit').click();
    await expect(weight).toBeDisabled();
    await expect(temperature).toBeDisabled();
    const kept = patch();
    await dataCy('btn-form-update').click();
    const keptData = (await kept).postDataJSON().data;
    expect(keptData).not.toHaveProperty('weight');
    expect(keptData).not.toHaveProperty('temp1');
    expect(keptData).toMatchObject({ humidity: null });
    await expect(dataCy(form)).not.toBeAttached();
    for (const row of rows) {
      await expect(row).toHaveCount(1);
      await row.locator('.q-checkbox').click();
    }

    // A field that the user clears removes the stored value.
    await first.locator('.q-checkbox').click();
    await dataCy('btn-table-edit').click();
    await expect(temperature).toHaveValue('12.50');
    await temperature.fill('');
    const cleared = patch();
    await dataCy('btn-form-update').click();
    expect((await cleared).postDataJSON().data).toMatchObject({ temp1: null });
    await expect(dataCy(form)).not.toBeAttached();
    await first.locator('.q-checkbox').click();

    for (const text of weights) {
      await tableDeleteRow(text);
    }
  });
});
