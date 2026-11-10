const tables = ['feeds', 'treatments', 'harvests', 'checkups', 'todos'];

/**
 * Task lists filter by company and date range and sort by date, then id.
 * Without this index, MariaDB reads the date range of all companies.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  for (const table of tables) {
    await knex.schema.alterTable(table, (t) => {
      t.index(['user_id', 'date', 'id'], `${table}_user_id_date_id_index`);
    });
  }
}

/**
 * InnoDB drops the implicit foreign key index on user_id when the new index
 * can serve the foreign key, so restore it before the drop.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  for (const table of tables) {
    await knex.raw('CREATE INDEX IF NOT EXISTS ?? ON ?? (user_id)', [
      `${table}_user_id_foreign`,
      table,
    ]);
    await knex.schema.alterTable(table, (t) => {
      t.dropIndex(['user_id', 'date', 'id'], `${table}_user_id_date_id_index`);
    });
  }
}
