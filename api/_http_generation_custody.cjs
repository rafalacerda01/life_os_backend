'use strict';
// Bounded HTTP protocol. Metadata is consistency evidence, never origin authority.
const {createHash} = require('node:crypto');
const {AsyncLocalStorage} = require('node:async_hooks');
const {Timestamp} = require('firebase-admin/firestore');
const controls = require('./account/_deletion_control.cjs');
const current = new AsyncLocalStorage();
const HEX = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SYNC = new Set(['create_task','delete_task','update_task','create_habit','delete_habit','update_habit','update_habit_completion',
  'create_transaction','delete_transaction','create_goal','delete_goal','update_goal',
  'create_medication','delete_medication','create_subject','create_review_card',
  'apply_study_activity','apply_study_progress_reset','apply_study_review','delete_notification','upsert_checkin']);
class CustodyError extends Error {
  constructor(code) { super(code); this.code=code; this.statusCode=409; }
}
function fail(code='HTTP_CUSTODY_INVALID') { throw new CustodyError(code); }
function plain(v) { return v && typeof v==='object' && !Array.isArray(v) && [Object.prototype,null].includes(Object.getPrototypeOf(v)); }
function exact(v,keys) { return plain(v) && Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k)); }
function canonical(v) {
  if (v===null || typeof v==='string' || typeof v==='boolean') return JSON.stringify(v);
  if (typeof v==='number' && Number.isFinite(v) && Math.abs(v)<=Number.MAX_SAFE_INTEGER) return JSON.stringify(v);
  if (Array.isArray(v)) return '['+v.map(canonical).join(',')+']';
  if (plain(v)) return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
  fail('HTTP_CUSTODY_BODY_UNSUPPORTED');
}
function hash(v) { return createHash('sha256').update(canonical(v)).digest('hex'); }
function freeze(v) { if(v && typeof v==='object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
function parse(req,decoded,db,route) {
  const raw=req.headers?.['x-lifeos-operation'];
  // Legacy branch must not inspect the database or grant trusted provenance.
  if(raw===undefined && decoded.lifeos_generation===undefined) return null;
  if(typeof raw!=='string' || raw.length>4096 || !/^[A-Za-z0-9_-]+$/.test(raw)) fail('HTTP_CUSTODY_REQUIRED');
  let c; try { c=JSON.parse(Buffer.from(raw,'base64url').toString('utf8')); } catch { fail(); }
  // v1 client IDs could alias across installations. Never replay their
  // receipts as confirmation of a new intent or silently upgrade the context.
  if(c?.v===1) fail('HTTP_LEGACY_OPERATION_REVIEW_REQUIRED');
  const b=c?.binding;
  if(!exact(c,['v','binding','operationId','route','bodyHash']) || c.v!==2 || !HEX.test(c.operationId) || !HEX.test(c.bodyHash) || c.route!==route ||
      !exact(b,['v','project','database','tenant','uid','generation']) || b.v!==2 || b.project!==require('../config/local_homologation_environment.cjs').selectedProject() || b.database!=='(default)' || b.tenant!==null ||
      typeof b.uid!=='string' || !b.uid || b.uid.includes('/') || !UUID.test(b.generation) || b.project!==db.projectId || b.database!==db.databaseId ||
      decoded.uid!==b.uid || decoded.sub!==b.uid || decoded.aud!==b.project || decoded.iss!=='https://securetoken.google.com/'+b.project ||
      (decoded.firebase?.tenant ?? null)!==b.tenant || decoded.lifeos_generation!==b.generation) fail('HTTP_CUSTODY_IDENTITY_MISMATCH');
  if(route==='sync' ? !SYNC.has(req.body?.operation) : !['activity/task-complete','focus/start','focus/finish','focus/cancel','focus/status'].includes(route)) fail('HTTP_CUSTODY_ROUTE_CLOSED');
  if(hash(req.body)!==c.bodyHash) fail('HTTP_CUSTODY_BODY_MISMATCH');
  return {context:freeze(c),body:freeze(JSON.parse(canonical(req.body))),transactions:0,confirmed:false,replayed:false};
}
// Tagged representation avoids Timestamp loss and object/tag collisions. Only
// reviewed one-transaction kernels may participate; no sequential chunk cache.
function pack(v) {
  if(v===undefined) return ['undefined'];
  if(v instanceof Timestamp) return ['timestamp',v.seconds,v.nanoseconds];
  if(v instanceof Date && Number.isFinite(v.getTime())) return ['date',v.toISOString()];
  if(v===null || ['string','boolean'].includes(typeof v) || (typeof v==='number' && Number.isFinite(v))) return ['value',v];
  if(Array.isArray(v)) return ['array',v.map(pack)];
  if(plain(v)) return ['object',Object.keys(v).sort().map(k=>[k,pack(v[k])])];
  fail('HTTP_CUSTODY_RESULT_UNSUPPORTED');
}
function unpack(v) {
  if(!Array.isArray(v)) fail('HTTP_CUSTODY_RECEIPT_INVALID');
  switch(v[0]) {
    case 'undefined': return undefined;
    case 'timestamp': return new Timestamp(v[1],v[2]);
    case 'date': { const d=new Date(v[1]); if(!Number.isFinite(d.getTime()) || d.toISOString()!==v[1]) fail('HTTP_CUSTODY_RECEIPT_INVALID'); return d; }
    case 'value': return v[1];
    case 'array': return v[1].map(unpack);
    case 'object': return Object.fromEntries(v[1].map(([k,x])=>[k,unpack(x)]));
    default: fail('HTTP_CUSTODY_RECEIPT_INVALID');
  }
}
function run(operation,callback) { return current.run(operation,callback); }
async function transaction(db,uid,callback,...options) {
  const op=current.getStore();
  if(!op) return controls.withNormalWriterTransactions(db,uid).runTransaction(callback,...options);
  if(++op.transactions!==1 || uid!==op.context.binding.uid) fail('HTTP_CUSTODY_ROUTE_CLOSED');
  const ref=db.collection('users').doc(uid).collection('_http_operations_v1').doc(op.context.operationId);
  const result=await db.runTransaction(async tx=>{
    // Includes all three controls AND origin; deliberately before receipt replay.
    await controls.assertNormalWriterTransaction(tx,db,uid);
    // Reconciliation is a fresh read, never a cached historical command result.
    // It uses the same immutable identity, R5 checks and ACK, with no server
    // receipt or domain mutation. Repeated status requests read current state.
    if(op.context.route==='focus/status') {op.replayed=false;return callback(tx);}
    const snap=await tx.get(ref);
    if(snap.exists) {
      const r=snap.data();
      if(!exact(r,['version','context','result','resultHash']) || r.version!==1 || canonical(r.context)!==canonical(op.context) ||
          typeof r.result!=='string' || createHash('sha256').update(r.result).digest('hex')!==r.resultHash) fail('HTTP_CUSTODY_RECEIPT_CONFLICT');
      op.replayed=true;
      return unpack(JSON.parse(r.result));
    }
    op.replayed=false;
    const value=await callback(tx), packed=JSON.stringify(pack(value));
    if(Buffer.byteLength(packed)>128*1024) fail('HTTP_CUSTODY_RESULT_LIMIT');
    tx.create(ref,{version:1,context:op.context,result:packed,resultHash:createHash('sha256').update(packed).digest('hex')});
    return value;
  },...options);
  op.confirmed=true;
  return result;
}
function database(db,uid) { return Object.freeze({collection:db.collection.bind(db),runTransaction:(cb,...opts)=>transaction(db,uid,cb,...opts)}); }
function ack(op,res,body,status=200) {
  if(!op) return;
  if(!op.confirmed || op.transactions!==1) fail('HTTP_CUSTODY_UNCONFIRMED');
  const value={...op.context,status,responseHash:hash(body),operationReplay:op.replayed};
  res.setHeader('X-LifeOS-Operation-Ack',Buffer.from(canonical(value)).toString('base64url'));
}
module.exports={CustodyError,canonical,hash,parse,run,transaction,database,ack};
