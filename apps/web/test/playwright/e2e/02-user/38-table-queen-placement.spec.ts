import type { Page } from '../../support/user-helpers';
import dayjs from 'dayjs';
import { expect, test } from '../../support/user-helpers';

const backendURL =
  process.env.PLAYWRIGHT_BACKEND_URL ?? 'http://localhost:8101';

interface Setup {
  apiaryIds: number[];
  hiveIds: number[];
  queenIds: number[];
}

function headers(page: Page) {
  return { origin: new URL(page.url()).origin };
}

async function post(page: Page, path: string, data: unknown) {
  const response = await page
    .context()
    .request.post(`${backendURL}/api/v1/${path}`, {
      headers: headers(page),
      data
    });
  expect(response.ok()).toBe(true);
  return response.json();
}

/** An apiary with one hive. */
async function createHive(page: Page, setup: Setup, name: string) {
  const apiary = (await post(page, 'apiary', { name })) as { id: number };
  setup.apiaryIds.push(apiary.id);
  const hives = (await post(page, 'hive', {
    name,
    apiary_id: apiary.id,
    date: dayjs().format('YYYY-MM-DD'),
    start: 0,
    repeat: 0
  })) as number[];
  setup.hiveIds.push(...hives);
  return hives[0]!;
}

async function createQueen(
  page: Page,
  setup: Setup,
  name: string,
  hiveId: number | null,
  moveDate: string
) {
  const ids = (await post(page, 'queen', {
    name,
    date: '2025-01-01',
    hive_id: hiveId === null ? null : [hiveId],
    move_date: moveDate,
    modus: true
  })) as number[];
  setup.queenIds.push(...ids);
  return ids[0]!;
}

async function cleanup(page: Page, setup: Setup) {
  const request = page.context().request;
  for (const [table, ids] of [
    ['queen', setup.queenIds],
    ['hive', setup.hiveIds],
    ['apiary', setup.apiaryIds]
  ] as const) {
    if (ids.length > 0) {
      await request.patch(
        `${backendURL}/api/v1/${table}/batchDelete?hard=true`,
        { headers: headers(page), data: { ids } }
      );
    }
  }
}

function tableRow(page: Page, value: string) {
  return page.locator('tbody tr').filter({ hasText: value });
}

test.describe('user - Queen Placement Table', () => {
  const form = 'form-queen-placement';

  test('filter, edit and delete placements', async ({
    page,
    dataCy,
    tableEditRow,
    tableDeleteRow
  }) => {
    const stamp = Date.now();
    const hiveName = `E2E placement ${stamp}`;
    const oldQueen = `Old ${stamp}`;
    const newQueen = `New ${stamp}`;
    const setup: Setup = { apiaryIds: [], hiveIds: [], queenIds: [] };
    await page.goto('/table/queen-placement');
    try {
      const hiveId = await createHive(page, setup, hiveName);
      // The new queen ends the placement of the old queen.
      await createQueen(page, setup, oldQueen, hiveId, '2025-01-01');
      await createQueen(page, setup, newQueen, hiveId, '2025-06-01');

      await expect(dataCy('banner-queen-placement')).toBeVisible();
      await page.locator('.q-table__top input:not([readonly])').fill(hiveName);
      await expect(tableRow(page, hiveName)).toHaveCount(2);
      // The closed placement lasted from 2025-01-01 to 2025-06-01.
      await expect(
        tableRow(page, oldQueen).getByRole('cell', { name: '151', exact: true })
      ).toBeVisible();

      // An open placement has no end date in the edit form.
      await tableRow(page, newQueen).locator('.q-checkbox').click();
      await dataCy('btn-table-edit').click();
      await expect(dataCy(form)).toBeAttached();
      await expect(dataCy('input-placement-from')).toBeVisible();
      await expect(dataCy('input-placement-to')).toBeHidden();
      await page.keyboard.press('Escape');
      await expect(dataCy(form)).not.toBeAttached();
      await tableRow(page, newQueen).locator('.q-checkbox').click();

      // A closed placement shows its end date.
      await tableRow(page, oldQueen).locator('.q-checkbox').click();
      await dataCy('btn-table-edit').click();
      await expect(dataCy('input-placement-to')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dataCy(form)).not.toBeAttached();
      await tableRow(page, oldQueen).locator('.q-checkbox').click();

      await tableEditRow(form, oldQueen);

      // The hive page lists the placements.
      await page.goto(`/detail/hive/${hiveId}`);
      await dataCy('tab-hive-info').click();
      const info = dataCy('hive-info-queens');
      await expect(info).toContainText(newQueen);
      await expect(info).toContainText(oldQueen);

      await page.goto('/table/queen-placement');
      await page.locator('.q-table__top input:not([readonly])').fill(hiveName);
      await expect(tableRow(page, hiveName)).toHaveCount(2);
      await tableDeleteRow(oldQueen);
      await expect(tableRow(page, hiveName)).toHaveCount(1);
      await expect(tableRow(page, newQueen)).toHaveCount(1);
    } finally {
      await cleanup(page, setup);
    }
  });

  test('a hive change in the queen form moves the queen on today', async ({
    page,
    dataCy
  }) => {
    const stamp = Date.now();
    const hiveName = `E2E move out ${stamp}`;
    const queen = `Out ${stamp}`;
    const today = dayjs().format('YYYY-MM-DD');
    const setup: Setup = { apiaryIds: [], hiveIds: [], queenIds: [] };
    await page.goto('/table/queen');
    try {
      const hiveId = await createHive(page, setup, hiveName);
      const queenId = await createQueen(
        page,
        setup,
        queen,
        hiveId,
        '2025-01-01'
      );

      await page.locator('.q-table__top input:not([readonly])').fill(queen);
      await tableRow(page, queen).locator('.q-checkbox').click();
      await dataCy('btn-table-edit').click();
      await expect(dataCy('form-queen')).toBeAttached();
      // Quasar puts the data-cy on the native input, the hint is on the field.
      const moveDate = dataCy('input-queen-move-date').locator(
        "xpath=ancestor::label[contains(concat(' ', @class, ' '), ' q-field ')]"
      );
      await expect(moveDate).not.toContainText('Day of the hive change');

      await dataCy('dropdown-hive').click();
      await page
        .locator('.q-menu .q-item')
        .filter({ hasText: 'No hive' })
        .click();
      await expect(moveDate).toContainText('Day of the hive change');
      await expect(moveDate.locator('.q-field__label')).toHaveClass(
        /text-orange-9/
      );

      // The original hive restores the old move day.
      await dataCy('dropdown-hive').click();
      await page
        .locator('.q-menu .q-item')
        .filter({ hasText: hiveName })
        .click();
      await expect(moveDate).not.toContainText('Day of the hive change');
      await expect(moveDate.locator('.q-field__label')).not.toHaveClass(
        /text-orange-9/
      );

      await dataCy('dropdown-hive').click();
      await page
        .locator('.q-menu .q-item')
        .filter({ hasText: 'No hive' })
        .click();
      const update = page.waitForRequest(
        request =>
          request.method() === 'PATCH' &&
          new URL(request.url()).pathname === '/api/v1/queen'
      );
      await dataCy('btn-form-update').click();
      const body = (await update).postDataJSON() as {
        data: { hive_id: unknown; move_date: string };
      };
      expect(body.data.hive_id).toBe('empty');
      expect(body.data.move_date).toBe(today);

      // The placement ends today and stays in the queen history.
      await expect
        .poll(async () => {
          const response = await page
            .context()
            .request.get(`${backendURL}/api/v1/queen_placement`, {
              headers: headers(page),
              params: {
                filters: JSON.stringify([
                  { 'queen_placements.queen_id': queenId }
                ])
              }
            });
          const { results } = (await response.json()) as {
            results: Array<{ from_date: string; to_date: string | null }>;
          };
          return results.map(row => [row.from_date, row.to_date]);
        })
        .toEqual([['2025-01-01', today]]);
    } finally {
      await cleanup(page, setup);
    }
  });

  test('warns before a move on the start day of the current queen', async ({
    page,
    dataCy
  }) => {
    const stamp = Date.now();
    const hiveName = `E2E same day ${stamp}`;
    const current = `Current ${stamp}`;
    const virgin = `Virgin ${stamp}`;
    const today = dayjs().format('YYYY-MM-DD');
    const setup: Setup = { apiaryIds: [], hiveIds: [], queenIds: [] };
    await page.goto('/table/virgin');
    try {
      const hiveId = await createHive(page, setup, hiveName);
      const currentId = await createQueen(page, setup, current, hiveId, today);
      await createQueen(page, setup, virgin, null, today);

      await page.locator('.q-table__top input:not([readonly])').fill(virgin);
      await tableRow(page, virgin).locator('.q-checkbox').click();
      await dataCy('btn-table-edit').click();
      await expect(dataCy('form-queen')).toBeAttached();
      await dataCy('dropdown-hive').click();
      await page
        .locator('.q-menu .q-item')
        .filter({ hasText: hiveName })
        .click();

      let patched = false;
      page.on('request', request => {
        if (
          request.method() === 'PATCH' &&
          new URL(request.url()).pathname === '/api/v1/queen'
        ) {
          patched = true;
        }
      });

      // Cancel: nothing is saved.
      await dataCy('btn-form-update').click();
      const dialog = page.locator('.q-dialog').filter({ hasText: current });
      await expect(dialog).toBeVisible();
      await dataCy('btn-same-day-cancel').click();
      await expect(dialog).not.toBeAttached();
      expect(patched).toBe(false);

      // Confirm: the move replaces the current queen.
      const update = page.waitForResponse(
        response =>
          response.request().method() === 'PATCH' &&
          new URL(response.url()).pathname === '/api/v1/queen'
      );
      await dataCy('btn-form-update').click();
      await dataCy('btn-same-day-confirm').click();
      expect((await update).ok()).toBe(true);

      const check = await page
        .context()
        .request.post(`${backendURL}/api/v1/queen/batchGet`, {
          headers: headers(page),
          data: { ids: [currentId] }
        });
      const [row] = (await check.json()) as Array<{ modus: boolean }>;
      expect(row?.modus).toBe(false);
    } finally {
      await cleanup(page, setup);
    }
  });
});
