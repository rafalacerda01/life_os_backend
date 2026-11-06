'use strict';
// Explicit isolated Auth+Firestore emulator selection only. Never Cloud/ADC.
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {initializeApp,deleteApp}=require('firebase-admin/app'),{getAuth}=require('firebase-admin/auth'),{Firestore,Timestamp}=require('firebase-admin/firestore'),{GoogleAuth,OAuth2Client}=require('google-auth-library');
if(process.env.GCLOUD_PROJECT!=='demo-life-os'||process.env.GOOGLE_CLOUD_PROJECT!=='demo-life-os'||[process.env.FIRESTORE_EMULATOR_HOST,process.env.FIREBASE_AUTH_EMULATOR_HOST].some(v=>!/^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(v||'')))throw Error('ISOLATED_DEMO_EMULATORS_REQUIRED');
const app=initializeApp({projectId:'demo-life-os',credential:{getAccessToken:async()=>({access_token:'owner',expires_in:3600})}},'b1-native-backend');
const realAuth=getAuth(app),owner=new OAuth2Client();owner.setCredentials({access_token:'owner',expiry_date:Date.now()+3600000});
const db=new Firestore({projectId:'demo-life-os',databaseId:'(default)',host:process.env.FIRESTORE_EMULATOR_HOST,ssl:false,auth:new GoogleAuth({projectId:'demo-life-os',authClient:owner})});
const counts={lookup:0,dispatch:0};const auth={app:realAuth.app,getUser:async uid=>{counts.lookup++;return realAuth.getUser(uid);},deleteUser:async uid=>{counts.dispatch++;return realAuth.deleteUser(uid);}};

test.after(async()=>{await db.terminate();await deleteApp(app);});
let serial=0;
async function fixture(){
 const uid='b1-backend-'+(++serial),root='users/'+uid,base='account_deletion_guards/'+uid,hash=createHash('sha256').update(uid).digest('hex'),circle='b1-circle-backend-'+serial;
 const first=await realAuth.createUser({uid});
 const entries=[[root,{activeCircleId:circle,oldGeneration:'A'}],[root+'/notes/old',{owner:'A'}],[root+'/missing/parent/deep/orphan',{owner:'A'}],['users/'+uid+'-B',{keep:'B'}],['users/'+uid+'-B/notes/private',{keep:'B-child'}],['circles/'+circle,{schemaVersion:2,adminId:uid,memberCount:1,memberLimit:3}],['circles/'+circle+'/members/'+uid,{role:'admin'}],['billing_google_accounts/'+hash,{uid,state:'ACTIVE'}],['billing_google_tokens/'+hash,{accountHash:hash}]];
 const before=[];for(const [p,v]of entries){await db.doc(p).set(v);const s=await db.doc(p).get();before.push({p,data:s.data(),version:s.updateTime});}
 return{uid,root,base,first,before};
}
async function call(f){return (await import("../../api/account/delete.js")).deleteAccount({db,auth,uid:f.uid});}
async function refusal(f){
 const callsBefore={...counts};await assert.rejects(call(f),e=>e.code==="ACCOUNT_DELETION_BLOCKED");
 assert.deepEqual(counts,callsBefore,'no Auth lookup or dispatch may substitute for proof');
 for(const {p,data,version}of f.before){const s=await db.doc(p).get();assert.deepEqual(s.data(),data,p);assert.ok(s.updateTime.isEqual(version),p+' must not be rewritten');}
 assert.equal((await realAuth.getUser(f.uid)).uid,f.uid);
 const operation=(await db.doc(f.base+'/control/admission_review').get()).data();assert.equal(operation.state,'REVIEW_REQUIRED');assert.equal((await db.doc(f.base+'/control/operation').get()).exists,false);
 assert.equal((await db.doc(f.base+'/control/admission_review').get()).data().state,'REVIEW_REQUIRED');
 assert.equal((await db.doc(f.base).get()).exists,false);assert.equal((await db.doc('retired_auth_identities/'+f.uid).get()).exists,false);
 assert.equal((await db.collection(f.base+'/cleanup_manifests').get()).size,0);
 return operation;
}
test('B1 backend: reused Auth UID with original A resources, independent B, Circle and Billing remain untouched',async()=>{
 const f=await fixture();await realAuth.deleteUser(f.uid);await realAuth.createUser({uid:f.uid});const op=await refusal(f);await refusal(f);assert.deepEqual((await db.doc(f.base+'/control/admission_review').get()).data(),op);
});
test('B1 backend: concurrent retries preserve one REVIEW_REQUIRED and all original versions',async()=>{
 const f=await fixture();await Promise.all([refusal(f),refusal(f)]);const operation=(await db.doc(f.base+'/control/admission_review').get()).data();assert.equal(operation.state,'REVIEW_REQUIRED');
});
test('B1 backend: plausible isolated ledger is preserved and does not grant destructive ownership',async()=>{
 const f=await fixture(),born=Timestamp.fromMillis(Date.now()-10000);const path='account_birth_decisions/'+f.uid;
 const record={version:1,uid:f.uid,projectId:'demo-life-os',tenantId:null,authCreatedAt:born,sourceType:'FIREBASE_AUTH_CREATE',sourceEventId:'birth-event',eventAt:born,recordedAt:born,decisionId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',status:'RECORDED_COHORT_CLOSED',cohort:{version:1,id:'synthetic-cohort',policy:'NEW_ACCOUNT_V2_ONLY',state:'CLOSED',cutoverAt:born},originalIdentity:{uid:f.uid,email:'synthetic@example.invalid',displayName:'Synthetic',photoUrl:null}};
 await db.doc(path).set(record);const snap=await db.doc(path).get();f.before.push({p:path,data:snap.data(),version:snap.updateTime});await refusal(f);
});
test('B1 backend: lost transaction response after durable review is still denied on repetition',async()=>{
 const f=await fixture();let injected=false;const wrapped={projectId:db.projectId,databaseId:db.databaseId,doc:db.doc.bind(db),runTransaction:async fn=>{const result=await db.runTransaction(fn);if(!injected){injected=true;throw Error('LOST_REFUSAL_RESPONSE');}return result;}};
 const admission=require('../../api/account/_historical_admission.cjs');await assert.rejects(admission.refuseUnprovenAdmission(wrapped,{projectId:db.projectId,databaseId:db.databaseId,uid:f.uid},'PRE_AUTH'));assert.equal(injected,true);await refusal(f);
});

test('B1 backend: external Auth removal after refusal does not let delayed callback/continuation bypass review',async()=>{
 const f=await fixture();const original=await refusal(f);
 await realAuth.deleteUser(f.uid);
 await assert.rejects(call(f),e=>e.code==="ACCOUNT_DELETION_BLOCKED");
 assert.deepEqual((await db.doc(f.base+'/control/admission_review').get()).data(),original);
 for(const {p,data,version}of f.before){const s=await db.doc(p).get();assert.deepEqual(s.data(),data);assert.ok(s.updateTime.isEqual(version));}
 await assert.rejects(realAuth.getUser(f.uid),e=>e.code==='auth/user-not-found');
 assert.deepEqual(counts,{lookup:0,dispatch:0});
});
