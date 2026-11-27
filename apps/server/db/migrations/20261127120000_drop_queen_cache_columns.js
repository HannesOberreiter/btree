import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function readSql(name) {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
}

/** Name of the foreign key on `queens.hive_id`, or undefined. */
async function hiveForeignKey(knex) {
  const row = await knex('information_schema.KEY_COLUMN_USAGE')
    .select('CONSTRAINT_NAME as name')
    .where('TABLE_SCHEMA', knex.raw('DATABASE()'))
    .where('TABLE_NAME', 'queens')
    .where('COLUMN_NAME', 'hive_id')
    .whereNotNull('REFERENCED_TABLE_NAME')
    .first();
  return row?.name;
}

/**
 * Removes the old columns `queens.hive_id` and `queens.move_date`. The table
 * `queen_placements` is the source of truth since 20261121120000. Until now,
 * the server copied the derived values into these columns.
 *
 * The new view `queen_current_placements` gives the derived values, one row
 * per queen. The rules are the same as `derivePlacement` in
 * `src/api/utils/queen_placement.util.ts`.
 *
 * The views `queens_locations` and `counts` read the old columns, so they
 * get new bodies first. The view `queen_durations` has no reader and is
 * dropped.
 *
 * MariaDB commits DDL at once, so each step is safe to run again.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  await knex.raw(readSql('./20261127120000_queen_current_placements.sql'));
  await knex.raw(readSql('./20261127120000_queens_locations.sql'));
  await knex.raw(readSql('./20261127120000_counts.sql'));
  await knex.raw('DROP VIEW IF EXISTS queen_durations');

  const foreignKey = await hiveForeignKey(knex);
  if (foreignKey)
    await knex.raw('ALTER TABLE queens DROP FOREIGN KEY ??', [foreignKey]);
  // A dropped column also drops its indexes.
  if (await knex.schema.hasColumn('queens', 'hive_id'))
    await knex.schema.alterTable('queens', (t) => {
      t.dropColumn('hive_id');
    });
  if (await knex.schema.hasColumn('queens', 'move_date'))
    await knex.schema.alterTable('queens', (t) => {
      t.dropColumn('move_date');
    });
}

/**
 * Adds the old columns again and fills them from `queen_current_placements`.
 * The `move_date` of a queen without placements is lost on `up`, so it stays
 * NULL here.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  if (!(await knex.schema.hasColumn('queens', 'move_date')))
    await knex.schema.alterTable('queens', (t) => {
      t.datetime('move_date').nullable().index().after('date');
    });
  if (!(await knex.schema.hasColumn('queens', 'hive_id')))
    await knex.schema.alterTable('queens', (t) => {
      t.integer('hive_id').unsigned().nullable().after('modus_date');
    });
  if (!(await hiveForeignKey(knex)))
    await knex.schema.alterTable('queens', (t) => {
      t.foreign('hive_id')
        .references('hives.id')
        .onDelete('SET NULL')
        .onUpdate('CASCADE');
    });
  await knex.raw(`
    UPDATE queens q
    INNER JOIN queen_current_placements c ON c.queen_id = q.id
    SET q.hive_id = c.hive_id, q.move_date = c.move_date
    WHERE c.placement_id IS NOT NULL
  `);

  await knex.raw('DROP VIEW IF EXISTS queen_durations');
  await knex.raw(readSql('./20220906075842_view_queen_durations.sql'));
  await knex.raw(readSql('./20261121120000_create_queen_placements.sql'));
  await knex.raw('DROP VIEW IF EXISTS counts');
  await knex.raw(readSql('./20221012091730_view_count.sql'));
  await knex.raw('DROP VIEW IF EXISTS queen_current_placements');
}
