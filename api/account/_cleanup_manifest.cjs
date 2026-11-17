"use strict";
const {createHash} = require("node:crypto");
const {Timestamp} = require("firebase-admin/firestore");

// Bounded snapshots, never UID discovery during a retry. This is object-version
// fencing, NOT proof of Auth generation. Admission and effective R8 remain gates.
const PAGE = 40, MAX_DOCUMENTS = 4000, MAX_BYTES = 4 * 1024 * 1024;
function fail(code = "ACCOUNT_CLEANUP_REVIEW_REQUIRED") {
  const error = new Error("Account cleanup requires review.");
  error.code = code;
  throw error;
}
function stamp(value) {
  if (!(value instanceof Timestamp) || !Number.isSafeInteger(value.seconds) ||
      !Number.isInteger(value.nanoseconds) || value.nanoseconds < 0 || value.nanoseconds >= 1000000000) fail();
  return value;
}
function same(a, b) {
  return a === null ? b === null :
    b instanceof Timestamp && a.isEqual(b);
}
function digest(entries) {
  return createHash("sha256").update(JSON.stringify(entries.map(e =>
    [e.path, e.version.seconds, e.version.nanoseconds]))).digest("hex");
}
function refs(db, operation, root) {
  if (root !== operation.scope.privateRoot && !/^circles\/[^/]+$/.test(root)) fail();
  const id = createHash("sha256").update(root).digest("hex");
  const header = db.doc("account_deletion_guards/" + operation.uid +
    "/cleanup_manifests/" + id);
  return {header, page: i => header.collection("pages").doc(String(i))};
}
function header(value, operation, root) {
  if(value?.version===3)return header3(value,operation,root);
  if (!value || value.version !== 2 || value.uid !== operation.uid ||
      value.projectId !== operation.projectId ||
      value.databaseId !== operation.databaseId ||
      value.deletionId !== operation.deletionId || value.root !== root ||
      !["SEALED", "COMPLETE", "QUARANTINED"].includes(value.state) ||
      !Array.isArray(value.pageHashes) || value.pageHashes.length > 101 ||
      value.pageHashes.some(h => !/^[a-f0-9]{64}$/.test(h)) ||
      !["NOT_REQUESTED", "DISPATCHED", "CONFIRMED", "UNKNOWN"].includes(value.authOutcome)) fail();
  if (value.rootVersion !== null) stamp(value.rootVersion);
  if (value.state === "QUARANTINED" || value.authOutcome === "UNKNOWN") fail();
  return value;
}
function page(value, h, index) {
  if (!value || value.version !== 2 || value.index !== index ||
      typeof value.done !== "boolean" || !Array.isArray(value.entries) ||
      value.entries.length > PAGE || digest(value.entries) !== h.pageHashes[index]) fail();
  for (const e of value.entries) {
    if (typeof e.path !== "string" ||
        !(e.path === h.root || e.path.startsWith(h.root + "/"))) fail();
    stamp(e.version);
  }
  return value;
}
async function inventory(ref) {
  const entries = [];
  let bytes = 0;
  async function walk(current, depth) {
    if (depth > 64) fail("ACCOUNT_CLEANUP_LIMIT");
    const snapshot = await current.get();
    if (snapshot.exists) {
      const entry = {path: current.path, version: stamp(snapshot.updateTime)};
      entries.push(entry);
      bytes += Buffer.byteLength(JSON.stringify(entry));
      if (entries.length > MAX_DOCUMENTS || bytes > MAX_BYTES) fail("ACCOUNT_CLEANUP_LIMIT");
    }
    for (const collection of await current.listCollections()) {
      if (!collection.path.startsWith(current.path + "/") ||
          collection.path.split("/").length !== current.path.split("/").length + 1) fail();
      for (const child of await collection.listDocuments()) {
        if (!child.path.startsWith(collection.path + "/") ||
            child.path.split("/").length !== collection.path.split("/").length + 1) fail();
        await walk(child, depth + 1);
      }
    }
  }
  await walk(ref, 0);
  entries.sort((a, b) => b.path.split("/").length - a.path.split("/").length ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}
async function quarantine(argumentsForQuarantine, reason) {
  const {db, operation, ref, assertOperation} = argumentsForQuarantine;
  const target = refs(db, operation, ref.path);
  const account = refs(db, operation, operation.scope.privateRoot);
  await db.runTransaction(async tx => {
    await (argumentsForQuarantine.assertOriginalOperation || assertOperation)(tx);
    const current = await tx.get(target.header);
    const original = target.header.path === account.header.path ?
      current : await tx.get(account.header);
    if ([current, original].some(s => s.exists &&
        s.data().deletionId !== operation.deletionId)) fail();
    // An unresolved dispatch must retain its original manifest and receipt.
    if (original.exists &&
        ["DISPATCHED", "UNKNOWN"].includes(original.data().authOutcome)) fail();
    function mark(reference, snapshot, root) {
      if (!snapshot.exists) {
        tx.create(reference, {version: 2, uid: operation.uid,
          projectId: operation.projectId, databaseId: operation.databaseId,
          deletionId: operation.deletionId, root, rootVersion: null,
          state: "QUARANTINED", pageHashes: [], billingVersion: null,
          circleDeleted: false, authOutcome: "NOT_REQUESTED", reason});
      } else if (snapshot.data().state !== "QUARANTINED") {
        // Original R5 must still be active. Tree COMPLETE is a receipt, not
        // account terminality; quarantine never grants another delete.
        tx.update(reference, {state: "QUARANTINED", reason});
      }
    }
    mark(target.header, current, ref.path);
    if (target.header.path !== account.header.path) {
      mark(account.header, original, operation.scope.privateRoot);
    }
  });
}
async function captureTree(options) {
  const {db, operation, ref, assertOperation, authorizeCapture} = options;
  const r = refs(db, operation, ref.path);
  const prior = await r.header.get();
  if (prior.exists) {const h=header(prior.data(), operation, ref.path);if(h.version===3&&h.state==='CAPTURING')return capturePartitioned(options);return h;}
  if(options.partitionedCapture===true)return capturePartitioned(options);
  if (await authorizeCapture() !== true) {
    await quarantine(options, "PRE_AUTH_CAPTURE_REQUIRED");
    fail();
  }
  const entries = await inventory(ref);
  const rootVersion = entries.find(e => e.path === ref.path)?.version || null;
  const pages = [];
  // Keep the root in its own final chunk so every descendant chunk reads its
  // original version. No wide delete and no target version refresh on retry.
  const descendants = entries.filter(e => e.path !== ref.path);
  for (let i = 0; i < descendants.length; i += PAGE) pages.push(descendants.slice(i, i + PAGE));
  if (rootVersion !== null) pages.push([{path: ref.path, version: rootVersion}]);
  const h = {version: 2, uid: operation.uid, projectId: operation.projectId,
    databaseId: operation.databaseId, deletionId: operation.deletionId,
    root: ref.path, rootVersion, state: "SEALED", pageHashes: pages.map(digest),
    billingVersion: null, circleDeleted: options.circleDeleted === true,
    authOutcome: "NOT_REQUESTED", reason: null};
  return db.runTransaction(async tx => {
    await assertOperation(tx);
    const existing = await tx.get(r.header);
    const root = await tx.get(ref);
    if (existing.exists) return header(existing.data(), operation, ref.path);
    if (ref.path === operation.scope.privateRoot) {
      const billing = await tx.get(db.doc("billing_google_accounts/" + operation.scope.billingAccountHash));
      h.billingVersion = billing.exists ? stamp(billing.updateTime) : null;
    }
    if (!same(rootVersion, root.exists ? stamp(root.updateTime) : null)) fail();
    tx.create(r.header, h);
    pages.forEach((entries, index) => tx.create(r.page(index),
      {version: 2, index, entries, done: false}));
    return h;
  });
}
async function removeTree(options) {
  const {db, operation, ref, assertOperation, beforeEffect} = options;
  const r = refs(db, operation, ref.path);
  const read = await r.header.get();
  if (!read.exists) {await quarantine(options, "MANIFEST_MISSING"); fail();}
  const h = header(read.data(), operation, ref.path);
  if(h.version===3)return removePartitioned(options,h);
  if (h.state === "COMPLETE") return;
  try {
    for (let i = 0; i < h.pageHashes.length; i++) {
      await beforeEffect();
      await db.runTransaction(async tx => {
        await assertOperation(tx);
        const current = header((await tx.get(r.header)).data(), operation, ref.path);
        const p = page((await tx.get(r.page(i))).data(), current, i);
        if (p.done) return;
        if (current.state !== "SEALED") fail();
        const root = await tx.get(ref);
        if (!same(h.rootVersion, root.exists ? stamp(root.updateTime) : null)) fail();
        const snapshots = [];
        for (const e of p.entries) snapshots.push(await tx.get(db.doc(e.path)));
        if (snapshots.some((s, k) => !s.exists ||
            !same(p.entries[k].version, stamp(s.updateTime)))) fail();
        snapshots.forEach(s => tx.delete(s.ref));
        tx.update(r.page(i), {done: true});
      });
    }
    // An unknown/new descendant is an incident, never adopted by a new scan.
    if ((await inventory(ref)).length) fail();
    await db.runTransaction(async tx => {
      await assertOperation(tx);
      const current = header((await tx.get(r.header)).data(), operation, ref.path);
      if (current.state === "COMPLETE") return;
      for (let i = 0; i < current.pageHashes.length; i++) {
        if (!page((await tx.get(r.page(i))).data(), current, i).done) fail();
      }
      if ((await tx.get(ref)).exists) fail();
      tx.update(r.header, {state: "COMPLETE"});
    });
  } catch (error) {
    // A transport error keeps the same sealed pages/atomic receipts for retry.
    // Version/ownership conflict permanently quarantines this original scope.
    if (error?.code === "ACCOUNT_CLEANUP_REVIEW_REQUIRED" ||
        error?.code === "ACCOUNT_CLEANUP_LIMIT") {
      await quarantine(options, "RESOURCE_VERSION_CONFLICT");
    }
    throw error;
  }
}
async function authOutcome(options, expected, next) {
  if (!((expected === "NOT_REQUESTED" && next === "DISPATCHED") ||
      (expected === "DISPATCHED" && ["CONFIRMED", "UNKNOWN"].includes(next)))) {
    fail("ACCOUNT_AUTH_OUTCOME_UNKNOWN");
  }
  const {db, operation, ref, assertOperation} = options;
  const r = refs(db, operation, ref.path);
  return db.runTransaction(async tx => {
    await assertOperation(tx);
    const h = header((await tx.get(r.header)).data(), operation, ref.path);
    if (h.authOutcome !== expected || h.state !== "SEALED") fail("ACCOUNT_AUTH_OUTCOME_UNKNOWN");
    tx.update(r.header, {authOutcome: next});
  });
}
async function state(options, optional = false) {
  const r = refs(options.db, options.operation, options.ref.path);
  const read = await r.header.get();
  if (!read.exists) {if (optional) return null; fail();}
  return header(read.data(), options.operation, options.ref.path);
}

// V3 partitions the SAME pre-Auth manifest. No TTL, receipt retirement, target
// discovery after seal, or alternative delete primitive. V2 receipts stay V2.
const CAPTURE_PAGE_BYTES=128*1024, MAX_CAPTURE_PAGES=4096, END='0'.repeat(64);
const hex=v=>typeof v==='string' && /^[a-f0-9]{64}$/.test(v);
const chain=(index,hash,next)=>createHash('sha256').update('ACCOUNT_MANIFEST_V3|'+index+'|'+hash+'|'+next).digest('hex');
function header3(v,op,root){
 if(v.uid!==op.uid||v.projectId!==op.projectId||v.databaseId!==op.databaseId||v.deletionId!==op.deletionId||v.root!==root||
   !['CAPTURING','SEALED','COMPLETE','QUARANTINED'].includes(v.state)||
   !['NOT_REQUESTED','DISPATCHED','CONFIRMED','UNKNOWN'].includes(v.authOutcome)||
   !Number.isSafeInteger(v.pageCount)||v.pageCount<0||v.pageCount>MAX_CAPTURE_PAGES||
   !Number.isSafeInteger(v.entryCount)||v.entryCount<0||v.entryCount>v.pageCount*PAGE||
   !Number.isSafeInteger(v.inventoryBytes)||v.inventoryBytes<0||v.inventoryBytes>v.pageCount*CAPTURE_PAGE_BYTES||
   !Number.isSafeInteger(v.capturedPages)||v.capturedPages<0||v.capturedPages>v.pageCount||
   !Number.isSafeInteger(v.nextPage)||v.nextPage<0||v.nextPage>v.pageCount||
   ![v.rootCommitment,v.captureCommitment,v.deleteCommitment].every(hex)||typeof v.circleDeleted!=='boolean')fail();
 if(v.rootVersion!==null)stamp(v.rootVersion);
 if(v.billingVersion!==null)stamp(v.billingVersion);
 if(v.state==='QUARANTINED'||v.authOutcome==='UNKNOWN')fail();
 if(v.nextPage===0&&v.deleteCommitment!==v.rootCommitment)fail();
 if(v.nextPage===v.pageCount&&v.deleteCommitment!==END)fail();
 if(v.state==='CAPTURING'&&(v.nextPage!==0||v.deleteCommitment!==v.rootCommitment||v.authOutcome!=='NOT_REQUESTED'))fail();
 if(['SEALED','COMPLETE'].includes(v.state)&&(v.capturedPages!==v.pageCount||v.captureCommitment!==END))fail();
 if(v.state==='COMPLETE'&&(v.nextPage!==v.pageCount||v.deleteCommitment!==END))fail();
 return v;
}
async function nodeMetadata(ref){const [snapshot,collections]=await Promise.all([ref.get(),ref.listCollections()]);return {snapshot,collections};}
async function* descendants(ref,depth=0,prepared,parallelAllowed=true){
 if(depth>64)fail('ACCOUNT_CLEANUP_LIMIT');
 const {snapshot,collections}=prepared||await nodeMetadata(ref);
 collections.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 for(const collection of collections){
  if(!collection.path.startsWith(ref.path+'/')||collection.path.split('/').length!==ref.path.split('/').length+1)fail();
  const children=(await collection.listDocuments()).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  // At most one level fans out into eight observed subtree readers. Each
  // reader below it is sequential, preventing exponential recursive prefetch.
  const parallel=parallelAllowed&&children.length>1,step=parallel?8:1;
  for(let start=0;start<children.length;start+=step){
   const batch=children.slice(start,start+step);
   for(const child of batch)if(!child.path.startsWith(collection.path+'/')||child.path.split('/').length!==collection.path.split('/').length+1)fail();
   const metadata=await Promise.all(batch.map(nodeMetadata));
   if(!parallel){for(let i=0;i<batch.length;i++)yield* descendants(batch[i],depth+1,metadata[i],parallelAllowed);continue;}
   const readers=batch.map((child,i)=>descendants(child,depth+1,metadata[i],false));
   const first=readers.map(reader=>reader.next().then(value=>({value}),error=>({error})));
   try{
    for(let i=0;i<readers.length;i++){
     const initial=await first[i];if(initial.error)throw initial.error;
     let item=initial.value;
     while(!item.done){yield item.value;item=await readers[i].next();}
    }
   }finally{
    // Also close/observe siblings when a caller stops on the first residue.
    await Promise.all(first);const closed=await Promise.allSettled(readers.map(reader=>reader.return()));
    const failed=closed.find(r=>r.status==='rejected');if(failed)throw failed.reason;
   }
  }
 }
 if(snapshot.exists)yield {path:ref.path,version:stamp(snapshot.updateTime)};
}
async function* boundedPages(ref){
 let entries=[],bytes=0;
 for await(const e of descendants(ref)){
  const n=Buffer.byteLength(JSON.stringify(e));
  if(n>CAPTURE_PAGE_BYTES)fail('ACCOUNT_CLEANUP_LIMIT');
  if(entries.length&&(entries.length===PAGE||bytes+n>CAPTURE_PAGE_BYTES||e.path===ref.path)){
   yield entries;entries=[];bytes=0;
  }
  entries.push(e);bytes+=n;
 }
 if(entries.length)yield entries;
}
async function describe(ref){
 const hashes=[];let entryCount=0,inventoryBytes=0,rootVersion=null;
 for await(const entries of boundedPages(ref)){
  if(hashes.length===MAX_CAPTURE_PAGES)fail('ACCOUNT_CLEANUP_LIMIT');
  hashes.push(digest(entries));entryCount+=entries.length;
  for(const e of entries){inventoryBytes+=Buffer.byteLength(JSON.stringify(e));if(e.path===ref.path)rootVersion=e.version;}
 }
 const commitments=new Array(hashes.length+1);commitments[hashes.length]=END;
 for(let i=hashes.length-1;i>=0;i--)commitments[i]=chain(i,hashes[i],commitments[i+1]);
 return {hashes,commitments,entryCount,inventoryBytes,rootVersion};
}
function page3(v,h,index){
 if(!v||v.version!==3||v.index!==index||v.done!==false||!Array.isArray(v.entries)||!v.entries.length||v.entries.length>PAGE||
   !hex(v.nextCommitment)||digest(v.entries)!==v.entryHash||chain(index,v.entryHash,v.nextCommitment)!==h.deleteCommitment)fail();
 let bytes=0;
 for(const e of v.entries){
  if(typeof e.path!=='string'||!(e.path===h.root||e.path.startsWith(h.root+'/')))fail();
  stamp(e.version);bytes+=Buffer.byteLength(JSON.stringify(e));
  if(e.path===h.root&&(index!==h.pageCount-1||v.entries.length!==1||!same(e.version,h.rootVersion)))fail();
 }
 if(bytes>CAPTURE_PAGE_BYTES)fail();return v;
}
async function capturePartitioned(options){
 const {db,operation,ref,assertOperation,authorizeCapture}=options,r=refs(db,operation,ref.path);
 try{
  if(await authorizeCapture()!==true)fail();
  const d=await describe(ref);
  const template={version:3,uid:operation.uid,projectId:operation.projectId,databaseId:operation.databaseId,
   deletionId:operation.deletionId,root:ref.path,rootVersion:d.rootVersion,state:'CAPTURING',
   pageCount:d.hashes.length,entryCount:d.entryCount,inventoryBytes:d.inventoryBytes,
   rootCommitment:d.commitments[0],captureCommitment:d.commitments[0],deleteCommitment:d.commitments[0],
   capturedPages:0,nextPage:0,billingVersion:null,circleDeleted:options.circleDeleted===true,authOutcome:'NOT_REQUESTED',reason:null};
  let h=await db.runTransaction(async tx=>{
   await assertOperation(tx);const previous=await tx.get(r.header),root=await tx.get(ref);
   if(previous.exists){const p=header(previous.data(),operation,ref.path);if(p.version!==3||p.state!=='CAPTURING')return p;
    if(p.rootCommitment!==template.rootCommitment||p.entryCount!==d.entryCount||p.inventoryBytes!==d.inventoryBytes||!same(p.rootVersion,d.rootVersion))fail();return p;}
   if(!same(d.rootVersion,root.exists?stamp(root.updateTime):null))fail();
   if(ref.path===operation.scope.privateRoot){const b=await tx.get(db.doc('billing_google_accounts/'+operation.scope.billingAccountHash));template.billingVersion=b.exists?stamp(b.updateTime):null;}
   tx.create(r.header,template);return template;
  });
  if(h.state!=='CAPTURING')return h;
  let index=0;
  for await(const entries of boundedPages(ref)){
   const i=index++;
   if(i>=d.hashes.length||digest(entries)!==d.hashes[i])fail();
   h=await db.runTransaction(async tx=>{
    await assertOperation(tx);const current=header((await tx.get(r.header)).data(),operation,ref.path);
    if(current.state!=='CAPTURING')return current;
    const old=await tx.get(r.page(i)),root=await tx.get(ref);
    if(!same(current.rootVersion,root.exists?stamp(root.updateTime):null))fail();
    if(i<current.capturedPages){const p=old.data();if(!old.exists||p.version!==3||p.index!==i||p.done!==false||p.entryHash!==d.hashes[i]||digest(p.entries)!==d.hashes[i]||p.nextCommitment!==d.commitments[i+1])fail();return current;}
    if(i!==current.capturedPages||old.exists||current.captureCommitment!==d.commitments[i])fail();
    tx.create(r.page(i),{version:3,index:i,entries,entryHash:d.hashes[i],nextCommitment:d.commitments[i+1],done:false});
    tx.update(r.header,{capturedPages:i+1,captureCommitment:d.commitments[i+1]});return current;
   });
   if(h.state!=='CAPTURING')return h;
  }
  if(index!==d.hashes.length)fail();
  if(await authorizeCapture()!==true)fail();
  return await db.runTransaction(async tx=>{
   await assertOperation(tx);const h=header((await tx.get(r.header)).data(),operation,ref.path);
   if(h.state!=='CAPTURING')return h;
   const root=await tx.get(ref);
   if(h.rootCommitment!==d.commitments[0]||h.capturedPages!==h.pageCount||h.captureCommitment!==END||!same(h.rootVersion,root.exists?stamp(root.updateTime):null))fail();
   tx.update(r.header,{state:'SEALED'});return {...h,state:'SEALED'};
  });
 }catch(e){
  if(e?.code==='ACCOUNT_CLEANUP_REVIEW_REQUIRED'||e?.code==='ACCOUNT_CLEANUP_LIMIT'){
   // A concurrent worker may already have sealed the original capture. Return
   // that immutable scope; never recapture versions after destructive work.
   const latest=await r.header.get();
   if(latest.exists&&['SEALED','COMPLETE'].includes(latest.data().state))return header(latest.data(),operation,ref.path);
   await quarantine(options,'CAPTURE_VERSION_CONFLICT');
  }
  throw e;
 }
}
async function removePartitioned(options,h){
 const {db,operation,ref,assertOperation,beforeEffect}=options,r=refs(db,operation,ref.path);
 if(h.state==='COMPLETE')return;
 if(h.state!=='SEALED'||(ref.path===operation.scope.privateRoot&&h.authOutcome!=='CONFIRMED'))fail();
 try{
  for(let i=h.nextPage;i<h.pageCount;i++){
   await beforeEffect();
   const complete=await db.runTransaction(async tx=>{
    await assertOperation(tx);const current=header((await tx.get(r.header)).data(),operation,ref.path);
    if(current.state==='COMPLETE')return true;
    if(i<current.nextPage)return false;
    if(current.state!=='SEALED'||i!==current.nextPage||current.rootCommitment!==h.rootCommitment||(ref.path===operation.scope.privateRoot&&current.authOutcome!=='CONFIRMED'))fail();
    const p=page3((await tx.get(r.page(i))).data(),current,i),root=await tx.get(ref);
    if(!same(h.rootVersion,root.exists?stamp(root.updateTime):null))fail();
    const snapshots=[];for(const e of p.entries)snapshots.push(await tx.get(db.doc(e.path)));
    if(snapshots.some((s,k)=>!s.exists||!same(p.entries[k].version,stamp(s.updateTime))))fail();
    for(const s of snapshots)tx.delete(s.ref);
    tx.update(r.page(i),{done:true});tx.update(r.header,{nextPage:i+1,deleteCommitment:p.nextCommitment});return false;
   });
   if(complete)return;
  }
  // Stop on the first residue. No inventory refresh becomes a new target.
  for await(const e of descendants(ref)){void e;fail();}
  await db.runTransaction(async tx=>{
   await assertOperation(tx);const current=header((await tx.get(r.header)).data(),operation,ref.path);
   if(current.state==='COMPLETE')return;
   if(current.state!=='SEALED'||current.nextPage!==current.pageCount||current.deleteCommitment!==END||(await tx.get(ref)).exists)fail();
   tx.update(r.header,{state:'COMPLETE'});
  });
 }catch(e){if(['ACCOUNT_CLEANUP_REVIEW_REQUIRED','ACCOUNT_CLEANUP_LIMIT'].includes(e?.code))await quarantine(options,'RESOURCE_VERSION_CONFLICT');throw e;}
}

module.exports = {captureTree, removeTree, quarantine, authOutcome, state,
  inventory, refs, validateHeader: header, PAGE, MAX_DOCUMENTS, CAPTURE_PAGE_BYTES, MAX_CAPTURE_PAGES};
