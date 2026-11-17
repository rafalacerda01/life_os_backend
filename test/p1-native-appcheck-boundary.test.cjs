'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {getApps}=require('firebase-admin/app');
const {selectedProject,requireNominalProfile}=require('../config/local_homologation_environment.cjs');
const {createOfficialVerifier,assertVerifiedIdentity}=require('../tools/p1_native_local/official_app_check.cjs');
const {start}=require('../tools/p1_native_local/server.cjs');
test('nominal profile is closed before SDK/listener initialization',async()=>{
 const before=getApps().length;assert.throws(requireNominalProfile,{code:'LOCAL_ENVIRONMENT_PENDING_AUTHORIZATION'});
 await assert.rejects(start(),{code:'LOCAL_ENVIRONMENT_PENDING_AUTHORIZATION'});assert.equal(getApps().length,before);
});
test('server-selected profile cannot be replaced by arbitrary environment/project',()=>{
 const previous=process.env.LIFE_OS_LOCAL_PROFILE;
 try{delete process.env.LIFE_OS_LOCAL_PROFILE;assert.equal(selectedProject(),'demo-life-os');
 process.env.LIFE_OS_LOCAL_PROFILE='production';assert.throws(selectedProject,{code:'LOCAL_ENVIRONMENT_MISMATCH'});
 process.env.LIFE_OS_LOCAL_PROFILE='p1-life-os-27b92-android-local';assert.throws(selectedProject,{code:'LOCAL_ENVIRONMENT_PENDING_AUTHORIZATION'});
 }finally{if(previous===undefined)delete process.env.LIFE_OS_LOCAL_PROFILE;else process.env.LIFE_OS_LOCAL_PROFILE=previous;}
});
test('installed real Admin SDK refuses missing/malformed App Check; no alternate verifier',async()=>{
 const v=createOfficialVerifier();try{
 for(const value of [null,undefined,'',' ',' token ',[], 'x'.repeat(16385)])await assert.rejects(v.verify(value),{code:'APP_CHECK_REQUIRED'});
 for(const value of ['invalid','a.b.c'])await assert.rejects(v.verify(value),{code:'APP_CHECK_INVALID'});
 }finally{await v.close();}
});
test('real Admin SDK fails closed when JWKS egress is not authorized (untrusted negative fixture)',async()=>{
 const v=createOfficialVerifier();try{
 const enc=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
 // Deliberately unauthenticated input: never accepted, never sent to a domain
 // endpoint, never counted as an official/native token or positive admission.
 const raw=enc({alg:'RS256',typ:'JWT',kid:'untrusted-negative'})+'.'+enc({aud:['projects/278760083864'],iss:'https://firebaseappcheck.googleapis.com/278760083864',sub:'untrusted-negative',iat:1,exp:9999999999})+'.AA';
 await assert.rejects(v.verify(raw),{code:'APP_CHECK_INVALID'});
 assert.ok(v.diagnostics().deniedJwksConnections>=1,'real JWKS connection must reach the closed egress guard');
 }finally{await v.close();}
});
// Policy-only fixtures are NOT authenticated JWTs and grant no domain access.
const appId='1:278760083864:android:1111111111111111',now=2000;
const shape=()=>({appId,token:{sub:appId,app_id:appId,iss:'https://firebaseappcheck.googleapis.com/278760083864',aud:['projects/278760083864'],iat:1990,exp:2010}});
for(const [label,change] of Object.entries({
 'another application':v=>{v.appId='other';},'official distributed application':v=>{v.appId='1:278760083864:android:3e698113400113022d1bed';},
 'wrong subject':v=>{v.token.sub='other';},'wrong app_id':v=>{v.token.app_id='other';},'issuer suffix':v=>{v.token.iss+='/other';},
 'wrong project':v=>{v.token.aud=['projects/other'];},'extra audience':v=>{v.token.aud.push('projects/other');},
 'expired':v=>{v.token.exp=now;},'future issuance':v=>{v.token.iat=now+1;},'missing expiration':v=>{delete v.token.exp;},
 'invalid interval':v=>{v.token.iat=v.token.exp;},
}))test('policy refuses '+label+'; no authentication proof',()=>{const v=shape();change(v);assert.throws(()=>assertVerifiedIdentity(v,{alg:'RS256',typ:'JWT'},appId,now),{code:'APP_CHECK_IDENTITY_INVALID'});});
for(const header of [{alg:'none',typ:'JWT'},{alg:'RS256',typ:'other'},null])test('policy refuses invalid algorithm/type '+JSON.stringify(header),()=>assert.throws(()=>assertVerifiedIdentity(shape(),header,appId,now),{code:'APP_CHECK_IDENTITY_INVALID'}));
test('policy cannot configure production app as the local expected identity',()=>assert.throws(()=>assertVerifiedIdentity(shape(),{alg:'RS256',typ:'JWT'},'1:278760083864:android:3e698113400113022d1bed',now),{code:'APP_CHECK_IDENTITY_INVALID'}));
