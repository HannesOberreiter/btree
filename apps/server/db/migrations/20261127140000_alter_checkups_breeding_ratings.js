/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export function up(knex) {
  return knex.schema.alterTable('checkups', (t) => {
    t.decimal('colony_strength', 3, 1)
      .nullable()
      .after('swarm')
      .comment('Rating of the colony strength');
    t.decimal('spring_development', 3, 1)
      .nullable()
      .after('colony_strength')
      .comment('Rating of the spring development');
  });
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export function down(knex) {
  return knex.schema.alterTable('checkups', (t) => {
    t.dropColumn('colony_strength');
    t.dropColumn('spring_development');
  });
}
