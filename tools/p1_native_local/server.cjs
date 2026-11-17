'use strict';
// Explicit local entry only; no Vercel route imports this server.
const http=require('node:http'),{pathToFileURL}=require('node:url');
const {initializeApp,deleteApp,getApps}=require('firebase-admin/app'),{getAuth}=require('firebase-admin/auth'),{getFirestore}=require('firebase-admin/firestore');
const {requireNominalProfile}=require('../../config/local_homologation_environment.cjs'),{createOfficialVerifier}=require('./official_app_check.cjs');
async function start(){
 const p=requireNominalProfile(); // CLOSED before SDK initialization or listen.
 if(process.env.LIFE_OS_LOCAL_PROFILE!==p.profileId||process.env.GCLOUD_PROJECT!==p.projectId||process.env.FIREBASE_AUTH_EMULATOR_HOST!==p.authEmulator||process.env.FIRESTORE_EMULATOR_HOST!==p.firestoreEmulator)throw Error('LOCAL_ENVIRONMENT_MISMATCH');
 require('../../api/account/_trusted_account.cjs').assertEnvironment({projectId:p.projectId,databaseId:p.databaseId});
 // Existing sync kernels capture getFirestore() at import. A fresh dedicated
 // process must own the DEFAULT app, explicitly pinned BEFORE those imports.
 if(getApps().length)throw Error('LOCAL_ADMIN_PROCESS_NOT_EMPTY');
 const app=initializeApp({projectId:p.projectId,credential:{getAccessToken:async()=>({access_token:'owner',expires_in:3600})}}),auth=getAuth(app),db=getFirestore(app),verifier=createOfficialVerifier();
 // The Emulator-only owner credential is never a domain Auth/App Check token.
 db.settings({host:p.firestoreEmulator,ssl:false});
 const shared=await import(pathToFileURL(require.resolve('../../api/account/_shared.js')).href),bootstrapModule=await import(pathToFileURL(require.resolve('../../api/account/bootstrap.js')).href),sync= (await import(pathToFileURL(require.resolve('../../api/sync.js')).href)).default;
 const bootstrap=shared.createAccountHandler('bootstrap','TRUSTED_ACCOUNT_BOOTSTRAP_FAILED',bootstrapModule.bootstrapTrustedAccount);
 const {terminalReceiptHandler}=await import(pathToFileURL(require.resolve('../../api/account/_terminal_receipt.js')).href);
 const runtime=Object.freeze({getServices:()=>({auth,db}),verifyIdToken:(t,r)=>auth.verifyIdToken(t,r),verifyAppCheckToken:t=>verifier.verify(t)});
 const server=http.createServer(async(req,res)=>{
  const reply=(status,body)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body));};
  try{
   // Enrollment, deletion, other routes and redirects stay CLOSED.
   const handler=req.url==='/api/account/bootstrap'?bootstrap:req.url==='/api/sync'?sync:
    req.url==='/api/account/deletion-result'?terminalReceiptHandler:null;
   if(!handler||req.method!=='POST'){reply(404,{code:'LOCAL_ROUTE_CLOSED'});return;}
   await verifier.verify(req.headers['x-firebase-appcheck']);
   let text='';for await(const c of req){text+=c;if(Buffer.byteLength(text)>65536)throw Error('LOCAL_BODY_LIMIT');}
   const body=JSON.parse(text||'{}'),response={setHeader:(k,v)=>res.setHeader(k,v),status(n){res.statusCode=n;return this;},json(v){reply(res.statusCode||200,v);return this;},end(){res.end();return this;}};
   // No client field can replace runtime verifiers, service bindings or policy.
   await handler({method:req.method,headers:req.headers,body},response,runtime);
  }catch(e){reply(e.code?.startsWith('APP_CHECK_')?401:503,{code:e.code?.startsWith('APP_CHECK_')?e.code:'LOCAL_REQUEST_UNCONFIRMED'});}
 });
 server.requestTimeout=20000;server.headersTimeout=10000;
 await new Promise((r,j)=>server.once('error',j).listen(45789,'127.0.0.1',r));
 return {async close(){server.closeAllConnections();await new Promise(r=>server.close(r));await verifier.close();await db.terminate();await deleteApp(app);}};
}
if(require.main===module)start().then(handle=>{for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>handle.close().then(()=>process.exit(0)));console.log('LOCAL_NATIVE_BOUNDARY_READY');}).catch(()=>{console.error('LOCAL_NATIVE_BOUNDARY_CLOSED');process.exitCode=1;});
module.exports={start};
