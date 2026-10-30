'use strict';
const fs=require('node:fs'),net=require('node:net'),dns=require('node:dns'),{createRequire,syncBuiltinESMExports}=require('node:module');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const pkg=path.join(root,'package.json');
const host=process.env.FIRESTORE_EMULATOR_HOST;
if(!/^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(host||'')||process.env.GCLOUD_PROJECT!=='demo-life-os'||process.env.GOOGLE_CLOUD_PROJECT!=='demo-life-os')throw Error('DEMO_LOOPBACK_REQUIRED');
for(const key of ['GOOGLE_APPLICATION_CREDENTIALS','FIREBASE_TOKEN','FIREBASE_PRIVATE_KEY','FIREBASE_CLIENT_EMAIL','GOOGLE_OAUTH_ACCESS_TOKEN','FIREBASE_CONFIG','FIREBASE_EMULATOR_HUB','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY'])if(process.env[key]!==undefined)throw Error('EXTERNAL_CONFIGURATION_REFUSED');
const port=Number(host.split(':')[1]);if(port>65535)throw Error('PORT_INVALID');
const evidence={pid:process.pid,project:'demo-life-os',host,connections:0,refused:[],adc:[]};
function deny(kind){evidence.refused.push(kind);throw Error('NON_EMULATOR_IO_REFUSED:'+kind);}
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){const first=Array.isArray(args[0])?args[0][0]:args[0];const opts=typeof first==='object'?first:{port:first,host:args[1]};
 if(opts?.host!=='127.0.0.1'||Number(opts.port)!==port)deny('socket');evidence.connections++;return connect.apply(this,args);};
for(const mod of [dns,require('node:dns/promises')]){const lookup=mod.lookup;mod.lookup=function(name,...args){if(name!=='127.0.0.1')deny('dns');return lookup.call(this,name,...args);};
 if(mod.Resolver)for(const key of Object.getOwnPropertyNames(mod.Resolver.prototype))if(key.startsWith('resolve')||key==='reverse')mod.Resolver.prototype[key]=()=>deny('dns.Resolver');}
for(const mod of [dns,require('node:dns/promises')])for(const k of Object.keys(mod))if(k.startsWith('resolve')||k==='reverse'||k==='lookupService')mod[k]=()=>deny('dns.'+k);
{
 const {GoogleAuth}=createRequire(pkg)('google-auth-library');
 for(const k of ['getApplicationDefault','getApplicationDefaultAsync','_getApplicationCredentialsFromFilePath','_tryGetApplicationCredentialsFromWellKnownFile','_tryGetApplicationCredentialsFromEnvironmentVariable'])GoogleAuth.prototype[k]=()=>{evidence.adc.push(k);throw Error('ADC_FORBIDDEN');};
}
require('node:dgram').createSocket=()=>deny('udp');
if(global.WebSocket)global.WebSocket=class{constructor(){deny('websocket');}};
const fetch=global.fetch;global.fetch=function(url,...rest){const parsed=new URL(typeof url==='string'?url:url.url||url);if(parsed.protocol!=='http:'||parsed.host!==host)deny('fetch');return fetch(url,...rest);};
syncBuiltinESMExports();
process.on('exit',()=>{fs.writeFileSync(process.env.K01_EVIDENCE_DIR+'/emulator-io-'+process.pid+'.json',JSON.stringify(evidence,null,2));if(evidence.refused.length||evidence.adc.length)process.exitCode=1;});
