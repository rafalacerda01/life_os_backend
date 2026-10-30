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
test("complete authorized tree includes parentless descendants and leaves B intact",async()=>{
  const f=await fixture(95);
  f.db.put(ROOT+"/missing/parent/nested/orphan",{old:true});
  await manifest.captureTree(f.options);f.absent();await manifest.removeTree(f.options);
  assert.deepEqual(oldPaths(f),[]);assert.equal(f.db.docs.get(f.header).state,"COMPLETE");other(f);
  const chunks=f.db.commits.filter(ws=>ws.some(w=>w.type==="delete"));
  assert.ok(chunks.length>=4);
  for(const ws of chunks){
    assert.equal(ws.filter(w=>w.type==="update"&&w.path.includes("/pages/")).length,1);
    assert.ok(ws.filter(w=>w.type==="delete").length<=manifest.PAGE);
  }
});
test("no pre-Auth scope means quarantine and no target mutation",async()=>{
  const f=await fixture();f.absent();const before=oldPaths(f);
  await review(manifest.captureTree(f.options));
  assert.deepEqual(oldPaths(f),before);assert.equal(f.db.docs.get(f.header).state,"QUARANTINED");other(f);
});
test("retry cannot recapture a replacement root",async()=>{
  const f=await fixture();await manifest.captureTree(f.options);f.absent();
  f.db.put(ROOT,{recreated:true});f.db.put(ROOT+"/notes/new",{recreated:true});
  const again=await manifest.captureTree(f.options);assert.equal(again.rootVersion.isEqual((await f.db.doc(ROOT).get()).updateTime),false);
  await review(manifest.removeTree(f.options));
  assert.deepEqual(f.db.docs.get(ROOT),{recreated:true});assert.ok(f.db.docs.has(ROOT+"/notes/new"));
  assert.equal(f.db.docs.get(f.header).state,"QUARANTINED");other(f);
});
for(const identical of [false,true])test("same-path replacement is preserved; identical payload="+identical,async()=>{
  const f=await fixture();await manifest.captureTree(f.options);
  const path=ROOT+"/notes/n0";f.db.put(path,identical?{old:0}:{recreated:true});
  await review(manifest.removeTree(f.options));
  assert.deepEqual(f.db.docs.get(path),identical?{old:0}:{recreated:true});other(f);
});
for(const target of [ROOT,ROOT+"/notes/n0"])test("replacement after transaction reads retries against sealed versions: "+target,async()=>{
  const f=await fixture();await manifest.captureTree(f.options);let injected=0;
  f.db.hooks.beforeCommit=({writes})=>{
    if(!injected&&writes.some(w=>w.type==="delete")){injected++;f.db.put(target,{recreated:true});}
  };
  await review(manifest.removeTree(f.options));
  assert.equal(injected,1);assert.ok(f.db.conflicts>=1);
  assert.deepEqual(f.db.docs.get(target),{recreated:true});other(f);
});
test("new descendant outside the manifest is never silently adopted",async()=>{
  const f=await fixture();await manifest.captureTree(f.options);f.db.put(ROOT+"/notes/late",{new:true});
  await review(manifest.removeTree(f.options));
  assert.deepEqual(f.db.docs.get(ROOT+"/notes/late"),{new:true});
  assert.equal(f.db.docs.get(f.header).state,"QUARANTINED");
});
for(const after of [false,true])test("lost chunk result resumes original receipts; applied="+after,async()=>{
  const f=await fixture(85);await manifest.captureTree(f.options);let failures=0;
  f.db.hooks[after?"afterCommit":"beforeCommit"]=({writes})=>{
    if(!failures&&writes.some(w=>w.type==="delete")){failures++;throw Error("synthetic transport");}
  };
  await assert.rejects(manifest.removeTree(f.options),/synthetic transport/);
  assert.equal(f.db.docs.get(f.header).state,"SEALED");
  f.db.hooks={};await manifest.removeTree(f.options);
  assert.deepEqual(oldPaths(f),[]);other(f);
});
test("confirmed chunk is not repeated even when a document reappears",async()=>{
  const f=await fixture(50);await manifest.captureTree(f.options);let once=0;
  f.db.hooks.afterCommit=({writes})=>{
    if(!once&&writes.some(w=>w.type==="delete")){
      once++;const path=writes.find(w=>w.type==="delete").path;
      f.db.put(path,{recreated:true});throw Error("lost reply");
    }
  };
  await assert.rejects(manifest.removeTree(f.options),/lost reply/);f.db.hooks={};
  await review(manifest.removeTree(f.options));
  assert.ok([...f.db.docs].some(([p,v])=>p.startsWith(ROOT+"/")&&v.recreated));
});
test("COMPLETE replay is read-only and never deletes later data",async()=>{
  const f=await fixture();await manifest.captureTree(f.options);await manifest.removeTree(f.options);
  f.db.put(ROOT,{later:true});f.db.put(ROOT+"/notes/new",{later:true});
  const before=f.db.commits.length;await manifest.removeTree(f.options);
  assert.equal(f.db.commits.length,before);assert.deepEqual(f.db.docs.get(ROOT),{later:true});other(f);
});
test("duplicate concurrent workers share atomic receipts",async()=>{
  const f=await fixture(90);await manifest.captureTree(f.options);
  await Promise.all([manifest.removeTree(f.options),manifest.removeTree(f.options)]);
  assert.deepEqual(oldPaths(f),[]);other(f);
});
test("R5 control changed during destructive transaction prevents stale commit",async()=>{
  const f=await fixture();await manifest.captureTree(f.options);let once=0;
  f.db.hooks.beforeCommit=({writes})=>{
    if(!once&&writes.some(w=>w.type==="delete")){
      once++;const p="account_deletion_guards/"+UID+"/control/operation";
      f.db.put(p,{...f.db.docs.get(p),deletionId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"});
    }
  };
  await assert.rejects(manifest.removeTree(f.options));
  assert.equal(oldPaths(f).length,4);other(f);
});
test("corrupted sealed page cannot grant a new target",async()=>{
  const f=await fixture();await manifest.captureTree(f.options);
  const path=f.header+"/pages/0",p=f.db.docs.get(path);
  f.db.put(path,{...p,entries:[{path:OTHER,version:Timestamp.fromMillis(1)}]});
  await review(manifest.removeTree(f.options));assert.equal(oldPaths(f).length,4);other(f);
});
test("unknown Auth result is durable and cannot be replayed as confirmation",async()=>{
  const f=await fixture();await manifest.captureTree(f.options);
  await manifest.authOutcome(f.options,"NOT_REQUESTED","DISPATCHED");
  await manifest.authOutcome(f.options,"DISPATCHED","UNKNOWN");
  await review(manifest.state(f.options));
  await assert.rejects(manifest.authOutcome(f.options,"UNKNOWN","CONFIRMED"),
    e=>e.code==="ACCOUNT_AUTH_OUTCOME_UNKNOWN");
  assert.equal(f.db.docs.get(f.header).authOutcome,"UNKNOWN");
});
test("known Auth release is recorded only for the original dispatch",async()=>{
  const f=await fixture();await manifest.captureTree(f.options);
  await manifest.authOutcome(f.options,"NOT_REQUESTED","DISPATCHED");
  await manifest.authOutcome(f.options,"DISPATCHED","CONFIRMED");
  await assert.rejects(manifest.authOutcome(f.options,"NOT_REQUESTED","DISPATCHED"),
    e=>e.code==="ACCOUNT_AUTH_OUTCOME_UNKNOWN");
  assert.equal((await manifest.state(f.options)).authOutcome,"CONFIRMED");
});
test("capture limit fails closed instead of truncating completeness",async()=>{
  const f=await fixture(manifest.MAX_DOCUMENTS);
  await assert.rejects(manifest.captureTree(f.options),e=>e.code==="ACCOUNT_CLEANUP_LIMIT");
  assert.equal(oldPaths(f).length,manifest.MAX_DOCUMENTS+1);other(f);
});


test("Auth confirmation cannot bypass dispatch or reopen a known outcome",async()=>{
 const f=await fixture();await manifest.captureTree(f.options);
 await assert.rejects(manifest.authOutcome(f.options,"NOT_REQUESTED","CONFIRMED"),
   e=>e.code==="ACCOUNT_AUTH_OUTCOME_UNKNOWN");
 assert.equal((await manifest.state(f.options)).authOutcome,"NOT_REQUESTED");
});
test("quarantine preserves its first reason without repeated writes",async()=>{
 const f=await fixture();await manifest.captureTree(f.options);
 await manifest.quarantine(f.options,"ORIGINAL_CONFLICT");
 const count=f.db.commits.flat().length;
 await manifest.quarantine(f.options,"LATER_CONFLICT");
 assert.equal(f.db.commits.flat().length,count);
 assert.equal(f.db.docs.get(f.header).reason,"ORIGINAL_CONFLICT");
 other(f);
});

test("a quarantined Circle also fences the same original account operation",async()=>{
 const f=await fixture();await manifest.captureTree(f.options);
 const circle={...f.options,ref:f.db.doc("circles/synthetic-owned")};
 await manifest.quarantine(circle,"CIRCLE_VERSION_CONFLICT");
 assert.equal(f.db.docs.get(f.header).state,"QUARANTINED");
 assert.equal(f.db.docs.get(f.header).deletionId,ID);
 await review(manifest.removeTree(f.options));
 assert.equal(oldPaths(f).length,4);other(f);
});

for (const applied of [false,true]) test("seal response failure preserves original capture; applied="+applied,async()=>{
 const f=await fixture();let failed=0;
 f.db.hooks[applied?"afterCommit":"beforeCommit"]=({writes})=>{
  if(!failed&&writes.some(w=>w.path===f.header&&w.type==="create")){
   failed++;throw Error("synthetic seal response");
  }
 };
 await assert.rejects(manifest.captureTree(f.options),/synthetic seal response/);
 assert.equal(f.db.docs.has(f.header),applied);
 assert.equal(oldPaths(f).length,4);
 f.db.hooks={};await manifest.captureTree(f.options);await manifest.removeTree(f.options);
 assert.deepEqual(oldPaths(f),[]);other(f);
});
for (const outcome of ["DISPATCHED","CONFIRMED"]) for (const applied of [false,true])
test("Auth journal response failure "+outcome+" applied="+applied,async()=>{
 const f=await fixture();await manifest.captureTree(f.options);
 const expected=outcome==="DISPATCHED"?"NOT_REQUESTED":"DISPATCHED";
 if(expected==="DISPATCHED")await manifest.authOutcome(f.options,"NOT_REQUESTED","DISPATCHED");
 let failed=0;
 f.db.hooks[applied?"afterCommit":"beforeCommit"]=({writes})=>{
  if(!failed&&writes.some(w=>w.path===f.header&&w.data?.authOutcome===outcome)){
   failed++;throw Error("synthetic journal response");
  }
 };
 await assert.rejects(manifest.authOutcome(f.options,expected,outcome),/synthetic journal response/);
 assert.equal(f.db.docs.get(f.header).authOutcome,applied?outcome:expected);
 assert.equal(oldPaths(f).length,4);other(f);
});
for (const applied of [false,true]) test("last root chunk response failure applied="+applied,async()=>{
 const f=await fixture(50);await manifest.captureTree(f.options);let failed=0;
 f.db.hooks[applied?"afterCommit":"beforeCommit"]=({writes})=>{
  if(!failed&&writes.some(w=>w.type==="delete"&&w.path===ROOT)){
   failed++;throw Error("synthetic root chunk response");
  }
 };
 await assert.rejects(manifest.removeTree(f.options),/synthetic root chunk response/);
 assert.equal(f.db.docs.has(ROOT),!applied);
 f.db.hooks={};await manifest.removeTree(f.options);
 assert.deepEqual(oldPaths(f),[]);other(f);
});
for (const applied of [false,true]) test("tree completion response failure applied="+applied,async()=>{
 const f=await fixture();await manifest.captureTree(f.options);let failed=0;
 f.db.hooks[applied?"afterCommit":"beforeCommit"]=({writes})=>{
  if(!failed&&writes.some(w=>w.path===f.header&&w.data?.state==="COMPLETE")){
   failed++;throw Error("synthetic completion response");
  }
 };
 await assert.rejects(manifest.removeTree(f.options),/synthetic completion response/);
 assert.deepEqual(oldPaths(f),[]);
 const deletes=f.db.commits.flat().filter(w=>w.type==="delete").length;
 f.db.hooks={};await manifest.removeTree(f.options);
 assert.equal(f.db.commits.flat().filter(w=>w.type==="delete").length,deletes);
 assert.equal(f.db.docs.get(f.header).state,"COMPLETE");other(f);
});
