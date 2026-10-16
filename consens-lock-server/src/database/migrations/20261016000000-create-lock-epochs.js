// @ts-check

import Migration from "velocious/build/src/database/migration/index.js";

export default class CreateLockEpochs extends Migration {
  async up() {
    await this.createTable("lock_epochs", (t) => {
      t.string("name", { null: false });
      t.integer("epoch", { null: false });
      t.timestamps();
    });

    await this.addIndex("lock_epochs", ["name"], { unique: true });
  }

  async down() {
    await this.dropTable("lock_epochs");
  }
}
