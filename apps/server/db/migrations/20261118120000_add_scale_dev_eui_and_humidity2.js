/**
 * LoRaWAN scales send their readings through a TTN webhook. The webhook
 * finds the scale by its DevEUI, which is unique in a company. TTN scales
 * with the BEEP payload keys also send a second humidity value.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  await knex.schema.alterTable('scales', (t) => {
    t.string('dev_eui', 16).nullable();
    t.unique(['user_id', 'dev_eui'], {
      indexName: 'scales_user_id_dev_eui_unique',
    });
  });
  await knex.schema.alterTable('scale_data', (t) => {
    t.decimal('humidity2', 5, 2).after('humidity');
  });
}

/**
 * InnoDB can use the new unique index for the foreign key on user_id, so
 * restore the foreign key index before the drop.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  await knex.schema.alterTable('scale_data', (t) => {
    t.dropColumn('humidity2');
  });
  await knex.raw('CREATE INDEX IF NOT EXISTS ?? ON ?? (user_id)', [
    'scales_user_id_foreign',
    'scales',
  ]);
  await knex.schema.alterTable('scales', (t) => {
    t.dropUnique(['user_id', 'dev_eui'], 'scales_user_id_dev_eui_unique');
    t.dropColumn('dev_eui');
  });
}
