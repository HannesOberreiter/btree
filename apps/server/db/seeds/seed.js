import fs from 'node:fs';

import { cloneDeep, map, omit } from 'lodash-es';

// eslint-disable-next-line antfu/no-import-dist
import { buildQueenPlacements } from '../../dist/api/utils/queen_placement.util.js';
// eslint-disable-next-line antfu/no-import-dist
import * as env from '../../dist/config/environment.config.js';

const dirname = new URL('./', import.meta.url).pathname;

export async function seed(knex) {
  if (env.env === 'production') {
    console.log('No seeding allowed in production environment!');
    return false;
  }
  const tables = [];
  fs.readdirSync(`${dirname}/data/`).forEach((file) => {
    file = file.replace('.json', '');
    tables.push(file);
  });

  const promises = [];

  // First we clear all tables with truncate
  // then fill from data jsons
  // FOREIGN KEY CHECK removed to prevent errors
  for (let t = 0; t < tables.length; t++) {
    const table = tables[t];
    const jsonData = JSON.parse(
      fs.readFileSync(`${dirname}/data/${table}.json`, 'utf-8'),
    );
    let duplicates = 1;
    if (['checkups', 'feeds', 'treatments', 'queens'].includes(table)) {
      duplicates = env.env === 'test' || env.env === 'ci' ? 1 : 20;
    }
    let newData = cloneDeep(jsonData);

    if (table === 'checkups') {
      newData = map(newData, (d) => {
        return {
          varroa: Number.isNaN(d.varroa) ? 0 : Number(d.varroa),
          ...omit(d, 'varroa'),
        };
      });
    }

    for (let i = 1; i <= duplicates; i++) {
      if (i > 1) {
        newData = map(cloneDeep(newData), (d) => omit(d, ['id']));
      }
      await transactionMigration(table, newData, knex);

      /* promises.push(
          knex.transaction(function (trx) {
            knex
              .raw('SET FOREIGN_KEY_CHECKS=0')
              .transacting(trx)
              .then(async function () {
                return await knex(table).transacting(trx).truncate();
              })
              .then(async function () {
                return await knex(table)
                  .transacting(trx)
                  .insert(cloneDeep(newData));
              })
              .finally(trx.commit);
          })
        ); */
    }
  }
  await seedQueenPlacements(knex);
  return Promise.all(promises);
}

/** Placements for the seeded queens, with the rules of the migration. */
async function seedQueenPlacements(knex) {
  const queens = await knex('queens')
    .select(
      'id',
      'hive_id',
      'user_id',
      'move_date',
      'created_at',
      'updated_at',
      'modus',
      'modus_date',
      'deleted',
    )
    .whereNotNull('hive_id');
  const { rows } = buildQueenPlacements(queens);
  await knex('queen_placements').del();
  await knex.batchInsert('queen_placements', rows, 1000);
  console.log(`Insert queen_placements: ${rows.length} rows`);
}

async function transactionMigration(table, data, knex) {
  console.log(`Insert ${table}: ${data.length} rows`);
  return knex
    .transaction(async (trx) => {
      await knex.raw('SET FOREIGN_KEY_CHECKS=0').transacting(trx);
      await knex.raw('SET sql_mode=""').transacting(trx);
      await knex(table).transacting(trx).del();
      await knex(table).transacting(trx).truncate();
      await knex
        .batchInsert(table, data, 10000)
        .transacting(trx)
        .catch((error) => {
          console.error(error);
        });
      await knex.raw('SET FOREIGN_KEY_CHECKS=1').transacting(trx);
    })
    .catch((error) => {
      console.error(error);
    });
}
