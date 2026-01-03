import Record from "velocious/build/src/database/record/index.js";

class Lock extends Record {}

Lock.validates("name", { presence: true, uniqueness: true });
Lock.validates("ownerId", { presence: true });

export default Lock;
