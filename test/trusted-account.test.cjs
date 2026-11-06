"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const core=require("../api/account/_trusted_account.cjs"),historical=require("../api/account/_historical_admission.cjs"),control=require("../api/account/_deletion_control.cjs");
const {MemoryFirestore}=require("./account-cleanup-memory.cjs");
test("production and incomplete environment remain CLOSED before IO",async()=>{
 let calls=0;const db={projectId:"life-os-27b92",databaseId:"(default)",doc:()=>{calls++;throw Error("MUST_NOT_READ");}};
 await assert.rejects(core.beforeCreate(db,{uid:"A"},{}),e=>e.code==="TRUSTED_ACCOUNT_CLOSED");
 await assert.rejects(core.provision(db,{getUser:()=>{calls++;}},{}),e=>e.code==="TRUSTED_ACCOUNT_CLOSED");
 assert.equal(calls,0);
});
test("genesis is never silently promoted to a destructive capability",async()=>{
 for(const value of [null,{},true,{uid:"A",eligible:true},{lifeos_generation:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}]){
  await assert.rejects(core.resolveDeletion(value),e=>["TRUSTED_ACCOUNT_CLOSED","TRUSTED_ACCOUNT_CREDENTIAL_MIX_REFUSED"].includes(e.code));
 }
});
test("unknown origin snapshot is denied, never treated as a legacy absence",async()=>{
 const db=new MemoryFirestore();await assert.rejects(core.assertWriterTransaction({get:async()=>({exists:undefined,data:()=>undefined})},db,"A"),e=>e.code==="TRUSTED_ACCOUNT_REVIEW_REQUIRED");
});
test("a review-only request preserves A/B and does not manufacture destructive R5 controls",async()=>{
 const db=new MemoryFirestore(),binding={projectId:db.projectId,databaseId:db.databaseId,uid:"A"};
 db.put("users/A",{owner:"A"});db.put("users/B",{owner:"B"});const before=new Map(db.docs);
 await assert.rejects(historical.refuseUnprovenAdmission(db,binding,"PRE_AUTH"),e=>e.code==="ACCOUNT_CLEANUP_REVIEW_REQUIRED");
 for(const[p,v]of before)assert.deepEqual(db.docs.get(p),v);
 assert.equal(db.docs.get("account_deletion_guards/A/control/admission_review").state,"REVIEW_REQUIRED");
 for(const p of ["retired_auth_identities/A","account_deletion_guards/A","account_deletion_guards/A/control/operation"])assert.equal(db.docs.has(p),false);
 await db.runTransaction(tx=>control.assertNormalWriterTransaction(tx,db,"A"));
});
for(const target of ["retired_auth_identities/A","account_deletion_guards/A","account_deletion_guards/A/control/operation"])test("review cannot release existing denial: "+target,async()=>{
 const db=new MemoryFirestore(),binding={projectId:db.projectId,databaseId:db.databaseId,uid:"A"};db.put(target,{existing:true});
 await assert.rejects(historical.refuseUnprovenAdmission(db,binding,"PRE_AUTH"),e=>e.code==="ACCOUNT_CLEANUP_REVIEW_REQUIRED");
 assert.deepEqual(db.docs.get(target),{existing:true});
 await assert.rejects(db.runTransaction(tx=>control.assertNormalWriterTransaction(tx,db,"A")),e=>e instanceof control.DeletionControlError&&e.code==="ACCOUNT_DELETION_BLOCKED");
});
