'use strict';
const https=require('node:https');
const {randomUUID}=require('node:crypto');
const {initializeApp,deleteApp}=require('firebase-admin/app');
const {getAppCheck}=require('firebase-admin/app-check');
const {requireNominalProfile}=require('../../config/local_homologation_environment.cjs');
const NUMBER='278760083864',PROD_APP='1:'+NUMBER+':android:3e698113400113022d1bed';
function fail(code){const e=new Error(code);e.code=code;throw e;}
// Public-policy check only; callers cannot use it as a verifier/admission grant.
function assertVerifiedIdentity(verified,header,expectedAppId,now=Math.floor(Date.now()/1000)){
 const c=verified?.token;
 if(typeof expectedAppId!=='string'||expectedAppId===PROD_APP||!/^1:278760083864:android:[a-f0-9]{16,40}$/.test(expectedAppId)||header?.alg!=='RS256'||header.typ!=='JWT'||verified?.appId!==expectedAppId||c?.sub!==expectedAppId||c.app_id!==expectedAppId||c.iss!=='https://firebaseappcheck.googleapis.com/'+NUMBER||!Array.isArray(c.aud)||c.aud.length!==1||c.aud[0]!=='projects/'+NUMBER||!Number.isInteger(c.exp)||c.exp<=now||!Number.isInteger(c.iat)||c.iat>now||c.iat>=c.exp)fail('APP_CHECK_IDENTITY_INVALID');
}
class OfficialJwksAgent extends https.Agent {
 deniedConnections=0;
 createConnection(options,callback){
  let approved=false;try{requireNominalProfile();approved=true;}catch{}
  if(!approved||options.host!=='firebaseappcheck.googleapis.com'||Number(options.port)!==443||options.rejectUnauthorized===false){this.deniedConnections++;callback(new Error('OFFICIAL_JWKS_EGRESS_CLOSED'));return;}
  return super.createConnection({...options,rejectUnauthorized:true,servername:'firebaseappcheck.googleapis.com'},callback);
 }
}
function createOfficialVerifier(){
 // Numeric audience is required by this installed Admin SDK. This verifier-only
 // instance is separate from Auth/Firestore's named project + Emulator clients.
 const agent=new OfficialJwksAgent({keepAlive:false}),app=initializeApp({projectId:NUMBER,httpAgent:agent},'p1-native-appcheck-'+randomUUID()),check=getAppCheck(app);
 return Object.freeze({
  async verify(raw){
   if(typeof raw!=='string'||!raw||raw!==raw.trim()||raw.length>16384)fail('APP_CHECK_REQUIRED');
   let verified,timer;try{verified=await Promise.race([check.verifyToken(raw),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('APP_CHECK_TIMEOUT')),15000);})]);}catch{fail('APP_CHECK_INVALID');}finally{clearTimeout(timer);}
   // Nothing decoded here authenticates. The SDK must have verified first.
   let header;try{header=JSON.parse(Buffer.from(raw.split('.')[0],'base64url').toString('utf8'));}catch{fail('APP_CHECK_INVALID');}
   const p=requireNominalProfile();assertVerifiedIdentity(verified,header,p.appId);
   return Object.freeze({appId:p.appId,projectId:p.projectId});
  },
  diagnostics:()=>Object.freeze({deniedJwksConnections:agent.deniedConnections}),
  async close(){agent.destroy();await deleteApp(app);}
 });
}
module.exports=Object.freeze({createOfficialVerifier,assertVerifiedIdentity});
