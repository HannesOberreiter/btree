import Chance from 'chance';
import { expect, test } from '../../support/user-helpers';

// Another seed than the virgin table test, so that the names differ.
const chance = new Chance(54_321);

test.describe('user - Queen Table', () => {
  const form = 'form-queen';

  test.beforeEach(async ({ page }) => {
    await page.goto('/table/queen');
  });

  test('a new queen without hive is in the virgin table', async ({
    page,
    dataCy,
    tableEditRow,
    tableDeleteRow
  }) => {
    await expect(page.locator('.q-table')).toBeAttached();

    const name = chance.name();
    await dataCy('btn-table-new').click();
    await expect(dataCy(form)).toBeAttached();
    await page.locator('[name=queen]').fill(name);
    await dataCy('btn-form-save').click();
    await expect(dataCy(form)).not.toBeAttached();

    // Show active and inactive queens: the new queen is in neither.
    await dataCy('btn-table-modus').click();
    await dataCy('btn-table-modus').click();
    await expect(page.locator('tbody > tr').first()).toBeVisible();
    await expect(
      page.locator('tbody > tr').filter({ hasText: name })
    ).toHaveCount(0);

    await page.goto('/table/virgin');
    await tableEditRow(form, name);
    await tableDeleteRow(name);
  });

  test('open Dialog Pedigree', async ({ dataCy }) => {
    await dataCy('btn-table-modus').click();
    await dataCy('col-pedigree').first().click();
    await expect(dataCy('dialog-pedigree')).toBeAttached();
    await dataCy('btn-close-dialog').click();
  });
});
