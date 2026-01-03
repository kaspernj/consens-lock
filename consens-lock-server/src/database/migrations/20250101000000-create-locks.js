import Migration from "velocious/build/src/database/migration/index.js";

export default class CreateLocks extends Migration {
  async up() {
    await this.createTable("locks", (t) => {
      t.string("name", { null: false });
      t.string("owner_id", { null: false });
      t.datetime("acquired_at", { null: false });
      t.timestamps();
    });

    await this.addIndex("locks", ["name"], { unique: true });
  }

  async down() {
    await this.dropTable("locks");
  }
}
