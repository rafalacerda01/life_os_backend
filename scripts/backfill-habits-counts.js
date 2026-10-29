import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FieldPath, FieldValue } from 'firebase-admin/firestore';

export class CountsBackfillError extends Error {
  constructor() { super('Counts backfill failed closed.'); }
}

function validUid(value) {
  return typeof value === 'string' && value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 128 && value.trim() === value &&
    !value.includes('/') && !['.', '..'].includes(value) &&
    !/^__.*__$/.test(value) && ![...value].some(char =>
      char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

async function readDocument(reader, ref) {
  const snapshot = await reader.get(ref);
  if (!snapshot || typeof snapshot.exists !== 'boolean' ||
      snapshot.ref?.path !== ref.path || typeof snapshot.data !== 'function') {
    throw new Error('MAINTENANCE_READ_UNDETERMINED');
  }
  const data = snapshot.data();
  if (snapshot.exists ? data === undefined || data === null : data !== undefined) {
    throw new Error('MAINTENANCE_READ_UNDETERMINED');
  }
  return snapshot;
}

async function isRetired(reader, db, uid) {
  if (!validUid(uid)) throw new Error('MAINTENANCE_IDENTITY_INVALID');
  const controls = [];
  for (const path of ['retired_auth_identities/' + uid,
    'account_deletion_guards/' + uid,
    'account_deletion_guards/' + uid + '/control/operation']) {
    controls.push(await readDocument(reader, db.doc(path)));
  }
  // Presence is deny-only, not proof of cleanup or permission to recover it.
  return controls.some(snapshot => snapshot.exists);
}

const COUNTERS = ['habits', 'tasks', 'goals', 'subjects', 'medications', 'transactions'];

export async function backfillUserCounts(db, userRef, { apply = false } = {}) {
  try {
    if (typeof apply !== 'boolean' || !validUid(userRef.id) ||
        userRef.path !== 'users/' + userRef.id) throw new CountsBackfillError();
    return await db.runTransaction(async tx => {
      if (await isRetired(tx, db, userRef.id)) return { status: 'RETIRED' };
      const root = await readDocument(tx, userRef);
      if (!root.exists) return { status: 'MISSING' };
      const data = root.data();
      if (typeof data !== 'object' || Array.isArray(data) ||
          (Object.hasOwn(data, 'uid') && data.uid !== userRef.id) ||
          Object.hasOwn(data, 'deletionState')) throw new CountsBackfillError();
      const patch = {};
      // Public Transaction.get(AggregateQuery) in Firestore 8.7.1: all six
      // counts belong to this attempt; do not fall back to nontransactional get.
      for (const collection of COUNTERS) {
        const result = await tx.get(userRef.collection(collection).count());
        const count = result?.data?.()?.count;
        if (!Number.isSafeInteger(count) || count < 0) throw new CountsBackfillError();
        patch[collection + 'Count'] = count;
      }
      if (Object.entries(patch).every(([key, value]) => data[key] === value)) {
        return { status: 'UNCHANGED' };
      }
      if (!apply) return { status: 'CANDIDATE' };
      tx.update(userRef, { ...patch, updatedAt: FieldValue.serverTimestamp() });
      return { status: 'APPLIED' };
    });
  } catch (_) { throw new CountsBackfillError(); }
}

export async function backfillHabitsCounts({ db, apply = false, pageSize = 200, log = console.log }) {
  try {
    if (typeof apply !== 'boolean' || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
      throw new CountsBackfillError();
    }
    const counts = { CANDIDATE: 0, APPLIED: 0, UNCHANGED: 0, MISSING: 0, RETIRED: 0 };
    let cursor;
    for (;;) {
      let query = db.collection('users').orderBy(FieldPath.documentId()).limit(pageSize);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (page.empty) break;
      for (const doc of page.docs) counts[(await backfillUserCounts(db, doc.ref, { apply })).status]++;
      cursor = page.docs.at(-1);
    }
    log(JSON.stringify({ apply, counts }));
    return counts;
  } catch (_) { throw new CountsBackfillError(); }
}

export function parseArgs(args) {
  let apply = false, projectId;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--apply' && !apply) apply = true;
    else if (args[index] === '--project' && !projectId) projectId = args[++index];
    else throw new CountsBackfillError();
  }
  if (typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId)) {
    throw new CountsBackfillError();
  }
  return { apply, projectId };
}

function loadEnvFile() {
  const envPath = fileURLToPath(new URL('../.env.local', import.meta.url));
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const separator = text.indexOf('=');
    if (separator < 1) continue;
    const key = text.slice(0, separator).trim();
    let value = text.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function initializeDatabase(projectId) {
  loadEnvFile();
  if (process.env.FIREBASE_PROJECT_ID !== projectId || !process.env.FIREBASE_CLIENT_EMAIL ||
      !process.env.FIREBASE_PRIVATE_KEY) throw new CountsBackfillError();
  const { cert, getApps, initializeApp } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  // Refuse an ambient app whose credentials/project were not selected here.
  if (getApps().length) throw new CountsBackfillError();
  const app = initializeApp({ projectId, credential: cert({ projectId,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') }) });
  const db = getFirestore(app);
  if (db.projectId !== projectId) throw new CountsBackfillError();
  return db;
}

export async function runCli(args, dependencies = {}) {
  try {
    const options = parseArgs(args);
    const db = await (dependencies.initializeDatabase ?? initializeDatabase)(options.projectId);
    if (db.projectId !== options.projectId) throw new CountsBackfillError();
    const counts = await backfillHabitsCounts({ db, apply: options.apply, log: dependencies.log ?? console.log });
    return counts.RETIRED > 0 ? 1 : 0;
  } catch (_) { throw new CountsBackfillError(); }
}

// The only administrative entrypoint. Import performs no environment or IO work.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    console.error('Counts backfill failed closed.');
    process.exitCode = 1;
  });
}
