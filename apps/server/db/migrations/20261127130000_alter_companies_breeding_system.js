/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export function up(knex) {
  return knex.schema.alterTable('companies', (t) => {
    t.string('breeding_system', 20)
      .nullable()
      .defaultTo(null)
      .comment('Breeding system of the breeding mode, null if the mode is off');
  });
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export function down(knex) {
  return knex.schema.alterTable('companies', (t) => {
    t.dropColumn('breeding_system');
  });
}
