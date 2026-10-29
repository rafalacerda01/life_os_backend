import assert from 'node:assert/strict';
import test from 'node:test';
import {AsyncLocalStorage} from 'node:async_hooks';
import {getApps, initializeApp, getApp} from 'firebase-admin/app';
import {getFirestore, Timestamp} from 'firebase-admin/firestore';
import {validateStudyCardCreatePayload, studyCardCreateFingerprint, REVIEW_CARD_CREATE_MAX_BYTES} from '../api/study/_sync_card_create.js';
// Executed only through the external offline preload; no certificate/ADC bootstrap.
if (!getApps().length) initializeApp({projectId:'demo-life-os-p1'});
assert.equal(getApp().options.projectId,'demo-life-os-p1');
const firestore=getFirestore();
const {syncHandler}=await import('../api/sync.js');
const context=new AsyncLocalStorage();
const now=()=>Timestamp.fromMillis(Date.parse('2026-10-28T13:00:00Z'));
// Reuse the existing R6C1 MVCC fixture implementation; this is not SDK/IAM proof.
function clone(value) {
  if (value instanceof Timestamp) return value;
  if (value instanceof Date) return new Date(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]));
  return value;
}
function stored(value) {
  if (value?.constructor?.name === 'ServerTimestampTransform') return now();
  if (Array.isArray(value)) return value.map(stored);
  if (value && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stored(v)]));
  return clone(value);
}
const scalar = x => x instanceof Date ? x.getTime() : x instanceof Timestamp ? x.toMillis() : x;
const compare = (a, op, b) => op === '==' ? scalar(a) === scalar(b) : op === '>' ? scalar(a) > scalar(b) :
  op === '>=' ? scalar(a) >= scalar(b) : op === '<' ? scalar(a) < scalar(b) : op === '<=' ? scalar(a) <= scalar(b) : false;

// Optimistic MVCC: stable snapshots, missing-document and query-range versions,
// buffered atomic writes, preconditions, reads-before-writes and actual retries.
// It does not emulate Firestore's pessimistic locks or cloud IAM.
class MemoryDb {
  projectId = 'demo-life-os-p1'; databaseId = '(default)';
  docs = new Map(); versions = new Map(); attempts = []; conflicts = []; commits = [];
  hooks = {}; failRead = null; malformedRead = null; directWrites = 0; nextId = 0;
  put(path, data) {
    if (data === undefined) this.docs.delete(path); else this.docs.set(path, clone(data));
    for (const key of [path, 'q:' + path.slice(0, path.lastIndexOf('/'))]) this.versions.set(key, (this.versions.get(key) || 0) + 1);
  }
  doc(path) {
    const ref = {path, id: path.split('/').at(-1), collection: name => this.collection(path + '/' + name),
      get: async () => this.snapshot(ref, this.docs),
      listCollections: async () => {
        const names = new Set([...this.docs.keys()].filter(p => p.startsWith(path + '/')).map(p => p.slice(path.length + 1).split('/')[0]));
        return [...names].sort().map(name => this.collection(path + '/' + name));
      }};
    for (const method of ['set', 'create', 'update', 'delete']) ref[method] = () => {this.directWrites++; throw new Error('DIRECT_WRITE_FORBIDDEN');};
    return ref;
  }
  collection(path, filters = [], bound = Infinity, cursor = null) {
    const ref = {path, kind: 'query', filters, bound, cursor,
      doc: (id = `generated-${++this.nextId}`) => this.doc(path + '/' + id),
      where: (field, op, value) => this.collection(path, [...filters, {field, op, value}], bound, cursor),
      limit: n => this.collection(path, filters, n, cursor), orderBy: () => ref,
      startAfter: snapshot => this.collection(path, filters, bound, snapshot.ref.path),
      get: async () => this.querySnapshot(ref, this.docs),
      listDocuments: async () => {
        const ids = new Set([...this.docs.keys()].filter(p => p.startsWith(path + '/')).map(p => p.slice(path.length + 1).split('/')[0]));
        return [...ids].sort().map(id => this.doc(path + '/' + id));
      }};
    return ref;
  }
  snapshot(ref, state) {return {ref, id: ref.id, exists: state.has(ref.path), data: () => clone(state.get(ref.path))};}
  querySnapshot(ref, state) {
    const docs = [...state.keys()].sort().filter(p => p.startsWith(ref.path + '/') && !p.slice(ref.path.length + 1).includes('/') &&
      (!ref.cursor || p > ref.cursor) && ref.filters.every(f => compare(state.get(p)?.[f.field], f.op, f.value)))
      .slice(0, ref.bound).map(p => this.snapshot(this.doc(p), state));
    return {docs, size: docs.length, empty: docs.length === 0};
  }
  async runTransaction(callback) {
    const label = context.getStore();
    for (let attempt = 1; attempt <= 10; attempt++) {
      const state = new Map([...this.docs].map(([p, data]) => [p, clone(data)]));
      const versions = new Map(this.versions), reads = new Map(), pending = [];
      const record = {label, attempt, reads, pending, applied: false}; this.attempts.push(record);
      const write = (type, ref, data, options) => pending.push({type, path: ref.path, data: clone(data), options});
      let result;
      try {
        result = await callback({
          get: async ref => {
            assert.equal(pending.length, 0, 'all reads precede writes');
            const key = ref.kind === 'query' ? 'q:' + ref.path : ref.path;
            reads.set(key, versions.get(key) || 0);
            if (this.failRead === ref.path) throw Object.assign(new Error('synthetic-private-read-failure'), {code: 'UNAVAILABLE'});
            if (this.malformedRead === ref.path) return {exists: 'unknown', data: () => undefined};
            const result = ref.kind === 'query' ? this.querySnapshot(ref, state) : this.snapshot(ref, state);
            await this.hooks.afterRead?.({...record, ref});
            return result;
          },
          async getAll(...refs) {return Promise.all(refs.map(ref => this.get(ref)));},
          create: (ref, data) => write('create', ref, data), set: (ref, data, options) => write('set', ref, data, options),
          update: (ref, data) => write('update', ref, data), delete: ref => write('delete', ref),
        });
      } catch (error) {record.error = error; throw error;}
      await this.hooks.beforeCommit?.(record);
      const changed = [...reads].filter(([p, version]) => (this.versions.get(p) || 0) !== version).map(([p]) => p);
      if (changed.length) {this.conflicts.push({...record, changed}); continue;}
      for (const w of pending) {
        if (w.type === 'create') assert.equal(this.docs.has(w.path), false, 'create cannot replace');
        if (w.type === 'update') assert.equal(this.docs.has(w.path), true, 'update cannot recreate');
      }
      for (const w of pending) this.put(w.path, w.type === 'delete' ? undefined :
        w.type === 'update' || w.options?.merge ? {...this.docs.get(w.path), ...stored(w.data)} : stored(w.data));
      record.applied = true; this.commits.push(record);
      await this.hooks.afterCommit?.(record);
      return result;
    }
    throw new Error('MVCC_RETRY_EXHAUSTED');
  }
}
function gate() {
  const reached = Promise.withResolvers(), release = Promise.withResolvers();
  return {reached: reached.promise, release: release.resolve, async hold() {reached.resolve(); await release.promise;}};
}

const UID = 'uid-a', OTHER = 'uid-b';
const body = (extra = {}) => ({operation: 'create_review_card', version: 1,
  cardId: 'card-1', subjectId: 'subject-1', question: 'Q', answer: 'A',
  createdAt: '2026-10-28T12:34:56.123456Z', ...extra});
const paths = (uid = UID, cardId = 'card-1') => ({root: `users/${uid}`,
  card: `users/${uid}/review_queue/${cardId}`, receipt: `users/${uid}/study_card_create_receipts/${cardId}`,
  subject: `users/${uid}/subjects/subject-1`, info: `users/${uid}/study_info/main`,
  tombstone: `users/${uid}/sync_tombstones/subjects__subject-1`});
const controls = uid => [`account_deletion_guards/${uid}`, `retired_auth_identities/${uid}`,
  `account_deletion_guards/${uid}/control/operation`];
function fixture(t, uid = UID) {
  const db = new MemoryDb();
  for (const owner of [UID, OTHER]) {
    db.put(paths(owner).root, {uid: owner, isPremium: false, xp: 0, subjectsCount: 1});
    db.put(paths(owner).subject, {title: 'Synthetic', cardsToReview: 0, progress: 0, streakDays: 0});
  }
  t.mock.method(firestore, 'collection', db.collection.bind(db));
  t.mock.method(firestore, 'runTransaction', db.runTransaction.bind(db));
  const logs = [], calls = {auth: [], app: [], rate: []};
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  const invoke = async (payload = body(), overrides = {}, headers = {}) => {
    const response = {statusCode: 200, setHeader() {}, status(code) {this.statusCode = code; return this;},
      json(value) {this.body = value; return this;}, end() {return this;}};
    await syncHandler({method: 'POST', headers: {authorization: 'Bearer synthetic-token',
      'x-firebase-appcheck': 'synthetic-app-check', ...headers}, body: payload}, response, {
      verifyIdToken: async (_, revoked) => {calls.auth.push(revoked); return {uid};},
      verifyAppCheckToken: async () => {calls.app.push(true); return {appId: 'synthetic'};},
      checkRateLimit: async args => {calls.rate.push(args.uid); return true;}, ...overrides});
    return response;
  };
  return {db, invoke, logs, calls, uid};
}
function ack(response, payload = body(), uid = UID, outcome = 'APPLIED') {
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {success: true, operation: 'create_review_card', version: 1,
    uid, operationId: payload.cardId, fingerprint: studyCardCreateFingerprint(uid, payload), outcome, effectsCommitted: true});
}
function denied(response, code, status) {
  assert.equal(response.statusCode, status); assert.equal(response.body.code, code);
  assert.equal(Object.hasOwn(response.body, 'success'), false);
  assert.equal(Object.hasOwn(response.body, 'effectsCommitted'), false);
}
test('codec fixed ASCII and Unicode framing vectors are deterministic across JSON order', () => {
  assert.equal(studyCardCreateFingerprint(UID, body()), 'd3ee2953c47ce71eb071d3e27447c1689359ff7c913c8666329991efce20ca99');
  const unicode = body({question: 'á:|🌊', answer: 'e\u0301😀', createdAt: '2026-10-28T12:34:56.123Z'});
  assert.equal(studyCardCreateFingerprint(UID, unicode), '29bcc30a91ff89dbe17d5a2669cc116120380054db85c9cbeb20db80394e1ff6');
  assert.equal(studyCardCreateFingerprint(UID, Object.fromEntries(Object.entries(unicode).reverse())), studyCardCreateFingerprint(UID, unicode));
  for (const extra of [{question: 'q'}, {answer: 'a'}, {subjectId: 'subject-2'}, {cardId: 'card-2'},
    {createdAt: '2026-10-28T12:34:56.123457Z'}]) assert.notEqual(studyCardCreateFingerprint(UID, body(extra)), studyCardCreateFingerprint(UID, body()));
  assert.notEqual(studyCardCreateFingerprint(OTHER, body()), studyCardCreateFingerprint(UID, body()));
  assert.notEqual(studyCardCreateFingerprint(UID, body({question:'é'})), studyCardCreateFingerprint(UID, body({question:'e\u0301'})));
  assert.notEqual(studyCardCreateFingerprint(UID, body({question:'a', answer:'b:c'})), studyCardCreateFingerprint(UID, body({question:'a:b', answer:'c'})));
});
for (const value of ['2026-10-28T12:34:56', '2026-10-28T12:34:56.123+00:00',
  '2026-10-28T12:34:56.1234567Z', '2026-10-28T12:34:56.123000Z', '2026-10-28T12:34:56Z',
  '2026-02-29T00:00:00.000Z', '2026-10-28T24:00:00.000Z', '2026-10-28T12:34:60.000Z',
  '0000-01-01T00:00:00.000Z', '2026-13-01T00:00:00.000Z']) {
  test('noncanonical/invalid time is rejected: ' + value, () => assert.equal(validateStudyCardCreatePayload(body({createdAt:value})).valid, false));
}
test('UTC millisecond/microsecond precision and years 1..99 are preserved', () => {
  for (const value of ['0001-01-01T00:00:00.000Z', '0099-12-31T23:59:59.999999Z',
    '2024-02-29T00:00:00.000001Z', '9999-12-31T23:59:59.999999Z']) assert.equal(validateStudyCardCreatePayload(body({createdAt:value})).valid, true);
  const result = validateStudyCardCreatePayload(body());
  assert.equal(result.createdAt.nanoseconds, 123456000);
  assert.equal(result.createdAt.seconds, Date.parse('2026-10-28T12:34:56Z') / 1000);
});
for (const [field,value] of [['question','\ud800'],['answer','\udc00'],['cardId','a/b'],['cardId','..'],
  ['cardId',' a'],['cardId','á'],['cardId','a'.repeat(129)],['subjectId','x/y'],['question',' '],['version',true],['version',2]]) {
  test('payload/Unicode/ID rejects ' + field + ' ' + JSON.stringify(value), async t => {
    const f = fixture(t), before = new Map(f.db.docs);
    denied(await f.invoke(body({[field]:value})), 'INVALID_PAYLOAD', 400);
    assert.deepEqual(f.db.docs, before); assert.equal(f.db.attempts.length, 0);
  });
}
for (const field of ['uid','claims','isPremium','reviewQueue','operationId','__proto__']) {
  test('extra administrative or identity field is denied: ' + field, async t => {
    const f = fixture(t), payload = body(); Object.defineProperty(payload, field, {value: OTHER, enumerable:true});
    denied(await f.invoke(payload), 'INVALID_PAYLOAD', 400); assert.equal(f.db.attempts.length, 0);
  });
}
test('effective payload byte limit works without Content-Length and on exact boundary', async t => {
  const start = body(), base = Buffer.byteLength(JSON.stringify(start));
  const exact = body({question:'x'.repeat(REVIEW_CARD_CREATE_MAX_BYTES-base+1)});
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), REVIEW_CARD_CREATE_MAX_BYTES);
  assert.equal(validateStudyCardCreatePayload(exact).valid, true);
  const f = fixture(t);
  denied(await f.invoke({...exact,question:exact.question+'x'}), 'REVIEW_CREATE_PAYLOAD_TOO_LARGE', 413);
  const multi = body({question:'🌊'.repeat(132000)});
  assert.ok(JSON.stringify(multi).length < REVIEW_CARD_CREATE_MAX_BYTES);
  denied(await f.invoke(multi), 'REVIEW_CREATE_PAYLOAD_TOO_LARGE', 413);
  assert.equal(f.db.attempts.length,0);
});
test('fresh create commits exactly four account effects; preserves all unrelated state', async t => {
  const f=fixture(t), p=paths(), originalRoot=clone(f.db.docs.get(p.root)), originalOther=new Map([...f.db.docs].filter(([key])=>key.startsWith(paths(OTHER).root)));
  ack(await f.invoke());
  const tx=f.db.commits.find(tx=>tx.pending.length);
  assert.deepEqual(tx.pending.map(w=>w.path), [p.card,p.info,p.subject,p.receipt]);
  for(const ref of [...controls(UID),p.root,p.card,p.receipt,p.subject,p.info,p.tombstone])assert.ok(tx.reads.has(ref),ref);
  assert.equal(f.db.docs.get(p.info).reviewQueue,1);assert.equal(f.db.docs.get(p.subject).cardsToReview,1);
  assert.equal(f.db.docs.get(p.card).createdAt.nanoseconds,123456000);
  const receipt=f.db.docs.get(p.receipt);
  assert.equal(receipt.state,'APPLIED');assert.equal(receipt.uid,UID);assert.equal(receipt.operationId,'card-1');
  assert.ok(receipt.appliedAt instanceof Timestamp);assert.equal(Object.hasOwn(receipt,'question'),false);assert.equal(Object.hasOwn(receipt,'retainUntil'),false);
  assert.deepEqual(f.db.docs.get(p.root),originalRoot);for(const [path,data]of originalOther)assert.deepEqual(f.db.docs.get(path),data);
  assert.deepEqual(f.calls.auth,[true]);assert.deepEqual(f.calls.rate,[UID]);assert.equal(f.calls.app.length,1);assert.equal(f.db.directWrites,0);
});
test('normal existing counters increment once and unrelated Study/Subject fields remain', async t => {
  const f=fixture(t),p=paths();f.db.put(p.info,{reviewQueue:7,progress:0.5,streak:3});f.db.put(p.subject,{cardsToReview:5,title:'Subject',progress:0.8,streakDays:4});
  ack(await f.invoke());assert.deepEqual(f.db.docs.get(p.info),{reviewQueue:8,progress:0.5,streak:3});
  assert.deepEqual(f.db.docs.get(p.subject),{cardsToReview:6,title:'Subject',progress:0.8,streakDays:4});
});
for(const target of ['subject','info'])for(const value of [undefined,-1,1.5,'1',null,Number.MAX_SAFE_INTEGER]) {
  test('malformed existing '+target+' counter '+String(value)+' is never initialized/repaired',async t=>{
    const f=fixture(t),p=paths();f.db.put(p[target],{[target==='subject'?'cardsToReview':'reviewQueue']:value});const before=new Map(f.db.docs);
    denied(await f.invoke(),'REVIEW_CREATE_STATE_INVALID',503);assert.deepEqual(f.db.docs,before);assert.equal(f.db.commits.length,0);
  });
}
test('ACK waits for actual known commit rather than the callback result',async t=>{
  const f=fixture(t),hold=gate();t.after(hold.release);f.db.hooks.beforeCommit=()=>hold.hold();let finished=false;
  const execution=f.invoke().then(r=>{finished=true;return r;});await Promise.race([hold.reached,execution.then(()=>assert.fail('commit barrier not reached'))]);
  assert.equal(finished,false);assert.equal(f.db.docs.has(paths().card),false);hold.release();ack(await execution);
});
for(const after of [false,true])test('failure '+(after?'after applied commit':'before commit')+' is unconfirmed, sanitized and retryable',async t=>{
  const f=fixture(t),p=paths(),before=new Map(f.db.docs);let injected=false;
  f.db.hooks[after?'afterCommit':'beforeCommit']=row=>{if(!injected&&row.pending.length){injected=true;throw new Error('PRIVATE-CONTENT-TOKEN-DO-NOT-EXPOSE');}};
  const response=await f.invoke();denied(response,'REVIEW_CREATE_UNCONFIRMED',500);
  assert.doesNotMatch(JSON.stringify({response,logs:f.logs}),/PRIVATE-CONTENT|stackTrace|\bBearer\b/);
  if(!after)assert.deepEqual(f.db.docs,before);else assert.equal(f.db.docs.get(p.info).reviewQueue,1);
  f.db.hooks={};ack(await f.invoke(),body(),UID,after?'REPLAYED':'APPLIED');
  assert.equal(f.db.docs.get(p.info).reviewQueue,1);assert.equal(f.db.docs.get(p.subject).cardsToReview,1);
  assert.equal(f.db.commits.filter(tx=>tx.pending.length).length,1);
});
test('valid replay observes R5 read set, not current aggregate counts or missing removed card',async t=>{
  const f=fixture(t),p=paths();ack(await f.invoke());f.db.put(p.card,undefined);f.db.put(p.subject,undefined);f.db.put(p.tombstone,{deletedAt:now()});f.db.put(p.info,{reviewQueue:0});
  const before=new Map(f.db.docs);ack(await f.invoke(),body(),UID,'REPLAYED');assert.deepEqual(f.db.docs,before);
  const replay=f.db.commits.at(-1);assert.equal(replay.pending.length,0);for(const ref of [...controls(UID),p.root,p.receipt])assert.ok(replay.reads.has(ref));
});
for(const partial of ['both absent','one applied','both applied'])test('legacy existing card without receipt remains unproven: '+partial,async t=>{
  const f=fixture(t),p=paths();f.db.put(p.card,{subjectId:'subject-1',question:'Q',answer:'A',createdAt:now()});
  if(partial!=='both absent')f.db.put(p.info,{reviewQueue:1});if(partial==='both applied')f.db.put(p.subject,{cardsToReview:1});
  const before=new Map(f.db.docs);denied(await f.invoke(),'REVIEW_CREATE_LEGACY_UNVERIFIED',409);assert.deepEqual(f.db.docs,before);assert.equal(f.db.docs.has(p.receipt),false);
});
for(const key of ['version','uid','operation','operationId','subjectId','payloadFingerprint','state','appliedAt','cardCreated','reviewQueueDelta','cardsToReviewDelta'])test('closed receipt missing '+key+' is not repaired',async t=>{
  const f=fixture(t),p=paths();ack(await f.invoke());const receipt=clone(f.db.docs.get(p.receipt));delete receipt[key];f.db.put(p.receipt,receipt);const before=new Map(f.db.docs);
  denied(await f.invoke(),'REVIEW_CREATE_RECEIPT_INVALID',503);assert.deepEqual(f.db.docs,before);
});
for(const [key,value]of [['version',2],['uid',OTHER],['operation','apply_study_review'],['operationId','other'],['state','PENDING'],['appliedAt',null],['cardCreated',false],['reviewQueueDelta',0],['cardsToReviewDelta',2],['unexpected',true]])test('invalid receipt '+key+' never ACKs',async t=>{
  const f=fixture(t),p=paths();ack(await f.invoke());f.db.put(p.receipt,{...f.db.docs.get(p.receipt),[key]:value});const before=new Map(f.db.docs);
  denied(await f.invoke(),'REVIEW_CREATE_RECEIPT_INVALID',503);assert.deepEqual(f.db.docs,before);
});
test('same identity different payload conflicts without changing receipt/counters/card',async t=>{
  const f=fixture(t);ack(await f.invoke());const before=new Map(f.db.docs);
  denied(await f.invoke(body({question:'Different'})),'REVIEW_CREATE_FINGERPRINT_CONFLICT',409);assert.deepEqual(f.db.docs,before);
});
for(const replay of [false,true])test('missing root never authorizes create or replay; replay='+replay,async t=>{
  const f=fixture(t),p=paths();if(replay)ack(await f.invoke());f.db.put(p.root,undefined);const before=new Map(f.db.docs);
  denied(await f.invoke(),'REVIEW_CREATE_ROOT_UNAVAILABLE',503);assert.deepEqual(f.db.docs,before);
});
for(const mode of ['missing','tombstone'])test('Subject '+mode+' never resurrects',async t=>{
  const f=fixture(t),p=paths();if(mode==='missing')f.db.put(p.subject,undefined);else f.db.put(p.tombstone,{});const before=new Map(f.db.docs);
  denied(await f.invoke(),mode==='missing'?'REVIEW_CREATE_SUBJECT_UNAVAILABLE':'REVIEW_CREATE_SUBJECT_TOMBSTONED',409);assert.deepEqual(f.db.docs,before);
});
for(const same of [false,true])test('concurrent '+(same?'same identity':'different IDs')+' produces no duplicate increments',async t=>{
  const f=fixture(t);const a=body(),b=body({cardId:same?'card-1':'card-2'});const results=await Promise.all([f.invoke(a),f.invoke(b)]);
  assert.equal(results.filter(r=>r.body.outcome==='APPLIED').length,same?1:2);assert.equal(results.filter(r=>r.body.outcome==='REPLAYED').length,same?1:0);
  assert.ok(results.every(r=>r.statusCode===200));const count=same?1:2;
  assert.equal(f.db.docs.get(paths().info).reviewQueue,count);assert.equal(f.db.docs.get(paths().subject).cardsToReview,count);
  assert.equal(f.db.commits.filter(r=>r.pending.length).length,count);assert.ok(f.db.conflicts.length>0);
  for(const tx of f.db.attempts)for(const p of controls(UID))assert.ok(tx.reads.has(p));
});
test('another authenticated UID has independent state; cannot reuse A receipt',async t=>{
  const f=fixture(t);ack(await f.invoke());const aReceipt=clone(f.db.docs.get(paths().receipt)),aBefore=new Map([...f.db.docs].filter(([p])=>p.startsWith('users/'+UID)));
  const authB={verifyIdToken:async(_,revoked)=>{assert.equal(revoked,true);return{uid:OTHER};}};
  f.db.put(paths(OTHER).receipt,aReceipt);denied(await f.invoke(body(),authB),'REVIEW_CREATE_RECEIPT_INVALID',503);
  f.db.put(paths(OTHER).receipt,undefined);ack(await f.invoke(body(),authB),body(),OTHER);
  assert.notEqual(f.db.docs.get(paths(OTHER).receipt).payloadFingerprint,aReceipt.payloadFingerprint);
  for(const [p,v]of aBefore)assert.deepEqual(f.db.docs.get(p),v);
});
for(const field of ['verifyAppCheckToken','verifyIdToken'])test('existing '+field+' failure precedes transaction',async t=>{
  const f=fixture(t);const response=await f.invoke(body(),{[field]:async()=>{throw new Error('PRIVATE-CREDENTIAL');}});
  assert.equal(response.statusCode,401);assert.equal(f.db.attempts.length,0);assert.doesNotMatch(JSON.stringify(response.body),/PRIVATE-CREDENTIAL/);
});
test('captured UID remains bound across the rate-limit await',async t=>{
  const f=fixture(t),decoded={uid:UID};ack(await f.invoke(body(),{verifyIdToken:async()=>decoded,checkRateLimit:async()=>{decoded.uid=OTHER;return true;}}));
  assert.equal(f.db.docs.has(paths(OTHER).receipt),false);
});

for(const kind of ['root','receipt','subject','info'])test('business read failure '+kind+' is sanitized and never ACKs',async t=>{
  const f=fixture(t),p=paths(),before=new Map(f.db.docs);f.db.failRead=p[kind];
  denied(await f.invoke(),'REVIEW_CREATE_UNCONFIRMED',500);assert.deepEqual(f.db.docs,before);assert.equal(f.db.commits.length,0);
  assert.doesNotMatch(JSON.stringify(f.logs),/synthetic-private-read-failure/);
});
for(const data of [{uid:OTHER},[],null])test('root schema/UID cannot authorize another account: '+JSON.stringify(data),async t=>{
  const f=fixture(t);f.db.put(paths().root,data);const before=new Map(f.db.docs);
  denied(await f.invoke(),'REVIEW_CREATE_ROOT_UNAVAILABLE',503);assert.deepEqual(f.db.docs,before);
});
for(const [target,patch]of [['subject',{progress:2}],['subject',{streakDays:-1}],['subject',{hasExam:true,examDate:null}],
  ['info',{progress:NaN}],['info',{lastStudyDate:new Date(NaN)}]])test('known '+target+' schema is not repaired: '+JSON.stringify(patch),async t=>{
  const f=fixture(t),p=paths();f.db.put(p.info,{reviewQueue:0});f.db.put(p[target],{...f.db.docs.get(p[target]),...patch});const before=new Map(f.db.docs);
  denied(await f.invoke(),'REVIEW_CREATE_STATE_INVALID',503);assert.deepEqual(f.db.docs,before);
});
test('concurrent different payloads for one identity cannot overwrite the winning receipt',async t=>{
  const f=fixture(t);const results=await Promise.all([f.invoke(),f.invoke(body({answer:'different'}))]);
  assert.equal(results.filter(r=>r.statusCode===200).length,1);assert.equal(results.filter(r=>r.statusCode===409&&r.body.code==='REVIEW_CREATE_FINGERPRINT_CONFLICT').length,1);
  assert.equal(f.db.docs.get(paths().info).reviewQueue,1);assert.equal(f.db.docs.get(paths().subject).cardsToReview,1);assert.equal(f.db.commits.filter(r=>r.pending.length).length,1);
});
