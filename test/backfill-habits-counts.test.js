import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { getApps } from 'firebase-admin/app';
import { Timestamp } from 'firebase-admin/firestore';
import r5core from '../api/account/_deletion_control.cjs';
import {backfillUserCounts, backfillHabitsCounts, parseArgs, runCli, CountsBackfillError} from '../scripts/backfill-habits-counts.js';

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

const invokeMaintenance = async(f,kind,apply) => backfillUserCounts(f.db,f.db.doc(f.target),{apply});
for (const kind of ["counts"]) {
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

test('counts import has no environment, app, credential, scan or file effects',async t=>{
  const require=createRequire(import.meta.url),apps=require('firebase-admin/app');
  const read=fs.readFileSync,exists=fs.existsSync,before={...process.env};
  t.mock.method(fs,'existsSync',function(p){assert.equal(String(p).includes('.env'),false);return exists.apply(this,arguments);});
  t.mock.method(fs,'readFileSync',function(p){assert.equal(String(p).includes('.env'),false);return read.apply(this,arguments);});
  for(const method of ['writeFileSync','appendFileSync','mkdirSync'])t.mock.method(fs,method,()=>assert.fail('Import file effect'));
  for(const method of ['initializeApp','cert','applicationDefault'])t.mock.getter(apps,method,()=>()=>assert.fail('Import Admin effect'));
  const mod=await import('../scripts/backfill-habits-counts.js?import-safety-r6c3');
  assert.equal(typeof mod.backfillHabitsCounts,'function');assert.deepEqual({...process.env},before);assert.equal(getApps().length,0);
});
test('counts CLI validates explicit project and apply before initialization',async()=>{
  assert.deepEqual(parseArgs(['--project','demo-life-os-p1']),{apply:false,projectId:'demo-life-os-p1'});
  assert.deepEqual(parseArgs(['--project','demo-life-os-p1','--apply']),{apply:true,projectId:'demo-life-os-p1'});
  for(const args of [[],['--apply'],['--project',' bad '],['--project','demo-life-os-p1','--apply','--apply'],['--unknown'],['--project','demo-life-os-p1','--project','other']]){
    let called=false;await assert.rejects(runCli(args,{initializeDatabase:()=>{called=true;throw Error('unreachable');}}),CountsBackfillError);assert.equal(called,false);
  }
});
test('counts CLI dry-run default and apply opt-in use the confirmed project',async()=>{
  for(const apply of [false,true]){
    const f=seedMaintenance('counts'),output=[];
    assert.equal(await runCli(['--project','demo-life-os-p1',...(apply?['--apply']:[])],{
      initializeDatabase:async p=>{assert.equal(p,f.db.projectId);return f.db;},log:v=>output.push(v)}),0);
    assert.equal(f.db.commits.some(r=>r.pending.length),apply);
    for(const secret of ['target','users/','private-key'])assert.equal(output.join('').includes(secret),false);
  }
});
test('counts CLI refuses wrong database and sanitizes authorization failure',async()=>{
  const f=seedMaintenance('counts');f.db.projectId='wrong-project';
  await assert.rejects(runCli(['--project','demo-life-os-p1'],{initializeDatabase:async()=>f.db}),CountsBackfillError);
  assert.equal(f.db.attempts.length,0);
  await assert.rejects(runCli(['--project','demo-life-os-p1'],{initializeDatabase:()=>{throw Error('private-key token');}}),{message:'Counts backfill failed closed.'});
});
test('all six transactional aggregate queries determine counts and updatedAt only on change',async()=>{
  const f=seedMaintenance('counts');await invokeMaintenance(f,'counts',true);
  const row=f.db.commits.find(r=>r.pending.length),root=f.db.store.get(f.target);
  for(const col of ['habits','tasks','goals','subjects','medications','transactions']){
    assert.ok(row.reads.has('q:'+f.target+'/'+col));assert.equal(root[col+'Count'],1);
  }
  assert.equal(root.marker,'preserve');assert.equal(root.updatedAt.constructor.name,'ServerTimestampTransform');
  await invokeMaintenance(f,'counts',true);assert.equal(f.db.commits.filter(r=>r.pending.length).length,1);
});
test('counts range changes before commit force recomputation, including previously empty collections',async()=>{
  const f=seedMaintenance('counts');f.db.put(f.target+'/tasks/one',undefined);let changed=false;
  f.db.beforeCommit=row=>{if(!changed&&row.pending.length){changed=true;f.db.put(f.target+'/tasks/new',{keep:true});f.db.put(f.target+'/habits/two',{keep:true});}};
  await invokeMaintenance(f,'counts',true);
  assert.equal(f.db.conflicts.length,1);assert.equal(f.db.store.get(f.target).tasksCount,1);assert.equal(f.db.store.get(f.target).habitsCount,2);
  assert.equal(f.db.commits.filter(r=>r.pending.length).length,1);
});
test('counts UID mismatch, missing root, invalid apply and query failure never upsert',async()=>{
  const f=seedMaintenance('counts');f.db.put(f.target,{uid:'other'});
  await assert.rejects(invokeMaintenance(f,'counts',true));f.db.put(f.target,undefined);
  assert.equal((await invokeMaintenance(f,'counts',true)).status,'MISSING');
  await assert.rejects(backfillUserCounts(f.db,{path:'users/other',id:'target'},{apply:true}));
  await assert.rejects(backfillUserCounts(f.db,f.db.doc(f.target),{apply:'true'}));
  f.db.put(f.target,{});f.db.failRead=f.target+'/habits';await assert.rejects(invokeMaintenance(f,'counts',true));
  assert.equal(f.db.commits.some(r=>r.pending.length),false);
});
test('counts bounded pagination, partial failure and safe rerun preserve prior commits',async()=>{
  const db=new MaintenanceDb();for(const uid of ['a','b','c'])db.put('users/'+uid,{});
  db.failRead='users/b/habits';
  await assert.rejects(backfillHabitsCounts({db,apply:true,pageSize:1,log:()=>{}}));
  assert.equal(db.store.get('users/a').habitsCount,0);assert.deepEqual(db.store.get('users/b'),{});assert.deepEqual(db.store.get('users/c'),{});
  db.failRead=null;const result=await backfillHabitsCounts({db,apply:true,pageSize:1,log:()=>{}});
  assert.equal(result.APPLIED,2);assert.equal(result.UNCHANGED,1);
  assert.equal(db.commits.filter(r=>r.pending.some(w=>w.path==='users/a')).length,1);
  for(const options of [{pageSize:0},{pageSize:201},{apply:'yes'}])await assert.rejects(backfillHabitsCounts({db,...options}));
});

for (const kind of ["counts"]) {
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

test('R6C3 counts: retired CLI exits nonzero without claiming applied or cleaned',async()=>{
  const f=seedMaintenance('counts');await reserveReal(f.db,f.uid);const before=new Map(f.db.store),output=[];
  assert.equal(await runCli(['--project','demo-life-os-p1','--apply'],{initializeDatabase:()=>f.db,log:v=>output.push(JSON.parse(v))}),1);
  assert.equal(output[0].counts.RETIRED,1);assert.equal(output[0].counts.APPLIED,1); // B is an independent active UID.
  assert.deepEqual(f.db.store.get(f.target),before.get(f.target));assert.deepEqual(storedControls(f.db,f.uid),r5paths(f.uid).map(p=>[p,before.get(p)]));
});
