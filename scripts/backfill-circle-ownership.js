import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { FieldPath, getFirestore } from 'firebase-admin/firestore';

const DEFAULT_PAGE_SIZE = 200;
const GROUPS = ['progress', 'ranking'];

export class CircleOwnershipBackfillError extends Error {
  constructor() {
    super('Circle ownership backfill failed closed.');
  }
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

async function inspectCircleOwnership(reader, db, circleId) {
  const rootRef = db.doc('circles/' + circleId);
  const root = await readDocument(reader, rootRef);
  const marker = await readDocument(reader, db.doc('circle_deletions/' + circleId));
  const closure = await readDocument(reader, db.doc('circle_cleanup_guards/' + circleId));
  const data = root.data();
  if (!root.exists || !data || data.schemaVersion !== 2 ||
      !validUid(data.adminId) || Object.hasOwn(data, 'deletionState') ||
      marker.exists || closure.exists) return false;
  const admin = await readDocument(reader, rootRef.collection('members').doc(data.adminId));
  if (!admin.exists || admin.data().role !== 'admin' ||
      (Object.hasOwn(admin.data(), 'uid') && admin.data().uid !== data.adminId)) return false;
  return true;
}

function ownership(snapshot, group) {
  const parts = snapshot.ref.path.split('/');
  const validId = (id) =>
    id.length > 0 && id.trim() === id && id !== '.' && id !== '..';
  const validPath =
    parts.every(validId) && parts[0] === 'circles' &&
    (group === 'progress'
      ? parts.length === 6 && parts[2] === 'challenges' && parts[4] === group
      : parts.length === 4 && parts[2] === group);
  const uid = parts.at(-1);
  if (!validPath || !validUid(uid) || snapshot.id !== uid) {
    throw new CircleOwnershipBackfillError();
  }

  const data = snapshot.data();
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new CircleOwnershipBackfillError();
  }
  if (Object.hasOwn(data, 'uid')) {
    if (data.uid !== uid) throw new CircleOwnershipBackfillError();
    return { uid, missing: false };
  }
  return { uid, missing: true };
}

export async function backfillCircleOwnership({
  db,
  apply = false,
  pageSize = DEFAULT_PAGE_SIZE,
  log = console.log,
}) {
  if (typeof apply !== 'boolean' || !Number.isInteger(pageSize) ||
      pageSize < 1 || pageSize > DEFAULT_PAGE_SIZE) {
    throw new CircleOwnershipBackfillError();
  }
  const totals = { apply };
  try {
    for (const group of GROUPS) {
      const counts = {
        scanned: 0, candidates: 0, updated: 0, unchanged: 0, deleted: 0, retired: 0,
      };
      totals[group] = counts;
      let cursor;
      while (true) {
        let query = db.collectionGroup(group)
          .orderBy(FieldPath.documentId()).limit(pageSize);
        if (cursor) query = query.startAfter(cursor);
        const page = await query.get();
        if (page.docs.length === 0) break;

        // Validate the whole bounded page before starting any writes in it.
        const owners = page.docs.map((snapshot) => ownership(snapshot, group));
        for (let index = 0; index < page.docs.length; index++) {
          const snapshot = page.docs[index];
          const owner = owners[index];
          counts.scanned++;
          if (owner.missing) counts.candidates++;
          const outcome = await db.runTransaction(async (transaction) => {
            const current = await readDocument(transaction, snapshot.ref);
            if (!current.exists) return 'deleted';
            const latest = ownership(current, group);
            if (latest.uid !== owner.uid) throw new CircleOwnershipBackfillError();
            if (await isRetired(transaction, db, latest.uid)) return 'retired';
            const parts = current.ref.path.split('/');
            if (!await inspectCircleOwnership(transaction, db, parts[1])) {
              throw new CircleOwnershipBackfillError();
            }
            if (group === 'progress') {
              const challenge = await readDocument(transaction, db.doc(parts.slice(0, 4).join('/')));
              if (!challenge.exists || ![1, 2].includes(challenge.data().schemaVersion) ||
                  Object.hasOwn(challenge.data(), 'deletionState')) {
                throw new CircleOwnershipBackfillError();
              }
            }
            if (!latest.missing) return 'unchanged';
            if (!apply) return null;
            transaction.update(snapshot.ref, { uid: latest.uid });
            return 'updated';
          });
          if (outcome !== null) counts[outcome]++;
        }
        cursor = page.docs.at(-1);
        log(JSON.stringify(totals));
      }
    }
    log(JSON.stringify(totals));
    return totals;
  } catch (_) {
    // Never propagate SDK errors containing document paths or credentials.
    throw new CircleOwnershipBackfillError();
  }
}

function initializeDatabase() {
  const envPath = fileURLToPath(new URL('../.env.local', import.meta.url));
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator < 1) continue;
      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!projectId || !clientEmail || !privateKey) {
    throw new CircleOwnershipBackfillError();
  }
  if (!getApps().length) {
    initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  }
  return getFirestore();
}

export function parseArgs(args) {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--apply')) {
    throw new CircleOwnershipBackfillError();
  }
  return { apply: args[0] === '--apply' };
}

export async function runCli(args, dependencies = {}) {
  try {
    const options = parseArgs(args);
    const db = (dependencies.initializeDatabase ?? initializeDatabase)();
    if (typeof db.projectId !== 'string' || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(db.projectId)) {
      throw new CircleOwnershipBackfillError();
    }
    const result = await backfillCircleOwnership({ db, apply: options.apply, log: dependencies.log ?? console.log });
    return GROUPS.some(group => result[group].retired > 0) ? 1 : 0;
  } catch (_) { throw new CircleOwnershipBackfillError(); }
}

// Importing this module for unit tests never initializes Admin or runs a scan.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    console.error('Circle ownership backfill failed closed.');
    process.exitCode = 1;
  });
}
