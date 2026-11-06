"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {Timestamp}=require("firebase-admin/firestore");
const manifest=require("../api/account/_cleanup_manifest.cjs");
const control=require("../api/account/_deletion_control.cjs");
const {MemoryFirestore}=require("./account-cleanup-memory.cjs");
const UID="synthetic-a",ROOT="users/"+UID,OTHER="users/synthetic-b";
const ID="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
async function fixture(count=3){
  const db=new MemoryFirestore();
  db.put(ROOT,{owner:"original"});
  for(let i=0;i<count;i++)db.put(ROOT+"/notes/n"+i,{old:i});
  db.put(OTHER,{keep:true});db.put(OTHER+"/notes/private",{keep:true});
  let present=true;
  const c=control.createController({db,binding:{projectId:db.projectId,databaseId:db.databaseId,uid:UID},
    clock:()=>Timestamp.fromMillis(100000),uuid:()=>ID,ports:{
      getAuthenticatedSubject:async()=>({projectId:db.projectId,databaseId:db.databaseId,uid:UID}),
      getAuthUser:async()=>{if(present)return{uid:UID};throw Object.assign(Error("absent"),{code:"auth/user-not-found"});},
    }});
  const a=await c.admitBackend(),operation=c.originalOperation(a.handle);
  const options={db,operation,ref:db.doc(ROOT),
    assertOperation:tx=>c.assertOperationTransaction(tx,a.handle),
    authorizeCapture:async()=>present,beforeEffect:async()=>{}};
  return{db,c,a,options,absent:()=>{present=false;},
    header:manifest.refs(db,operation,ROOT).header.path};
}
function other(f){
  assert.deepEqual(f.db.docs.get(OTHER),{keep:true});
  assert.deepEqual(f.db.docs.get(OTHER+"/notes/private"),{keep:true});
}
const review=p=>assert.rejects(p,e=>e.code==="ACCOUNT_CLEANUP_REVIEW_REQUIRED");
function oldPaths(f){return[...f.db.docs.keys()].filter(p=>p===ROOT||p.startsWith(ROOT+"/"));}

// Contract-model tests of an already admitted R5 operation. They grant no
// real identity authority; genuine genesis is exercised in the Emulator suite.
async function partitioned(count=3){const f=await fixture(count);f.options.partitionedCapture=true;return f;}
async function confirmed(f){await manifest.authOutcome(f.options,'NOT_REQUESTED','DISPATCHED');await manifest.authOutcome(f.options,'DISPATCHED','CONFIRMED');f.absent();}
test('partitioned capture exceeds 4000 documents, deletes finite pages, preserves B and DENY',async()=>{
 const f=await partitioned(4101),deny=JSON.stringify(f.db.docs.get('retired_auth_identities/'+UID));
 const h=await manifest.captureTree(f.options);assert.equal(h.version,3);assert.ok(h.pageCount>101);
 assert.equal(oldPaths(f).length,4102);await confirmed(f);await manifest.removeTree(f.options);
 assert.deepEqual(oldPaths(f),[]);assert.equal(f.db.docs.get(f.header).state,'COMPLETE');other(f);
 assert.equal(JSON.stringify(f.db.docs.get('retired_auth_identities/'+UID)),deny);
 for(const ws of f.db.commits){assert.ok(ws.length<=manifest.PAGE+2);for(const w of ws)if(w.path.includes('/pages/'))assert.ok(Buffer.byteLength(JSON.stringify(w.data))<manifest.CAPTURE_PAGE_BYTES+4096);}
});
test('partitioned inventory above 4 MiB seals without an oversized page or header',async()=>{
 const f=await partitioned(0);for(let i=0;i<1101;i++)f.db.put(ROOT+'/a/'+('x'.repeat(1000)+i)+'/b/'+('y'.repeat(1000))+'/c/'+('z'.repeat(1000))+'/d/'+('w'.repeat(1000)),{old:true});
 const h=await manifest.captureTree(f.options);assert.equal(h.version,3);assert.ok(h.inventoryBytes>4*1024*1024);assert.ok(Buffer.byteLength(JSON.stringify(h))<4096);
 await confirmed(f);await manifest.removeTree(f.options);assert.deepEqual(oldPaths(f),[]);other(f);
});
for(const applied of [false,true])test('partition capture restart reuses exact original versions; lost page response applied='+applied,async()=>{
 const f=await partitioned(85);let once=0;f.db.hooks[applied?'afterCommit':'beforeCommit']=({writes})=>{if(!once&&writes.some(w=>w.type==='create'&&w.path.includes('/pages/'))){once++;throw Error('lost capture reply');}};
 await assert.rejects(manifest.captureTree(f.options),/lost capture reply/);const original=f.db.docs.get(f.header).rootCommitment;
 assert.equal(f.db.docs.get(f.header).state,'CAPTURING');assert.equal(oldPaths(f).length,86);f.db.hooks={};
 await manifest.captureTree(f.options);assert.equal(f.db.docs.get(f.header).rootCommitment,original);await confirmed(f);await manifest.removeTree(f.options);assert.deepEqual(oldPaths(f),[]);other(f);
});
test('interrupted capture cannot adopt a same-path replacement or added descendant',async()=>{
 const f=await partitioned(85);let once=0;f.db.hooks.afterCommit=({writes})=>{if(!once&&writes.some(w=>w.type==='create'&&w.path.includes('/pages/'))){once++;throw Error('capture interrupted');}};
 await assert.rejects(manifest.captureTree(f.options));f.db.hooks={};f.db.put(ROOT+'/notes/n80',{newGeneration:true});f.db.put(ROOT+'/notes/late',{newGeneration:true});
 await review(manifest.captureTree(f.options));assert.deepEqual(f.db.docs.get(ROOT+'/notes/n80'),{newGeneration:true});assert.ok(f.db.docs.has(ROOT+'/notes/late'));assert.equal(f.db.docs.get(f.header).state,'QUARANTINED');other(f);
});
test('partial capture never dispatches Auth or enters a destructive page',async()=>{
 const f=await partitioned();let once=0;f.db.hooks.afterCommit=({writes})=>{if(!once&&writes.some(w=>w.path===f.header)){once++;throw Error('header response lost');}};
 await assert.rejects(manifest.captureTree(f.options));f.db.hooks={};const n=f.db.commits.length;
 await review(manifest.removeTree(f.options));await assert.rejects(manifest.authOutcome(f.options,'NOT_REQUESTED','DISPATCHED'));
 assert.equal(f.db.commits.length,n);assert.equal(oldPaths(f).length,4);other(f);
});
test('partitioned UNKNOWN and unconfirmed Auth preserve every source and receipt',async()=>{
 const f=await partitioned();f.db.put(ROOT+'/_http_operations_v1/pending',{unknown:true});await manifest.captureTree(f.options);const n=oldPaths(f).length;
 await review(manifest.removeTree(f.options));await manifest.authOutcome(f.options,'NOT_REQUESTED','DISPATCHED');await manifest.authOutcome(f.options,'DISPATCHED','UNKNOWN');
 await review(manifest.removeTree(f.options));assert.equal(oldPaths(f).length,n);assert.deepEqual(f.db.docs.get(ROOT+'/_http_operations_v1/pending'),{unknown:true});other(f);
});
for(const applied of [false,true])test('partitioned destructive page lost response resumes atomic receipts applied='+applied,async()=>{
 const f=await partitioned(85);await manifest.captureTree(f.options);await confirmed(f);let once=0;f.db.hooks[applied?'afterCommit':'beforeCommit']=({writes})=>{if(!once&&writes.some(w=>w.type==='delete')){once++;throw Error('lost delete reply');}};
 await assert.rejects(manifest.removeTree(f.options),/lost delete reply/);f.db.hooks={};await manifest.removeTree(f.options);assert.deepEqual(oldPaths(f),[]);other(f);
});
test('partitioned concurrent capture and cleanup share exact original pages and one cursor',async()=>{
 const f=await partitioned(90);await Promise.all([manifest.captureTree(f.options),manifest.captureTree(f.options)]);await confirmed(f);
 await Promise.all([manifest.removeTree(f.options),manifest.removeTree(f.options)]);assert.deepEqual(oldPaths(f),[]);other(f);
});
test('partitioned replacement during a real MVCC retry is preserved',async()=>{
 const f=await partitioned(50);await manifest.captureTree(f.options);await confirmed(f);let once=0;
 f.db.hooks.beforeCommit=({writes})=>{if(!once&&writes.some(w=>w.type==='delete')){once++;f.db.put(ROOT,{newGeneration:true});}};
 await review(manifest.removeTree(f.options));assert.ok(f.db.conflicts);assert.deepEqual(f.db.docs.get(ROOT),{newGeneration:true});other(f);
});
test('partitioned out-of-manifest orphan is preserved and prevents COMPLETE',async()=>{
 const f=await partitioned();await manifest.captureTree(f.options);await confirmed(f);f.db.put(ROOT+'/missing/x/nested/late',{new:true});
 await review(manifest.removeTree(f.options));assert.ok(f.db.docs.has(ROOT+'/missing/x/nested/late'));assert.equal(f.db.docs.get(f.header).state,'QUARANTINED');other(f);
});
test('partitioned committed page is never repeated and COMPLETE cannot reopen',async()=>{
 const f=await partitioned(50);await manifest.captureTree(f.options);await confirmed(f);await manifest.removeTree(f.options);f.db.put(ROOT,{newGeneration:true});
 const n=f.db.commits.length;await manifest.captureTree(f.options);await manifest.removeTree(f.options);assert.equal(f.db.commits.length,n);assert.deepEqual(f.db.docs.get(ROOT),{newGeneration:true});other(f);
});
test('partitioned corrupted page cannot change the committed target set',async()=>{
 const f=await partitioned();await manifest.captureTree(f.options);await confirmed(f);const p=f.header+'/pages/0',data=f.db.docs.get(p);
 f.db.put(p,{...data,entries:[{path:OTHER,version:Timestamp.fromMillis(1)}]});await review(manifest.removeTree(f.options));assert.equal(oldPaths(f).length,4);other(f);
});

test('partition budgets and contradictory terminal cursors cannot authorize cleanup',async()=>{
 const f=await partitioned();const h=await manifest.captureTree(f.options),before=f.db.commits.length;
 for(const wrong of [{...h,pageCount:manifest.MAX_CAPTURE_PAGES+1},{...h,inventoryBytes:manifest.CAPTURE_PAGE_BYTES*h.pageCount+1},{...h,state:'COMPLETE'}])assert.throws(()=>manifest.validateHeader(wrong,f.options.operation,ROOT),e=>e.code==='ACCOUNT_CLEANUP_REVIEW_REQUIRED');
 assert.equal(f.db.commits.length,before);assert.equal(oldPaths(f).length,4);other(f);
});
test('interrupted capture cannot continue after original Auth is absent',async()=>{
 const f=await partitioned();let once=0;f.db.hooks.afterCommit=({writes})=>{if(!once&&writes.some(w=>w.path===f.header)){once++;throw Error('interrupted');}};
 await assert.rejects(manifest.captureTree(f.options));f.db.hooks={};f.absent();await review(manifest.captureTree(f.options));assert.equal(oldPaths(f).length,4);assert.equal(f.db.docs.get(f.header).state,'QUARANTINED');other(f);
});
test('bounded metadata prefetch propagates sibling failure without capture or deletion',async()=>{
 const f=await partitioned(),original=f.db.doc.bind(f.db),error=Error('metadata unavailable'),before=f.db.commits.length;
 f.db.doc=p=>{const ref=original(p);return p===ROOT+'/notes/n1'?{...ref,listCollections:async()=>{throw error;}}:ref;};
 await assert.rejects(manifest.captureTree(f.options),e=>e===error);assert.equal(f.db.commits.length,before);assert.equal(oldPaths(f).length,4);other(f);
});

test('private partition rechecks confirmed Auth on every transaction retry',async()=>{
 const f=await partitioned();await manifest.captureTree(f.options);await confirmed(f);let once=0;
 f.db.hooks.beforeCommit=({writes})=>{if(!once&&writes.some(w=>w.type==='delete')){once++;f.db.put(f.header,{...f.db.docs.get(f.header),authOutcome:'NOT_REQUESTED'});}};
 await review(manifest.removeTree(f.options));assert.ok(f.db.conflicts);assert.equal(oldPaths(f).length,4);other(f);
});
