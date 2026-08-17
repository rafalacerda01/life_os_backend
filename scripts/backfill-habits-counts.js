import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  initializeApp,
  cert,
  getApps,
} from 'firebase-admin/app';

import {
  getFirestore,
  FieldValue,
} from 'firebase-admin/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadEnvFile() {
  const envPath = path.resolve(
    __dirname,
    '..',
    '.env.local',
  );

  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(
    envPath,
    'utf8',
  );

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (
      !trimmed ||
      trimmed.startsWith('#')
    ) {
      continue;
    }

    const separator =
      trimmed.indexOf('=');

    if (separator <= 0) {
      continue;
    }

    const key =
      trimmed.slice(0, separator);

    let value =
      trimmed.slice(separator + 1);

    if (
      value.startsWith('"') &&
      value.endsWith('"')
    ) {
      value = value.slice(1, -1);
    }

    if (
      value.startsWith("'") &&
      value.endsWith("'")
    ) {
      value = value.slice(1, -1);
    }

    if (
      process.env[key] === undefined
    ) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

const projectId =
  process.env.FIREBASE_PROJECT_ID;

const clientEmail =
  process.env.FIREBASE_CLIENT_EMAIL;

const privateKey =
  process.env.FIREBASE_PRIVATE_KEY?.replace(
    /\\n/g,
    '\n',
  );

if (
  !projectId ||
  !clientEmail ||
  !privateKey
) {
  throw new Error(
    'Firebase Admin environment incompleto.',
  );
}

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });
}

const db = getFirestore();

const usersSnapshot =
  await db.collection('users').get();

console.log(
  `Usuários encontrados: ${usersSnapshot.size}`,
);

let updated = 0;
let unchanged = 0;

let batch = db.batch();
let batchCount = 0;

for (const userDoc of usersSnapshot.docs) {
  const [
  habitsSnapshot,
  tasksSnapshot,
  goalsSnapshot,
  subjectsSnapshot,
] = await Promise.all([
  userDoc.ref
    .collection('habits')
    .get(),
  userDoc.ref
    .collection('tasks')
    .get(),
  userDoc.ref
    .collection('goals')
    .get(),
  userDoc.ref
    .collection('subjects')
    .get(),
]);

  const habitsCount =
    habitsSnapshot.size;

  const tasksCount =
    tasksSnapshot.size;

    const goalsCount =
  goalsSnapshot.size;

  const subjectsCount =
  subjectsSnapshot.size;

  const userData =
    userDoc.data() ?? {};

  const currentHabitsCount =
    userData.habitsCount;

  const currentTasksCount =
    userData.tasksCount;

    const currentGoalsCount =
  userData.goalsCount;

  const currentSubjectsCount =
  userData.subjectsCount;

  if (
  currentHabitsCount === habitsCount &&
  currentTasksCount === tasksCount &&
  currentGoalsCount === goalsCount &&
  currentSubjectsCount === subjectsCount
) {
  unchanged++;
  continue;
}

  batch.update(
    userDoc.ref,
    {
  habitsCount,
  tasksCount,
  goalsCount,
  subjectsCount,
  updatedAt:
    FieldValue.serverTimestamp(),
},
  );

  batchCount++;
  updated++;

  if (batchCount >= 450) {
    await batch.commit();

    console.log(
      `Lote aplicado: ${batchCount}`,
    );

    batch = db.batch();
    batchCount = 0;
  }
}

if (batchCount > 0) {
  await batch.commit();

  console.log(
    `Último lote aplicado: ${batchCount}`,
  );
}

console.log('--------------------------------');
console.log(`Atualizados: ${updated}`);
console.log(`Já corretos: ${unchanged}`);
console.log('Backfill concluído.');