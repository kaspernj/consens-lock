// @ts-check

import Record from "velocious/build/src/database/record/index.js";

class LockEpoch extends Record {}

// Velocious's inflection pluralizes "epoch" to "epoches"; pin the real table name.
LockEpoch.setTableName("lock_epochs");

LockEpoch.validates("name", { presence: true, uniqueness: true });
LockEpoch.validates("epoch", { presence: true });

export default LockEpoch;
