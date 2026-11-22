import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line antfu/no-import-dist
import {
  buildQueenPlacements,
  OPEN_END,
} from '../../dist/api/utils/queen_placement.util.js';

function readSql(name) {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
}

async function insertChunks(knex, rows) {
  for (let offset = 0; offset < rows.length; offset += 500)
    await knex('queen_placements').insert(rows.slice(offset, offset + 500));
}

/**
 * History of queens in hives. Before, `queens.hive_id` and `queens.move_date`
 * kept only the current hive, and a move overwrote them.
 *
 * A placement is the half-open period `[from_date, to_date)`. An open
 * placement has `to_date` = 9999-12-31, so the unique keys allow only one
 * open placement per hive and per queen.
 *
 * The backfill gives each queen with a hive one placement in that hive.
 * Moves before this migration are lost. The rules are in
 * `src/api/utils/queen_placement.util.ts`.
 *
 * The view `queens_locations` now reads the placements. The queen statistics
 * read the placements. The view `queen_durations` stays for a rollback of the
 * server, because it reads `queens.hive_id` and `queens.move_date`, which the
 * server still writes. The cleanup release drops it.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  // MariaDB commits DDL at once. A failed backfill must be safe to run again.
  if (!(await knex.schema.hasTable('queen_placements')))
    await knex.schema.createTable('queen_placements', (t) => {
      t.increments('id').primary().unsigned();
      t.integer('queen_id').unsigned().notNullable();
      t.foreign('queen_id')
        .references('queens.id')
        .onDelete('CASCADE')
        .onUpdate('CASCADE');
      t.integer('hive_id').unsigned().notNullable();
      t.foreign('hive_id')
        .references('hives.id')
        .onDelete('CASCADE')
        .onUpdate('CASCADE');
      t.date('from_date').notNullable();
      t.date('to_date').notNullable().defaultTo(OPEN_END);
      t.integer('user_id').unsigned().notNullable().comment('Company');
      t.foreign('user_id')
        .references('companies.id')
        .onDelete('CASCADE')
        .onUpdate('CASCADE');
      t.integer('bee_id').unsigned().nullable().comment('Creator');
      t.integer('edit_id').unsigned().nullable().comment('Editor');
      t.foreign('bee_id')
        .references('bees.id')
        .onDelete('SET NULL')
        .onUpdate('CASCADE');
      t.foreign('edit_id')
        .references('bees.id')
        .onDelete('SET NULL')
        .onUpdate('CASCADE');
      t.timestamps(true, true);
      t.unique(['hive_id', 'to_date']);
      t.unique(['queen_id', 'to_date']);
      t.unique(['hive_id', 'from_date']);
      t.unique(['queen_id', 'from_date']);
      t.index(['user_id']);
    });

  await knex('queen_placements').del();
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
    .whereIn('hive_id', knex('hives').select('id'));
  const { rows, skipped, inactivate } = buildQueenPlacements(queens);
  await insertChunks(
    knex,
    rows.map((row) => ({ ...row, bee_id: null, edit_id: null })),
  );
  const reasons = {};
  const companies = new Set();
  for (const skip of skipped) {
    reasons[skip.reason] = (reasons[skip.reason] ?? 0) + 1;
    if (skip.user_id) companies.add(skip.user_id);
  }
  console.log(
    `queen_placements: ${rows.length} rows, ${skipped.length} queens skipped`,
    reasons,
    `in ${companies.size} companies,`,
    `${inactivate.length} queens set inactive or given a modus_date`,
  );
  if (skipped.length)
    console.log('queen_placements skipped:', JSON.stringify(skipped));

  // Replace the view before the UPDATE below. The UPDATE sets
  // queens.hive_id to NULL for skipped queens, and the backfill reads only
  // queens with a hive. So a failure before the UPDATE is safe to run again.
  await knex.raw(readSql('./20261121120000_create_queen_placements.sql'));

  // The API derives queens.hive_id and queens.move_date from the placements.
  // Write the derived values now, so that both stay the same from the start.
  // Replaced queens that are still active: set them inactive, the same as a
  // move does today. Else they would count as queens without a hive.
  // Inactive queens without a valid modus_date get the end of their row.
  const byDay = new Map();
  for (const { queen_id, modus_date } of inactivate)
    byDay.set(modus_date, [...(byDay.get(modus_date) ?? []), queen_id]);
  for (const [day, ids] of byDay)
    for (let index = 0; index < ids.length; index += 1000)
      await knex('queens')
        .whereIn('id', ids.slice(index, index + 1000))
        .update({ modus: false, modus_date: day });

  // Queens whose hive does not exist (old data, also hive_id 0): no hive,
  // and inactive, because these queens are old. modus_date is set first,
  // because MariaDB assigns from left to right.
  const orphans = await knex.raw(`
    UPDATE queens
    SET
      modus_date = IF(modus = 1, COALESCE(DATE(updated_at), CURDATE()), modus_date),
      modus = 0,
      hive_id = NULL
    WHERE hive_id IS NOT NULL AND hive_id NOT IN (SELECT id FROM hives)
  `);
  console.log(
    `queen_placements: ${orphans[0]?.affectedRows ?? 0} queens without an existing hive set inactive`,
  );

  await knex.raw(`
    UPDATE queens q
    LEFT JOIN queen_placements p ON p.id = (
      SELECT p2.id FROM queen_placements p2
      WHERE p2.queen_id = q.id
      ORDER BY p2.from_date DESC, p2.id DESC
      LIMIT 1
    )
    SET
      q.hive_id = CASE
        WHEN p.id IS NULL THEN NULL
        WHEN p.to_date = '${OPEN_END}' OR q.modus = 0 THEN p.hive_id
        ELSE NULL
      END,
      q.move_date = CASE
        WHEN p.id IS NULL THEN q.move_date
        WHEN p.to_date = '${OPEN_END}' OR q.modus = 0 THEN p.from_date
        ELSE p.to_date
      END
    WHERE q.hive_id IS NOT NULL
  `);
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS queens_locations');
  await knex.raw(readSql('./20220125124845_view_queens_locations.sql'));
  await knex.schema.dropTableIfExists('queen_placements');
}
