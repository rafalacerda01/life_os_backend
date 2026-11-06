'use strict';
// Synthetic Firestore IO only. The gateway constructs the production R5
// adapter; this helper neither replaces nor authorizes that adapter.
const assert = require('node:assert/strict');
const {MemoryFirestore} = require('../account-cleanup-memory.cjs');
const observations = new WeakMap();
const transactionRows = new WeakMap();
function r5Paths(uid) {
  return ['account_deletion_guards/' + uid, 'retired_auth_identities/' + uid,
    'account_deletion_guards/' + uid + '/control/operation'];
}
function observeTransactions(db) {
  assert.equal(observations.has(db), false);
  const state = {attempts: [], probes: []};
  const run = db.runTransaction.bind(db);
  db.runTransaction = (callback, ...options) => run(async tx => {
    const row = {reads: []}; state.attempts.push(row);
    const observed = new Proxy(tx, {get(target, key) {
      if (key === 'get') return async ref => {
        row.reads.push(ref.path); return target.get(ref);
      };
      return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
    }});
    transactionRows.set(observed, row);
    return callback(observed);
  }, ...options);
  observations.set(db, state);
  return db;
}
function createNormalWriterFixture() {
  return observeTransactions(new MemoryFirestore());
}
async function assertGuardedDatabase(adapter, raw, uid) {
  assert.notEqual(adapter, raw, 'business must not receive unrestricted Firestore');
  assert.equal(Object.isFrozen(adapter), true);
  assert.deepEqual(Object.keys(adapter).sort(), ['collection', 'runTransaction']);
  const state = observations.get(raw);
  assert.ok(state, 'the original database must be observed');
  const attempts = [];
  const probe = {uid, entered: false, completed: false}; state.probes.push(probe);
  const sentinel = {};
  const result = await adapter.runTransaction(tx => {
    const row = transactionRows.get(tx); assert.ok(row, 'callback must use the original transaction');
    attempts.push(row); probe.entered = true; return sentinel;
  });
  probe.completed = true;
  assert.equal(result, sentinel);
  assert.equal(attempts.length, 1);
  assert.deepEqual(attempts[0].reads, [...r5Paths(uid), "trusted_account_origins/" + uid],
    'the real transaction must read all three controls and the origin for the verified UID');
  return adapter;
}
function writerObservation(db) {
  const value = observations.get(db); assert.ok(value); return value;
}
module.exports = {createNormalWriterFixture, observeTransactions, assertGuardedDatabase,
  r5Paths, writerObservation};
