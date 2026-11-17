'use strict';
// Server-owned nominal selection. HTTP headers/body never configure this policy.
const profile=require('./p1_native_environment.json');
const PROD_APP='1:278760083864:android:3e698113400113022d1bed';
function fail(code){const e=new Error(code);e.code=code;throw e;}
function requireNominalProfile(){
 if(profile.version!==1||profile.profileId!=='p1-life-os-27b92-android-local'||profile.projectId!=='life-os-27b92'||profile.projectNumber!=='278760083864'||profile.packageName!=='com.rafalacerda.lifeos.p1nativegate'||profile.databaseId!=='(default)'||profile.tenantId!==null||profile.authEmulator!=='127.0.0.1:45099'||profile.firestoreEmulator!=='127.0.0.1:45089'||profile.backendBaseUrl!=='http://127.0.0.1:45789')fail('LOCAL_ENVIRONMENT_MISMATCH');
 if(profile.state!=='LOCAL_HOMOLOGATION_AUTHORIZED'||profile.egressAuthorized!==true||profile.debugRegistrationApproved!==true||typeof profile.appId!=='string'||!/^1:278760083864:android:[a-f0-9]{16,40}$/.test(profile.appId)||profile.appId===PROD_APP)fail('LOCAL_ENVIRONMENT_PENDING_AUTHORIZATION');
 return Object.freeze({...profile});
}
function selectedProject(){
 const selected=process.env.LIFE_OS_LOCAL_PROFILE;
 if(selected===undefined)return 'demo-life-os';
 if(selected!==profile.profileId)fail('LOCAL_ENVIRONMENT_MISMATCH');
 const p=requireNominalProfile();
 if(process.env.FIREBASE_AUTH_EMULATOR_HOST!==p.authEmulator||process.env.FIRESTORE_EMULATOR_HOST!==p.firestoreEmulator)fail('LOCAL_ENVIRONMENT_MISMATCH');
 return p.projectId;
}
module.exports=Object.freeze({requireNominalProfile,selectedProject});
