const test=require('node:test'),assert=require('node:assert/strict'),reachOrFail=require('./helpers/observed-gate.cjs');
test('gate observer propagates the exact early rejection, without declaring the pause reached',async()=>{
 const original=new Error('EARLY_REFUSAL');await assert.rejects(reachOrFail(new Promise(()=>{}),Promise.reject(original)),e=>e===original);
});
test('early completion cannot be mistaken for a reached destructive boundary',async()=>{
 await assert.rejects(reachOrFail(new Promise(()=>{}),Promise.resolve({ok:true})),e=>e.code==='TEST_GATE_NOT_REACHED');
});
test('a reached gate never hides the original later rejection',async()=>{
 let reject;const operation=new Promise((_,r)=>{reject=r;});await reachOrFail(Promise.resolve(),operation);
 const original=new Error('LATE_REAL_FAILURE'),observed=assert.rejects(operation,e=>e===original);reject(original);await observed;
});
