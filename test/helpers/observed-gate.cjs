'use strict';
// A controlled pause is meaningful only if the operation actually reaches it.
// Attach both completion/rejection observers before yielding. The original
// operation is still awaited by the test after release; errors are not silenced.
module.exports=function reachOrFail(gate,operation){
 return Promise.race([gate,Promise.resolve(operation).then(value=>{
   if(value instanceof Error)throw value;
   if(value && Object.hasOwn(value,'error'))throw value.error;
   throw Object.assign(new Error('Operation finished before the controlled pause.'),{code:'TEST_GATE_NOT_REACHED'});
 },error=>{throw error;})]);
};
