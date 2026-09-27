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
  if (!validPath || uid.length > 128 || snapshot.id !== uid) {
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
        scanned: 0, candidates: 0, updated: 0, unchanged: 0, deleted: 0,
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
          if (!apply) {
            if (!owner.missing) counts.unchanged++;
            continue;
          }

          // A transaction revalidates ownership and cannot recreate a deleted doc.
          const outcome = await db.runTransaction(async (transaction) => {
            const current = await transaction.get(snapshot.ref);
            if (!current.exists) return 'deleted';
            const latest = ownership(current, group);
            if (!latest.missing) return 'unchanged';
            transaction.update(snapshot.ref, { uid: latest.uid });
            return 'updated';
          });
          counts[outcome]++;
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

// Importing this module for unit tests never initializes Admin or runs a scan.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--apply')) {
      throw new CircleOwnershipBackfillError();
    }
    await backfillCircleOwnership({ db: initializeDatabase(), apply: args[0] === '--apply' });
  } catch (_) {
    console.error('Circle ownership backfill failed closed.');
    process.exitCode = 1;
  }
}
