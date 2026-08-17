import { initializeApp, cert, getApps } from 'firebase-admin/app';
import {
  FieldValue,
  getFirestore,
} from 'firebase-admin/firestore';

// ============================================================================
// LIFE OS - TEMPORARY COUNTERS BACKFILL
// ============================================================================
//
// Endpoint temporário para recalcular contadores a partir das coleções reais.
//
// IMPORTANTE:
// - protegido por BACKFILL_SECRET;
// - usar somente durante a migração;
// - remover imediatamente após o backfill;
// - nunca commitar o segredo.
// ============================================================================

if (!getApps().length) {
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
      'Firebase Admin environment is not completely configured.',
    );
  }

  initializeApp({
    credential: cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });
}

const db = getFirestore();

export default async function handler(
  req,
  res,
) {
  // --------------------------------------------------------------------------
  // SOMENTE POST
  // --------------------------------------------------------------------------

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Método não permitido.',
    });
  }

  // --------------------------------------------------------------------------
  // AUTORIZAÇÃO DO BACKFILL
  // --------------------------------------------------------------------------

  const expectedSecret =
    process.env.BACKFILL_SECRET;

  const authorization =
    req.headers.authorization;

  if (
    !expectedSecret ||
    typeof authorization !== 'string' ||
    !authorization.startsWith('Bearer ')
  ) {
    return res.status(401).json({
      error: 'Não autorizado.',
    });
  }

  const providedSecret =
    authorization
      .slice('Bearer '.length)
      .trim();

  if (
    !providedSecret ||
    providedSecret !== expectedSecret
  ) {
    return res.status(401).json({
      error: 'Não autorizado.',
    });
  }

  try {
    const usersSnapshot =
      await db.collection('users').get();

    let updated = 0;
    let unchanged = 0;

    for (const userDoc of usersSnapshot.docs) {
      const userData =
        userDoc.data() ?? {};

      const [
        habitsSnapshot,
        tasksSnapshot,
        goalsSnapshot,
        subjectsSnapshot,
        medicationsSnapshot,
        transactionsSnapshot,
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

        userDoc.ref
          .collection('medications')
          .get(),

        userDoc.ref
          .collection('transactions')
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

      const medicationsCount =
        medicationsSnapshot.size;

      const transactionsCount =
        transactionsSnapshot.size;

      const currentHabitsCount =
        userData.habitsCount;

      const currentTasksCount =
        userData.tasksCount;

      const currentGoalsCount =
        userData.goalsCount;

      const currentSubjectsCount =
        userData.subjectsCount;

      const currentMedicationsCount =
        userData.medicationsCount;

      const currentTransactionsCount =
        userData.transactionsCount;

      if (
        currentHabitsCount ===
          habitsCount &&
        currentTasksCount ===
          tasksCount &&
        currentGoalsCount ===
          goalsCount &&
        currentSubjectsCount ===
          subjectsCount &&
        currentMedicationsCount ===
          medicationsCount &&
        currentTransactionsCount ===
          transactionsCount
      ) {
        unchanged++;
        continue;
      }

      await userDoc.ref.update({
        habitsCount,
        tasksCount,
        goalsCount,
        subjectsCount,
        medicationsCount,
        transactionsCount,
        updatedAt:
          FieldValue.serverTimestamp(),
      });

      updated++;
    }

    return res.status(200).json({
      success: true,
      users: usersSnapshot.size,
      updated,
      unchanged,
    });
  } catch (error) {
    console.error(
      'Erro ao executar backfill:',
      error?.message ?? 'unknown_error',
    );

    return res.status(500).json({
      error:
        'Não foi possível executar o backfill.',
    });
  }
}