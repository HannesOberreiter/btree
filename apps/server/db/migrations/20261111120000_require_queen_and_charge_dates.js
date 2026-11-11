const tables = ['queens', 'charges'];

/**
 * The API requires a birth date on queens and a date on charges. The DB now
 * enforces it. Live has no row with a NULL date; other databases can have
 * some, so they get the day of creation first.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  for (const table of tables) {
    await knex(table)
      .whereNull('date')
      .update({
        date: knex.raw('COALESCE(DATE(created_at), CURRENT_DATE)'),
      });
    await knex.schema.alterTable(table, (t) => {
      t.date('date').notNullable().alter();
    });
  }
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  for (const table of tables) {
    await knex.schema.alterTable(table, (t) => {
      t.date('date').nullable().alter();
    });
  }
}
