const test=require('node:test'),assert=require('node:assert/strict');
const custody=require('../api/_http_generation_custody.cjs');
const vectors=require('./fixtures/http-number-vectors.json');
test('server decimal canonicalization matches shared request/response vectors',()=>{
  for(const v of vectors){assert.equal(custody.canonical(v.value),v.canonical);assert.equal(custody.hash(v.value),v.hash);}
});
test('unsafe and non-finite numbers are refused without coercing strings',()=>{
  for(const n of [2**53,2**54,NaN,Infinity,-Infinity])assert.throws(()=>custody.canonical(n),e=>e.code==='HTTP_CUSTODY_BODY_UNSUPPORTED');
  assert.equal(custody.canonical('12.34'),'"12.34"');
});
