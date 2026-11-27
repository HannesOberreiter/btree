import { expect, test } from '../../support/user-helpers';

test.describe('user - Upload CSV', () => {
  test('checkup import keeps decimals and skips absent number columns', async ({
    page,
    dataCy
  }) => {
    // Answer the create request, so that the test does not need a real hive.
    await page.route('**/api/v1/checkup', async route => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      await route.fulfill({ json: [1] });
    });

    await page.goto('/table/checkup');
    await expect(page.locator('.q-table')).toBeAttached();
    await dataCy('btn-table-dropdown').click();
    await dataCy('btn-table-import').click();
    await expect(dataCy('dialog-upload')).toBeAttached();

    // QFile puts its attributes, also data-cy, on the file input.
    await dataCy('input-upload-csv').setInputFiles({
      name: 'checkup.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(
        'hive_id;date;temper;note\n1;2026-05-01;3,5;E2E csv\n'
      )
    });

    const request = page.waitForRequest(
      req =>
        req.method() === 'POST' &&
        new URL(req.url()).pathname.endsWith('/api/v1/checkup')
    );
    await dataCy('btn-upload-csv').click();
    const body = (await request).postDataJSON();

    expect(body).toMatchObject({
      hive_ids: [1],
      date: '2026-05-01',
      type_id: 1,
      temper: 3.5,
      note: 'E2E csv [import csv]'
    });
    for (const field of [
      'brood',
      'pollen',
      'comb',
      'calm_comb',
      'swarm',
      'varroa',
      'strong',
      'temperature',
      'weight',
      'broodframes',
      'honeyframes',
      'foundation',
      'emptyframes'
    ]) {
      expect(body).not.toHaveProperty(field);
    }
  });
});
