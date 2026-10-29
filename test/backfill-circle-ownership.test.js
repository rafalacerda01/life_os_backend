import fs from 'node:fs';
import {createRequire} from 'node:module';
import {parseArgs as parseOwnershipArgs, runCli as runOwnershipCli} from '../scripts/backfill-circle-ownership.js';
import r5core from '../api/account/_deletion_control.cjs';
import { Timestamp } from 'firebase-admin/firestore';
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
    this.store = new Map();
    // Historical targets now have explicit, consistent parent/owner fixtures.
    for (const [path] of entries) if (path.startsWith('circles/')) {
      const parts = path.split('/');
      this.store.set('circles/' + parts[1], {schemaVersion: 2, adminId: 'admin'});
      this.store.set('circles/' + parts[1] + '/members/admin', {role: 'admin'});
      if (parts[2] === 'challenges') this.store.set(parts.slice(0,4).join('/'), {schemaVersion: 2});
    }
    for (const [path,data] of entries) this.store.set(path,data);
    this.writes = [];
    this.pages = [];
    this.beforeRead = null;
    this.beforeCommit = null;
  }

  doc(path) { return {path, id: path.split('/').at(-1), collection: name => ({doc: id => this.doc(path + '/' + name + '/' + id)})}; }

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
        'scanned', 'candidates', 'updated', 'unchanged', 'deleted', 'retired',
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

// Synthetic MVCC fixture: missing reads and collection ranges carry versions;
// updates are buffered and every callback retry gets a fresh snapshot.
class MaintenanceDb {
  projectId = 'demo-life-os-p1'; databaseId = '(default)';
  store = new Map(); versions = new Map(); attempts = []; commits = []; conflicts = [];
  failRead = null; ambiguousRead = null; beforeCommit = null; failCommit = null;
  put(path, data) {
    if (data === undefined) this.store.delete(path); else this.store.set(path, copyValue(data));
    for (const key of [path, 'q:' + path.slice(0, path.lastIndexOf('/'))]) this.versions.set(key, (this.versions.get(key) || 0) + 1);
  }
  doc(path) {
    const ref = {path, id: path.split('/').at(-1), collection: name => this.collection(path + '/' + name),
      get: async () => this.snapshot(ref, this.store)};
    for (const method of ['set', 'update', 'delete', 'create']) ref[method] = () => assert.fail('Direct writes forbidden');
    return ref;
  }
  collection(path, bound = Infinity, cursor = '') {
    const ref = {path, kind: 'query', doc: id => this.doc(path + '/' + id),
      orderBy: () => ref, limit: n => this.collection(path, n, cursor),
      startAfter: s => this.collection(path, bound, s.ref.path),
      count: () => ({...ref, kind: 'aggregate'}),
      get: async () => this.query(ref, this.store), bound, cursor};
    return ref;
  }
  collectionGroup(group, bound = Infinity, cursor = '') {
    const ref = {path: group, group, kind: 'query', bound, cursor,
      orderBy: () => ref, limit: n => this.collectionGroup(group, n, cursor),
      startAfter: s => this.collectionGroup(group, bound, s.ref.path), get: async () => this.query(ref, this.store)};
    return ref;
  }
  snapshot(ref, state) {return {ref, id: ref.id, exists: state.has(ref.path), data: () => copyValue(state.get(ref.path))};}
  query(ref, state) {
    const docs = [...state.keys()].sort().filter(p => (!ref.cursor || p > ref.cursor) &&
      (ref.group ? p.split('/').at(-2) === ref.group : p.startsWith(ref.path + '/') && !p.slice(ref.path.length + 1).includes('/')))
      .slice(0, ref.bound).map(p => this.snapshot(this.doc(p), state));
    return {docs, size: docs.length, empty: docs.length === 0};
  }
  async runTransaction(callback) {
    for (let attempt = 1; attempt <= 8; attempt++) {
      const state = new Map(this.store), versions = new Map(this.versions), reads = new Map(), pending = [];
      const row = {attempt, reads, pending}; this.attempts.push(row);
      const write = (type, ref, data) => pending.push({type, path: ref.path, data: copyValue(data)});
      const result = await callback({get: async ref => {
        assert.equal(pending.length, 0, 'reads must precede writes');
        const key = ref.kind ? 'q:' + ref.path : ref.path;
        reads.set(key, versions.get(key) || 0);
        if (ref.path === this.failRead) throw new Error('synthetic-private-key-token-path');
        if (ref.path === this.ambiguousRead) return {ref, exists: 'unknown', data: () => undefined};
        if (ref.kind === 'aggregate') return {data: () => ({count: this.query(ref, state).size})};
        return ref.kind ? this.query(ref, state) : this.snapshot(ref, state);
      }, create: (ref, data) => write('create', ref, data), update: (ref, data) => write('update', ref, data),
      delete: ref => write('delete', ref), set: (ref, data) => write('set', ref, data)});
      await this.beforeCommit?.(row);
      const changed = [...reads].filter(([key, version]) => (this.versions.get(key) || 0) !== version).map(([key]) => key);
      if (changed.length) {this.conflicts.push({...row, changed}); continue;}
      if (this.failCommit?.(row)) throw new Error('synthetic-private-commit-failure');
      for (const w of pending) {
        if (w.type === 'update') assert.ok(this.store.has(w.path), 'no upsert');
        if (w.type === 'create') assert.equal(this.store.has(w.path), false, 'no replace');
      }
      for (const w of pending) this.put(w.path, w.type === 'delete' ? undefined : w.type === 'update' ? {...this.store.get(w.path), ...w.data} : w.data);
      this.commits.push(row); return result;
    }
    throw new Error('synthetic-contention');
  }
}
function copyValue(value) {
  if (Array.isArray(value)) return value.map(copyValue);
  if (value && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,copyValue(v)]));
  return value;
}
const r5paths = uid => ['retired_auth_identities/' + uid, 'account_deletion_guards/' + uid,
  'account_deletion_guards/' + uid + '/control/operation'];
async function reserveReal(db, uid) {
  const binding = {projectId: db.projectId, databaseId: db.databaseId, uid};
  const controller = r5core.createController({db, binding, clock: () => Timestamp.fromMillis(1000),
    uuid: () => '12345678-1234-4234-8234-123456789abc',
    ports: {getAuthenticatedSubject: async () => binding, getAuthUser: async () => ({uid})}});
  const admission = await controller.admitBackend();
  assert.equal(admission.status, 'ADMITTED');
  return {controller, admission};
}
function seedMaintenance(kind) {
  const db = new MaintenanceDb(), uid = kind === 'challenges' ? 'admin' : 'target';
  db.put('users/' + uid, {updatedAt: 'original', marker: 'preserve'});
  db.put('users/B', {updatedAt: 'B', habitsCount: 99});
  db.put('users/B/habits/b', {keep: true});
  db.put('circles/circle', {schemaVersion: 2, adminId: 'admin'});
  db.put('circles/circle/members/admin', {role: 'admin'});
  db.put('circles/circle/challenges/challenge', {schemaVersion: 2});
  const target = kind === 'counts' ? 'users/' + uid : kind === 'challenges' ? 'circles/circle' :
    kind === 'ranking' ? 'circles/circle/ranking/' + uid : 'circles/circle/challenges/challenge/progress/' + uid;
  if (kind === 'counts') for (const col of ['habits','tasks','goals','subjects','medications','transactions']) db.put('users/' + uid + '/' + col + '/one', {keep: true});
  else if (kind !== 'challenges') db.put(target, {value: 4, untouched: 'keep'});
  db.put('circles/other', {schemaVersion: 2, adminId: 'B', keep: true});
  return {db,uid,target};
}
function storedControls(db,uid) {return r5paths(uid).map(p => [p,copyValue(db.store.get(p))]);}
const retirementCases = [
  ['PRE_AUTH',0,{version:2,state:'RESERVED',origin:'PRE_AUTH'}],
  ['AUTH_EVENT',0,{version:2,state:'RESERVED',origin:'AUTH_EVENT'}],
  ['IN_PROGRESS',1,{version:1,state:'IN_PROGRESS'}],
  ['COMPLETE',1,{version:1,state:'COMPLETE'}],
  ['expired guard',1,{version:1,state:'COMPLETE',retainUntil:Timestamp.fromMillis(1)}],
  ['parentless COMPLETE receipt',2,{version:1,state:'COMPLETE'}],
  ['REVIEW_REQUIRED',2,{version:1,state:'REVIEW_REQUIRED'}],
  ...[0,1,2].map(n => ['malformed ' + n,n,{version:999}]),
];

const invokeMaintenance = async(f,kind,apply) => backfillCircleOwnership({db:f.db,apply,log:()=>{}});
for (const kind of ["progress","ranking"]) {
  test('R6C3 ' + kind + ': active read set, idempotence, B and scope preserved', async t => {
    const f=seedMaintenance(kind), before=new Map(f.db.store);
    await invokeMaintenance(f,kind,true);
    const writes=f.db.commits.filter(r=>r.pending.length);
    assert.equal(writes.length,1); assert.equal(writes[0].pending.length,1);
    assert.equal(writes[0].pending[0].path,f.target);
    for(const p of r5paths(f.uid)) assert.ok(writes[0].reads.has(p),p);
    for(const [p,v] of before) if(p!==f.target) assert.deepEqual(f.db.store.get(p),v,p);
    assert.deepEqual(storedControls(f.db,f.uid),r5paths(f.uid).map(p=>[p,undefined]));
    await invokeMaintenance(f,kind,true);
    assert.equal(f.db.commits.filter(r=>r.pending.length).length,1);
    t.diagnostic(JSON.stringify({kind,evidence:'active',reads:[...writes[0].reads.keys()],writes:writes[0].pending.map(w=>w.path)}));
  });
  for(const [label,index,value] of retirementCases) test('R6C3 ' + kind + ': ' + label + ' denies without cleanup',async()=>{
    const f=seedMaintenance(kind); f.db.put(r5paths(f.uid)[index],value); const before=new Map(f.db.store);
    const result=await invokeMaintenance(f,kind,true);
    assert.match(JSON.stringify(result),/RETIRED|"retired":1/);
    assert.deepEqual(f.db.store,before);assert.equal(f.db.commits.some(r=>r.pending.length),false);
  });
  for(const field of ['failRead','ambiguousRead']) for(const index of [0,1,2]) test('R6C3 '+kind+': '+field+' control '+index+' is error, not retired skip',async()=>{
    const f=seedMaintenance(kind);f.db[field]=r5paths(f.uid)[index];const before=new Map(f.db.store);
    await assert.rejects(invokeMaintenance(f,kind,true),error=>!error.message.includes('synthetic-private'));
    assert.deepEqual(f.db.store,before);assert.equal(f.db.commits.length,0);
  });
  test('R6C3 '+kind+': presence cannot hide another unreadable control',async()=>{
    const f=seedMaintenance(kind);f.db.put(r5paths(f.uid)[0],{});f.db.failRead=r5paths(f.uid)[2];
    await assert.rejects(invokeMaintenance(f,kind,true));assert.equal(f.db.commits.length,0);
  });
  test('R6C3 '+kind+': dry-run reads but never writes',async()=>{
    const f=seedMaintenance(kind),before=new Map(f.db.store);await invokeMaintenance(f,kind,false);
    assert.deepEqual(f.db.store,before);assert.equal(f.db.commits.some(r=>r.pending.length),false);
  });
  test('R6C3 '+kind+': real controller wins before writer commit; retry rereads',async t=>{
    const f=seedMaintenance(kind);let reserved=false,original;
    f.db.beforeCommit=async row=>{if(reserved||!row.pending.some(w=>w.path===f.target))return;
      reserved=true;original=await reserveReal(f.db,f.uid);};
    const before=new Map(f.db.store);await invokeMaintenance(f,kind,true);
    assert.equal(reserved,true);assert.equal(f.db.conflicts.length,1);
    for(const p of r5paths(f.uid)) assert.ok(f.db.conflicts[0].changed.includes(p),p);
    for(const [p,v]of before)assert.deepEqual(f.db.store.get(p),v,p);
    assert.equal(f.db.commits.some(r=>r.pending.some(w=>w.path===f.target)),false);
    assert.ok(f.db.attempts.some(r=>r.attempt===2&&r5paths(f.uid).every(p=>r.reads.has(p))));
    const control=original.controller.originalOperation(original.admission.handle);
    assert.equal(control.scope.privateRoot,'users/'+f.uid);
    assert.equal(f.db.store.get(r5paths(f.uid)[2]).state,'IN_PROGRESS');
    t.diagnostic(JSON.stringify({kind,evidence:'real-R5-wins',conflicts:f.db.conflicts.map(r=>r.changed),commits:f.db.commits.map(r=>r.pending.map(w=>w.path))}));
  });
  test('R6C3 '+kind+': writer first, original reservation later, replay skips',async()=>{
    const f=seedMaintenance(kind);await invokeMaintenance(f,kind,true);const original=await reserveReal(f.db,f.uid);
    const operation=original.controller.originalOperation(original.admission.handle),before=new Map(f.db.store);
    await invokeMaintenance(f,kind,true);assert.deepEqual(f.db.store,before);
    assert.equal((await original.controller.admitBackend()).status,'RESUMED');
    assert.deepEqual(f.db.store.get(r5paths(f.uid)[2]),operation);
    assert.equal(f.db.commits.filter(r=>r.pending.some(w=>w.path===f.target)).length,1);
  });
  test('R6C3 '+kind+': target removed after read is never recreated',async()=>{
    const f=seedMaintenance(kind);let removed=false;
    f.db.beforeCommit=async row=>{if(!removed&&row.pending.some(w=>w.path===f.target)){removed=true;f.db.put(f.target,undefined);}};
    try {await invokeMaintenance(f,kind,true);}catch(error){assert.equal(error.message.includes('synthetic-private'),false);}
    assert.equal(removed,true);assert.equal(f.db.store.has(f.target),false);
    assert.equal(f.db.commits.some(r=>r.pending.some(w=>w.path===f.target)),false);
  });
  test('R6C3 '+kind+': failed commit preserves data; retry applies once',async()=>{
    const f=seedMaintenance(kind),before=new Map(f.db.store);
    f.db.failCommit=row=>row.pending.some(w=>w.path===f.target);
    await assert.rejects(invokeMaintenance(f,kind,true),error=>!error.message.includes('synthetic-private'));
    assert.deepEqual(f.db.store,before);f.db.failCommit=null;await invokeMaintenance(f,kind,true);
    assert.equal(f.db.commits.filter(r=>r.pending.some(w=>w.path===f.target)).length,1);
  });
  if(kind!=='counts') for(const [label,p,value]of [
    ['closed','circle_cleanup_guards/circle',{state:'SERVER_DELETING'}],
    ['incompatible marker','circle_deletions/circle',{state:'bad',circleId:'other'}],
    ['deletionState','circles/circle',{schemaVersion:2,adminId:'admin',deletionState:null}],
    ['missing owner','circles/circle',{schemaVersion:2}],
    ['owner mismatch','circles/circle/members/admin',{role:'member',uid:'other'}],
  ]) test('R6C3 '+kind+': '+label+' refuses without mutation',async()=>{
    const f=seedMaintenance(kind);f.db.put(p,value);const before=new Map(f.db.store);
    try{const result=await invokeMaintenance(f,kind,true);assert.match(JSON.stringify(result),/CONFLICT/);}catch(error){assert.equal(error.message.includes('synthetic-private'),false);}
    assert.deepEqual(f.db.store,before);assert.equal(f.db.commits.some(r=>r.pending.length),false);
  });
}

for (const kind of ["progress","ranking"]) {
  for(const index of [0,1,2]) for(const bad of ['absent-with-data','wrong-path','present-without-data']) test('R6C3 '+kind+': '+bad+' snapshot '+index+' is indeterminate',async()=>{
    const f=seedMaintenance(kind),original=f.db.snapshot.bind(f.db),control=r5paths(f.uid)[index],before=new Map(f.db.store);
    f.db.snapshot=(ref,state)=>ref.path!==control?original(ref,state):{
      ref:bad==='wrong-path'?f.db.doc('retired_auth_identities/other'):ref,
      exists:bad==='present-without-data',data:()=>bad==='absent-with-data'?{}:undefined};
    await assert.rejects(invokeMaintenance(f,kind,true));assert.deepEqual(f.db.store,before);assert.equal(f.db.commits.length,0);
  });
  if(kind!=='counts'&&kind!=='orphan') for(const path of ['circle_deletions/circle','circle_cleanup_guards/circle','circles/circle/members/admin']) test('R6C3 '+kind+': Circle fence changes before commit '+path,async()=>{
    const f=seedMaintenance(kind);let changed=false;
    f.db.beforeCommit=row=>{if(!changed&&row.pending.some(w=>w.path===f.target)){changed=true;f.db.put(path,{state:'SERVER_DELETING',role:'member'});}};
    let result,error;try{result=await invokeMaintenance(f,kind,true);}catch(e){error=e;}
    if(!error)assert.equal(result.status,'CONFLICT');
    assert.equal(changed,true);assert.equal(f.db.conflicts.length,1);assert.equal(f.db.commits.some(r=>r.pending.some(w=>w.path===f.target)),false);
  });
}

test('R6C3 ownership: CLI opt-in, project validity, retired skip and sanitized error',async()=>{
  assert.deepEqual(parseOwnershipArgs([]),{apply:false});assert.deepEqual(parseOwnershipArgs(['--apply']),{apply:true});
  for(const args of [['--unknown'],['--apply','--apply'],['--project','demo-life-os-p1']]){
    let called=false;await assert.rejects(runOwnershipCli(args,{initializeDatabase:()=>{called=true;}}));assert.equal(called,false);
  }
  for(const apply of [false,true]){
    const f=seedMaintenance('progress');await runOwnershipCli(apply?['--apply']:[],{initializeDatabase:()=>f.db,log:()=>{}});
    assert.equal(f.db.commits.some(r=>r.pending.length),apply);
  }
  const f=seedMaintenance('progress');await reserveReal(f.db,f.uid);const before=new Map(f.db.store);
  assert.equal(await runOwnershipCli(['--apply'],{initializeDatabase:()=>f.db,log:()=>{}}),1);assert.deepEqual(f.db.store,before);
  f.db.projectId='bad/project';await assert.rejects(runOwnershipCli([],{initializeDatabase:()=>f.db}));
  await assert.rejects(runOwnershipCli([],{initializeDatabase:()=>{throw Error('private-key-token');}}),{message:'Circle ownership backfill failed closed.'});
});
test('R6C3 ownership: import cannot load env, initialize Admin or create files',async t=>{
  const require=createRequire(import.meta.url),apps=require('firebase-admin/app'),read=fs.readFileSync,exists=fs.existsSync,before={...process.env};
  t.mock.method(fs,'readFileSync',function(p){assert.equal(String(p).includes('.env'),false);return read.apply(this,arguments);});
  t.mock.method(fs,'existsSync',function(p){assert.equal(String(p).includes('.env'),false);return exists.apply(this,arguments);});
  for(const method of ['writeFileSync','appendFileSync','mkdirSync'])t.mock.method(fs,method,()=>assert.fail('Import file effect'));
  for(const method of ['initializeApp','cert','applicationDefault'])t.mock.getter(apps,method,()=>()=>assert.fail('Import Admin effect'));
  await import('../scripts/backfill-circle-ownership.js?import-safety-r6c3');assert.deepEqual({...process.env},before);assert.equal(getApps().length,0);
});
