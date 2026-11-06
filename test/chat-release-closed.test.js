import test from 'node:test';
import assert from 'node:assert/strict';
import endpoint from '../api/chat.js';
// No app initialization, ADC, environment credential, Auth, billing or model IO.
test('deployed AI endpoint is CLOSED even with caller-supplied runtime', async () => {
  for (const method of ['POST','GET','DELETE']) {
    const res={status(n){this.code=n;return this;},json(body){this.body=body;return this;},setHeader(){}};
    const forbidden=new Proxy({}, {get(){throw Error('NO_RUNTIME_ACCESS_ALLOWED');}});
    await endpoint({method,headers:{}},res,forbidden);
    assert.equal(res.code,503);assert.deepEqual(res.body,{code:'AI_RELEASE_CLOSED',error:'Companion IA indisponível nesta versão.'});
  }
});
test('closed AI entry retains preflight without executing any service', async () => {
  const res={status(n){this.code=n;return this;},end(){this.ended=true;},setHeader(){}};
  await endpoint({method:'OPTIONS',headers:{}},res);
  assert.equal(res.code,204);assert.equal(res.ended,true);
});
