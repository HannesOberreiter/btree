const tasks = ['feeds', 'treatments', 'harvests', 'checkups'];

/**
 * The API requires a date on tasks, todos and movements. The DB now enforces
 * it. A row without date gets the day of creation, a task without end date
 * gets its start date.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  for (const table of [...tasks, 'todos']) {
    await knex(table)
      .whereNull('date')
      .update({
        date: knex.raw('COALESCE(DATE(created_at), CURRENT_DATE)'),
      });
  }
  for (const table of tasks) {
    await knex(table)
      .whereNull('enddate')
      .update({ enddate: knex.ref('date') });
    await knex.schema.alterTable(table, (t) => {
      t.date('date').notNullable().alter();
      t.date('enddate').notNullable().alter();
    });
  }
  await knex.schema.alterTable('todos', (t) => {
    t.date('date').notNullable().alter();
  });
  await knex('movedates')
    .whereNull('date')
    .update({ date: knex.raw('COALESCE(created_at, UTC_TIMESTAMP())') });
  await knex.schema.alterTable('movedates', (t) => {
    t.datetime('date').notNullable().alter();
  });
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  for (const table of tasks) {
    await knex.schema.alterTable(table, (t) => {
      t.date('date').nullable().alter();
      t.date('enddate').nullable().alter();
    });
  }
  await knex.schema.alterTable('todos', (t) => {
    t.date('date').nullable().alter();
  });
  await knex.schema.alterTable('movedates', (t) => {
    t.datetime('date').nullable().alter();
  });
}
