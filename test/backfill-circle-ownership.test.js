import assert from 'node:assert/strict';
import test from 'node:test';

import { getApps } from 'firebase-admin/app';
import { FieldPath } from 'firebase-admin/firestore';

import {
  backfillCircleOwnership,
  CircleOwnershipBackfillError,
} from '../scripts/backfill-circle-ownership.js';

class Snapshot {
  constructor(path, data) {
    this.ref = { path };
    this.id = path.split('/').at(-1);
    this.exists = data !== undefined;
    this.value = data === undefined ? undefined : { ...data };
  }

  data() { return this.value; }
}

class Query {
  constructor(db, group) {
    this.db = db;
    this.group = group;
  }

  orderBy(field) {
    assert.ok(field.isEqual(FieldPath.documentId()));
    return this;
  }

  limit(count) {
    assert.ok(count > 0 && count <= 200);
    this.count = count;
    return this;
  }

  startAfter(snapshot) {
    assert.ok(snapshot instanceof Snapshot);
    this.cursor = snapshot.ref.path;
    return this;
  }

  async get() {
    const paths = [...this.db.store.keys()].sort().filter((path) =>
      path.split('/').at(-2) === this.group &&
      (!this.cursor || path > this.cursor),
    ).slice(0, this.count);
    this.db.pages.push({ group: this.group, cursor: this.cursor, paths });
    return { docs: paths.map((path) => new Snapshot(path, this.db.store.get(path))) };
  }
}

class FakeFirestore {
  constructor(entries = []) {
    this.store = new Map(entries);
    this.writes = [];
    this.pages = [];
    this.beforeRead = null;
    this.beforeCommit = null;
  }

  collectionGroup(group) { return new Query(this, group); }

  async runTransaction(callback) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const reads = new Map();
      const writes = [];
      const result = await callback({
        get: async (ref) => {
          const hook = this.beforeRead;
          this.beforeRead = null;
          if (hook) hook(ref);
          reads.set(ref.path, this.store.get(ref.path));
          return new Snapshot(ref.path, this.store.get(ref.path));
        },
        update: (ref, data) => {
          assert.ok(reads.has(ref.path));
          assert.deepEqual(Object.keys(data), ['uid']);
          writes.push({ path: ref.path, data });
        },
      });
      const hook = this.beforeCommit;
      this.beforeCommit = null;
      if (hook) hook();
      if ([...reads].some(([path, value]) => this.store.get(path) !== value)) continue;
      for (const write of writes) {
        assert.ok(this.store.has(write.path), 'update cannot recreate a deleted doc');
        this.store.set(write.path, { ...this.store.get(write.path), ...write.data });
        this.writes.push(write);
      }
      return result;
    }
    throw new Error('transaction contention');
  }
}

function docPath(group, uid = 'private-user', circle = 'private-circle') {
  return group === 'progress'
    ? `circles/${circle}/challenges/private-challenge/progress/${uid}`
    : `circles/${circle}/ranking/${uid}`;
}

function originalData(group) {
  return group === 'progress'
    ? { value: 7, updatedAt: 123, lastEventAt: 100, untouched: 'private-content' }
    : { name: 'private-name', totalXp: 70, photoUrl: 'private-photo', updatedAt: 123 };
}

const silent = () => {};

test('importing backfill does not initialize Firebase Admin', () => {
  assert.equal(getApps().length, 0);
});

for (const group of ['progress', 'ranking']) {
  test(`${group} missing uid is a dry-run candidate with zero writes by default`, async () => {
    const path = docPath(group);
    const original = originalData(group);
    const db = new FakeFirestore([[path, original]]);

    const result = await backfillCircleOwnership({ db, log: silent });

    assert.equal(result.apply, false);
    assert.equal(result[group].candidates, 1);
    assert.equal(result[group].updated, 0);
    assert.deepEqual(db.store.get(path), original);
    assert.equal(db.writes.length, 0);
  });

  test(`${group} matching uid remains unchanged`, async () => {
    const path = docPath(group);
    const original = { ...originalData(group), uid: 'private-user' };
    const db = new FakeFirestore([[path, original]]);

    const result = await backfillCircleOwnership({ db, apply: true, log: silent });

    assert.equal(result[group].unchanged, 1);
    assert.equal(result[group].updated, 0);
    assert.deepEqual(db.store.get(path), original);
    assert.equal(db.writes.length, 0);
  });

  test(`${group} divergent or invalid present uid fails closed without overwriting`, async () => {
    for (const uid of ['other-user', null, undefined, 42]) {
      const path = docPath(group);
      const original = { ...originalData(group), uid };
      const db = new FakeFirestore([[path, original]]);

      await assert.rejects(
        backfillCircleOwnership({ db, apply: true, log: silent }),
        CircleOwnershipBackfillError,
      );

      assert.deepEqual(db.store.get(path), original);
      assert.equal(db.writes.length, 0);
    }
  });

  test(`${group} apply updates only uid and rerun is idempotent`, async () => {
    const path = docPath(group);
    const original = originalData(group);
    const db = new FakeFirestore([[path, original]]);

    const first = await backfillCircleOwnership({ db, apply: true, log: silent });
    const second = await backfillCircleOwnership({ db, apply: true, log: silent });

    assert.equal(first[group].updated, 1);
    assert.equal(second[group].updated, 0);
    assert.equal(second[group].unchanged, 1);
    assert.deepEqual(db.store.get(path), { ...original, uid: 'private-user' });
    assert.deepEqual(db.writes, [{ path, data: { uid: 'private-user' } }]);
  });

  test(`${group} deletion between scan and transaction does not recreate document`, async () => {
    const path = docPath(group);
    const db = new FakeFirestore([[path, originalData(group)]]);
    db.beforeRead = () => db.store.delete(path);

    const result = await backfillCircleOwnership({ db, apply: true, log: silent });

    assert.equal(result[group].deleted, 1);
    assert.equal(db.store.has(path), false);
    assert.equal(db.writes.length, 0);
  });

  test(`${group} deletion after transaction read is safe after conflict retry`, async () => {
    const path = docPath(group);
    const db = new FakeFirestore([[path, originalData(group)]]);
    db.beforeCommit = () => db.store.delete(path);

    const result = await backfillCircleOwnership({ db, apply: true, log: silent });

    assert.equal(result[group].deleted, 1);
    assert.equal(db.store.has(path), false);
    assert.equal(db.writes.length, 0);
  });

  test(`${group} ownership changed after scan fails closed on reread`, async () => {
    const path = docPath(group);
    const original = originalData(group);
    const db = new FakeFirestore([[path, original]]);
    db.beforeRead = () => db.store.set(path, { ...original, uid: 'other-user' });

    await assert.rejects(
      backfillCircleOwnership({ db, apply: true, log: silent }),
      CircleOwnershipBackfillError,
    );

    assert.deepEqual(db.store.get(path), { ...original, uid: 'other-user' });
    assert.equal(db.writes.length, 0);
  });
}

for (const path of [
  'users/private-user/progress/private-user',
  'circles/private-circle/progress/private-user',
  'circles/private-circle/challenges/private-challenge/nested/extra/progress/private-user',
  'circles/private-circle/challenges/private-challenge/ranking/private-user',
  'users/private-user/ranking/private-user',
  docPath('progress', '   '),
  docPath('ranking', 'u'.repeat(129)),
]) {
  test(`invalid ownership path case ${path.split('/').length}/${path.length} rejects before writes`, async () => {
    const db = new FakeFirestore([[path, { value: 1 }]]);

    await assert.rejects(
      backfillCircleOwnership({ db, apply: true, log: silent }),
      CircleOwnershipBackfillError,
    );

    assert.equal(db.writes.length, 0);
  });
}

test('entire page is validated before any candidate in it is updated', async () => {
  const first = docPath('progress', 'a');
  const second = docPath('progress', 'b');
  const db = new FakeFirestore([
    [first, { value: 1 }],
    [second, { uid: 'wrong-owner', value: 2 }],
  ]);

  await assert.rejects(
    backfillCircleOwnership({ db, apply: true, log: silent }),
    CircleOwnershipBackfillError,
  );

  assert.equal(db.writes.length, 0);
  assert.deepEqual(db.store.get(first), { value: 1 });
});

test('bounded pagination uses full document snapshot cursor across Circles', async () => {
  const entries = [];
  for (const group of ['progress', 'ranking']) {
    for (let index = 0; index < 5; index++) {
      entries.push([docPath(group, 'same-user', `circle-${index}`), originalData(group)]);
    }
  }
  const db = new FakeFirestore(entries);

  const result = await backfillCircleOwnership({ db, apply: true, pageSize: 2, log: silent });

  for (const group of ['progress', 'ranking']) {
    assert.equal(result[group].scanned, 5);
    assert.equal(result[group].updated, 5);
    const pages = db.pages.filter((page) => page.group === group);
    assert.deepEqual(pages.map((page) => page.paths.length), [2, 2, 1, 0]);
    assert.equal(pages[0].cursor, undefined);
    for (let index = 1; index < pages.length; index++) {
      assert.equal(pages[index].cursor, pages[index - 1].paths.at(-1));
    }
  }
  assert.equal(db.writes.length, 10);
});

test('logs contain only aggregate counters, not ownership paths or document contents', async () => {
  const messages = [];
  const db = new FakeFirestore([
    [docPath('progress'), originalData('progress')],
    [docPath('ranking'), originalData('ranking')],
  ]);

  await backfillCircleOwnership({ db, apply: true, log: (message) => messages.push(message) });

  assert.ok(messages.length > 0);
  for (const message of messages) {
    for (const secret of ['private-user', 'private-circle', 'private-challenge', 'private-content',
      'private-name', 'private-photo', 'circles/']) {
      assert.equal(message.includes(secret), false);
    }
    const parsed = JSON.parse(message);
    assert.equal(typeof parsed.apply, 'boolean');
    for (const group of ['progress', 'ranking']) {
      if (!parsed[group]) continue;
      assert.deepEqual(Object.keys(parsed[group]), [
        'scanned', 'candidates', 'updated', 'unchanged', 'deleted',
      ]);
      for (const count of Object.values(parsed[group])) assert.equal(typeof count, 'number');
    }
  }
});

test('SDK errors are sanitized and never logged with paths or credentials', async () => {
  const messages = [];
  const db = new FakeFirestore([[docPath('progress'), originalData('progress')]]);
  db.beforeRead = () => { throw new Error('private-user circles/private-circle credential-marker'); };

  await assert.rejects(
    backfillCircleOwnership({ db, apply: true, log: (message) => messages.push(message) }),
    (error) => error instanceof CircleOwnershipBackfillError &&
      error.message === 'Circle ownership backfill failed closed.',
  );

  assert.deepEqual(messages, []);
  assert.equal(db.writes.length, 0);
});

test('unbounded page size and non-boolean apply are rejected', async () => {
  for (const options of [{ pageSize: 0 }, { pageSize: 201 }, { apply: 'true' }]) {
    const db = new FakeFirestore();
    await assert.rejects(backfillCircleOwnership({ db, ...options, log: silent }), CircleOwnershipBackfillError);
    assert.equal(db.pages.length, 0);
    assert.equal(db.writes.length, 0);
  }
});
