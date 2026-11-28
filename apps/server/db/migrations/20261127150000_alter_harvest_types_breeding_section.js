/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export function up(knex) {
  return knex.schema.alterTable('harvest_types', (t) => {
    t.string('breeding_section', 10)
      .nullable()
      .after('unit')
      .comment(
        'Harvest section of the breeding export: early, summer, late or stock',
      );
  });
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export function down(knex) {
  return knex.schema.alterTable('harvest_types', (t) => {
    t.dropColumn('breeding_section');
  });
}
