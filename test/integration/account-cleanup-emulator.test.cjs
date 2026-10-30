'use strict';
// Independent integration harness: real SDK/Firestore transactions; synthetic
// Auth ports only. This never attests Auth generation or effective IAM.
const test=require('node:test'),assert=require('node:assert/strict'),{createRequire}=require('node:module'),{randomUUID}=require('node:crypto');
const PROJECT='demo-life-os';let sequence=0;
const review=p=>assert.rejects(p,e=>e.code==='ACCOUNT_CLEANUP_REVIEW_REQUIRED');
const path=require('node:path'),{pathToFileURL}=require('node:url');
const ON=process.env.K01_EMULATOR_TEST==='1';
if(!ON)test('K01 native Firestore integration requires the isolated demo launcher',{skip:'Run tools/k01/emulator-run.cjs'},()=>{});
for(const kind of ['backend']){
 if(!ON)continue;
 const root=path.resolve(__dirname, '../..');
 const req=createRequire(root+'/package.json');const {Firestore,Timestamp}=req('firebase-admin/firestore');const {GoogleAuth,OAuth2Client}=req('google-auth-library');
 const manifest=req(kind==='functions'?'./account_cleanup_manifest.js':'./api/account/_cleanup_manifest.cjs');
 const control=req(kind==='functions'?'./deletion_control.js':'./api/account/_deletion_control.cjs');
 const circles=req(kind==='functions'?'./circle_cleanup.js':'./api/account/_circle_cleanup.cjs');
 const owner=new OAuth2Client();owner.setCredentials({access_token:'owner',expiry_date:Date.now()+3600000});
 const real=new Firestore({projectId:PROJECT,databaseId:'(default)',host:process.env.FIRESTORE_EMULATOR_HOST,ssl:false,auth:new GoogleAuth({projectId:PROJECT,authClient:owner})});
 test.after(async()=>real.terminate());
 async function fixture(count=3,rootless=false){
  const uid='k01-'+kind+'-'+(++sequence),tree='users/'+uid,other=tree+'-B';const hooks={},commits=[];let present=true,lookups=0,attempts=0;
  const db={projectId:real.projectId,databaseId:real.databaseId,doc:real.doc.bind(real),collection:real.collection.bind(real),collectionGroup:real.collectionGroup.bind(real),
   runTransaction:async(callback,...options)=>{
    let writes;
    const value=await real.runTransaction(async tx=>{
     attempts++;writes=[];const proxy=new Proxy(tx,{get(target,key){
      if(key==='get')return async ref=>{const snap=await tx.get(ref);await hooks.afterRead?.(ref,snap);return snap;};
      if(['create','set','update','delete'].includes(key))return(ref,...args)=>{writes.push({type:key,path:ref.path});return tx[key](ref,...args);};
      return typeof target[key]==='function'?target[key].bind(target):target[key];
     }});const result=await callback(proxy);await hooks.beforeCommit?.(writes);return result;
    },...options);
    commits.push(writes);await hooks.afterCommit?.(writes);return value;
   }};
  const seeds=[[other,{keep:'B'}],[other+'/notes/private',{keep:'B-child'}]];
  if(!rootless)seeds.push([tree,{original:true}]);for(let n=0;n<count;n++)seeds.push([tree+'/notes/n'+n,{old:n}]);
  for(let n=0;n<seeds.length;n+=400){const b=real.batch();for(const [p,v] of seeds.slice(n,n+400))b.set(real.doc(p),v);await b.commit();}
  const c=control.createController({db,binding:{projectId:PROJECT,databaseId:'(default)',uid},clock:()=>Timestamp.fromMillis(Date.now()),uuid:randomUUID,ports:{
   getAuthenticatedSubject:async()=>({projectId:PROJECT,databaseId:'(default)',uid}),getAuthUser:async()=>{lookups++;if(present)return{uid};throw Object.assign(Error('synthetic-absent'),{code:'auth/user-not-found'});},
  }});
  const admitted=await c.admitBackend(),operation=c.originalOperation(admitted.handle);
  const beforeEffect=async()=>{lookups++;await hooks.beforeEffect?.();};
  const options={db,operation,ref:db.doc(tree),assertOperation:tx=>c.assertOperationTransaction(tx,admitted.handle),authorizeCapture:async()=>present,beforeEffect};
  const guard=circles.bindOperation(db,uid,c,admitted.handle,beforeEffect,async()=>present);
  const f={uid,tree,other,db,real,c,admitted,operation,options,guard,wrapper:circles.withActiveGuard(db,uid,guard),hooks,commits,header:manifest.refs(db,operation,tree).header,
   release:()=>{present=false;},lookups:()=>lookups,attempts:()=>attempts,
   assertOther:async()=>{assert.deepEqual((await real.doc(other).get()).data(),{keep:'B'});assert.deepEqual((await real.doc(other+'/notes/private').get()).data(),{keep:'B-child'});},
   assertDeny:async()=>{const ref=real.doc('retired_auth_identities/'+uid);assert.equal((await ref.get()).data().deletionId,operation.deletionId);assert.equal((await real.doc('account_deletion_guards/'+uid+'/control/operation').get()).data().state,'IN_PROGRESS');},
  };return f;
 }
 test(kind+': native chunks include orphan descendants and atomic receipts; no old data after success',{timeout:60000},async()=>{
  const f=await fixture(43);await real.doc(f.tree+'/missing/parent/nested/orphan').set({old:true});
  await manifest.captureTree(f.options);f.release();await f.wrapper.deleteTree(f.options.ref);
  assert.deepEqual(await manifest.inventory(f.options.ref),[]);assert.equal((await f.header.get()).data().state,'COMPLETE');await f.assertOther();
  for(const writes of f.commits.filter(w=>w.some(x=>x.type==='delete'))){assert.ok(writes.filter(x=>x.type==='delete').length<=40);assert.equal(writes.filter(x=>x.type==='update'&&x.path.includes('/pages/')).length,1);}
 });
 test(kind+': missing root still inventories and deletes orphan-only descendants',async()=>{
  const f=await fixture(0,true);await real.doc(f.tree+'/missing/parent/deeper/child').set({old:true});await manifest.captureTree(f.options);f.release();await f.wrapper.deleteTree(f.options.ref);assert.deepEqual(await manifest.inventory(f.options.ref),[]);await f.assertOther();
 });
 test(kind+': real destructive transaction pauses AFTER last Auth boundary; recreated A/B survive',{timeout:30000},async()=>{
  const f=await fixture();await manifest.captureTree(f.options);f.release();let reached=0,lookupAtPause;
  f.hooks.afterRead=async ref=>{if(!reached&&ref.path===f.header.path+'/pages/0'){reached++;lookupAtPause=f.lookups();assert.ok(lookupAtPause>0);await real.doc(f.tree).set({recreated:true});await real.doc(f.tree+'/notes/recreated').set({recreated:true});}};
  await review(f.wrapper.deleteTree(f.options.ref));assert.equal(reached,1);assert.equal(f.lookups(),lookupAtPause,'no further Auth lookup may make this pass');
  assert.deepEqual((await real.doc(f.tree).get()).data(),{recreated:true});assert.deepEqual((await real.doc(f.tree+'/notes/recreated').get()).data(),{recreated:true});assert.equal((await f.header.get()).data().state,'QUARANTINED');await f.assertDeny();await f.assertOther();
 });
 test(kind+': identical same-path substitution is preserved by native updateTime',async()=>{
  const f=await fixture();await manifest.captureTree(f.options);const ref=real.doc(f.tree+'/notes/n0'),old=(await ref.get()).updateTime;await ref.delete();await ref.set({old:0});assert.equal(old.isEqual((await ref.get()).updateTime),false);await review(f.wrapper.deleteTree(f.options.ref));assert.deepEqual((await ref.get()).data(),{old:0});await f.assertOther();
 });
 test(kind+': non-manifested orphan is retained, quarantined and cannot be adopted by retry',async()=>{
  const f=await fixture();await manifest.captureTree(f.options);const ref=real.doc(f.tree+'/missing/parent/late/child');await ref.set({late:true});await review(f.wrapper.deleteTree(f.options.ref));await review(f.wrapper.deleteTree(f.options.ref));assert.deepEqual((await ref.get()).data(),{late:true});assert.equal((await f.header.get()).data().state,'QUARANTINED');await f.assertDeny();await f.assertOther();
 });
 for(const applied of [false,true])test(kind+': native chunk '+(applied?'committed/lost reply':'abort before commit')+' resumes exact receipt',{timeout:30000},async()=>{
  const f=await fixture(43);await manifest.captureTree(f.options);let injected=0;
  f.hooks[applied?'afterCommit':'beforeCommit']=async writes=>{if(!injected&&writes.some(w=>w.type==='delete')){injected++;throw Error('SIMULATED_TRANSPORT');}};
  await assert.rejects(f.wrapper.deleteTree(f.options.ref),/SIMULATED_TRANSPORT/);assert.equal(injected,1);const p=await real.doc(f.header.path+'/pages/0').get();assert.equal(p.data().done,applied);assert.equal((await real.doc(p.data().entries[0].path).get()).exists,!applied);
  delete f.hooks.beforeCommit;delete f.hooks.afterCommit;await f.wrapper.deleteTree(f.options.ref);assert.deepEqual(await manifest.inventory(f.options.ref),[]);assert.equal((await f.header.get()).data().state,'COMPLETE');await f.assertOther();
 });
 test(kind+': confirmed chunk never deletes a replacement on continuation',async()=>{
  const f=await fixture(43);await manifest.captureTree(f.options);let path;
  f.hooks.afterCommit=async writes=>{if(!path&&writes.some(w=>w.type==='delete')){path=writes.find(w=>w.type==='delete').path;await real.doc(path).set({recreated:true});throw Error('LOST_REPLY');}};
  await assert.rejects(f.wrapper.deleteTree(f.options.ref),/LOST_REPLY/);delete f.hooks.afterCommit;await review(f.wrapper.deleteTree(f.options.ref));assert.deepEqual((await real.doc(path).get()).data(),{recreated:true});await f.assertOther();
 });
 test(kind+': duplicate concurrent workers use real SDK transaction retries',{timeout:60000},async()=>{
  const f=await fixture(43);await manifest.captureTree(f.options);let queued=0;f.hooks.beforeEffect=async()=>{queued++;};
  await Promise.all([f.wrapper.deleteTree(f.options.ref),f.wrapper.deleteTree(f.options.ref)]);assert.deepEqual(await manifest.inventory(f.options.ref),[]);assert.equal((await f.header.get()).data().state,'COMPLETE');assert.ok(queued>=2);assert.ok(f.attempts()>0);await f.assertOther();
 });
 for(const pathFor of ['guard','reservation','operation'])test(kind+': real transaction rejects changed R5 '+pathFor,async()=>{
  const f=await fixture();await manifest.captureTree(f.options);const paths={guard:'account_deletion_guards/'+f.uid,reservation:'retired_auth_identities/'+f.uid,operation:'account_deletion_guards/'+f.uid+'/control/operation'};
  await real.doc(paths[pathFor]).update({deletionId:randomUUID()});await assert.rejects(f.wrapper.deleteTree(f.options.ref));assert.equal((await real.doc(f.tree+'/notes/n0').get()).exists,true);await f.assertOther();
 });
 test(kind+': UNKNOWN is durable and never grants cleanup or a second dispatch',async()=>{
  const f=await fixture();await manifest.captureTree(f.options);await manifest.authOutcome(f.options,'NOT_REQUESTED','DISPATCHED');await manifest.authOutcome(f.options,'DISPATCHED','UNKNOWN');await review(f.wrapper.deleteTree(f.options.ref));await assert.rejects(manifest.authOutcome(f.options,'UNKNOWN','CONFIRMED'));assert.equal((await real.doc(f.tree+'/notes/n0').get()).exists,true);assert.equal((await f.header.get()).data().authOutcome,'UNKNOWN');await f.assertDeny();await f.assertOther();
 });
 test(kind+': native depth limit refuses capture without target deletion',{timeout:30000},async()=>{
  const f=await fixture(0);await real.doc(f.tree+'/x/d'.repeat(65)).set({deep:true});await assert.rejects(manifest.captureTree(f.options),e=>e.code==='ACCOUNT_CLEANUP_LIMIT');assert.equal((await f.header.get()).exists,false);assert.equal((await real.doc(f.tree).get()).exists,true);await f.assertOther();
 });
 test(kind+': native document limit does not seal a truncated scope',{timeout:120000},async()=>{
  const f=await fixture(manifest.MAX_DOCUMENTS);await assert.rejects(manifest.captureTree(f.options),e=>e.code==='ACCOUNT_CLEANUP_LIMIT');assert.equal((await f.header.get()).exists,false);assert.equal((await real.collection(f.tree+'/notes').count().get()).data().count,manifest.MAX_DOCUMENTS);await f.assertOther();
 });
 test(kind+': COMPLETE replay is read-only even after recreation',async()=>{
  const f=await fixture();await manifest.captureTree(f.options);await f.wrapper.deleteTree(f.options.ref);await real.doc(f.tree).set({later:true});const n=f.commits.length;await manifest.removeTree(f.options);assert.equal(f.commits.length,n);assert.deepEqual((await real.doc(f.tree).get()).data(),{later:true});await f.assertOther();
 });
 test(kind+': SDK retry retains sealed versions after ABORTED and concludes without duplicate effects',async()=>{
  const f=await fixture();await manifest.captureTree(f.options);let injected=0;
  f.hooks.beforeCommit=async writes=>{if(!injected&&writes.some(w=>w.type==='delete')){injected++;throw Object.assign(Error('SYNTHETIC_ABORTED'),{code:10});}};
  // A synthetic ABORTED status exercises the real SDK retry/rollback path.
  // All reads, rollback and the eventual commit use the native SDK.
  f.hooks.beforeEffect=async()=>{};
  const attemptsBefore=f.attempts(),commitsBefore=f.commits.length;await f.wrapper.deleteTree(f.options.ref);assert.equal(injected,1);assert.ok(f.attempts()-attemptsBefore>f.commits.length-commitsBefore);assert.deepEqual(await manifest.inventory(f.options.ref),[]);await f.assertOther();
 });

 if(kind==='backend')test('backend: entire legitimate deleteAccount completes native private/Circle/Billing/R5 boundaries',{timeout:60000},async()=>{
  const {deleteAccount}=await import(pathToFileURL(path.join(root,'api/account/delete.js')).href);const uid='k01-full-'+(++sequence),tree='users/'+uid;await real.doc(tree).set({activeCircleId:null});await real.doc(tree+'/notes/old').set({old:true});await real.doc(tree+'/missing/parent/deep/orphan').set({old:true});let present=true,calls=0;
  const auth={getUser:async()=>{if(present)return{uid,metadata:{creationTime:new Date(Date.now()-3600000).toUTCString()}};throw Object.assign(Error('absent'),{code:'auth/user-not-found'});},deleteUser:async owner=>{assert.equal(owner,uid);calls++;present=false;}};
  const result=await deleteAccount({db:real,auth,uid});assert.deepEqual(result,{body:{deleted:true,circleDeleted:false}});assert.equal(calls,1);assert.deepEqual(await manifest.inventory(real.doc(tree)),[]);const op=(await real.doc('account_deletion_guards/'+uid+'/control/operation').get()).data();assert.equal(op.state,'COMPLETE');assert.equal((await real.doc('account_deletion_guards/'+uid).get()).data().state,'COMPLETE');assert.equal((await real.doc('retired_auth_identities/'+uid).get()).exists,true);assert.equal((await real.doc('billing_google_accounts/'+op.scope.billingAccountHash).get()).exists,false);
 });
 if(kind==='backend')for(const soleAdmin of [false,true])test('backend: entire legitimate '+(soleAdmin?'sole-admin':'member')+' deletion removes owned Circle/Billing data and preserves B',{timeout:60000},async()=>{
  const {deleteAccount}=await import(pathToFileURL(path.join(root,'api/account/delete.js')).href);const {createHash}=require('node:crypto');const uid='k01-circle-'+(++sequence),peer=uid+'-B',circle=uid+'-circle',tree='users/'+uid,hash=createHash('sha256').update(uid).digest('hex');const stamp=Timestamp.fromMillis(Date.now()-60000);
  await real.doc(tree).set({activeCircleId:circle});await real.doc(tree+'/notes/private').set({old:true});await real.doc('users/'+peer).set({keep:true});
  await real.doc('circles/'+circle).set({name:'Synthetic',description:'Native fixture',adminId:soleAdmin?uid:peer,memberCount:soleAdmin?1:2,memberLimit:3,schemaVersion:2,createdAt:stamp,updatedAt:stamp});
  await real.doc('circles/'+circle+'/members/'+uid).set({role:soleAdmin?'admin':'member',displayNameSnapshot:'Synthetic',photoUrlSnapshot:null,joinedAt:stamp});
  if(!soleAdmin)await real.doc('circles/'+circle+'/members/'+peer).set({role:'admin',displayNameSnapshot:'Peer',photoUrlSnapshot:null,joinedAt:stamp});
  if(soleAdmin)await real.doc('circles/'+circle+'/missing/parent/notes/orphan').set({old:true});
  await real.doc('billing_google_accounts/'+hash).set({uid,state:'ACTIVE'});await real.doc('billing_google_tokens/'+hash).set({accountHash:hash});
  let present=true,calls=0;const auth={getUser:async()=>{if(present)return{uid,metadata:{creationTime:new Date(Date.now()-3600000).toUTCString()}};throw Object.assign(Error('absent'),{code:'auth/user-not-found'});},deleteUser:async()=>{calls++;present=false;}};
  const result=await deleteAccount({db:real,auth,uid});assert.deepEqual(result,{body:{deleted:true,circleDeleted:soleAdmin}});assert.equal(calls,1);assert.deepEqual(await manifest.inventory(real.doc(tree)),[]);assert.equal((await real.doc('billing_google_accounts/'+hash).get()).exists,false);assert.equal((await real.doc('billing_google_tokens/'+hash).get()).exists,false);assert.deepEqual((await real.doc('users/'+peer).get()).data(),{keep:true});assert.equal((await real.doc('account_deletion_guards/'+uid+'/control/operation').get()).data().state,'COMPLETE');
  if(soleAdmin)assert.deepEqual(await manifest.inventory(real.doc('circles/'+circle)),[]);else{assert.equal((await real.doc('circles/'+circle).get()).data().memberCount,1);assert.equal((await real.doc('circles/'+circle+'/members/'+peer).get()).exists,true);assert.equal((await real.doc('circles/'+circle+'/members/'+uid).get()).exists,false);}
 });
 if(kind==='backend')test('backend: Auth RPC reply lost after actual modeled removal remains UNKNOWN with native journal and no second dispatch',async()=>{
  const {deleteAccount}=await import(pathToFileURL(path.join(root,'api/account/delete.js')).href);const uid='k01-unknown-'+(++sequence);await real.doc('users/'+uid).set({activeCircleId:null});await real.doc('users/'+uid+'/notes/private').set({keep:true});let present=true,calls=0;
  const auth={getUser:async()=>{if(present)return{uid};throw Object.assign(Error('absent'),{code:'auth/user-not-found'});},deleteUser:async()=>{present=false;calls++;throw Error('LOST_AUTH_REPLY');}};
  const pending=e=>e.statusCode===503&&e.code==='ACCOUNT_DELETION_BLOCKED';await assert.rejects(deleteAccount({db:real,auth,uid}),pending);await assert.rejects(deleteAccount({db:real,auth,uid}),pending);assert.equal(calls,1);assert.equal((await real.doc('users/'+uid+'/notes/private').get()).exists,true);assert.equal((await real.doc('account_deletion_guards/'+uid+'/control/operation').get()).data().state,'IN_PROGRESS');const operation={uid,scope:{privateRoot:'users/'+uid}},ref=manifest.refs(real,operation,'users/'+uid).header;assert.equal((await ref.get()).data().authOutcome,'UNKNOWN');
 });
}
