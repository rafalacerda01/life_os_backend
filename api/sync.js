import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

// 🛡️ Inicialização segura do Firebase Admin
if (!getApps().length) {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/"/g, '')
    : undefined;

  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: privateKey,
    }),
  });
}

const db = getFirestore();

export default async function handler(req, res) {
  
  // ========================================================================
  // 🛡️ CORREÇÃO SEGURA DO CORS (Deve vir ANTES do req.method === 'OPTIONS')
  // ========================================================================
  const origin = req.headers.origin;
  const allowedOrigins = [
    'https://painel.life-os.com', 
    'https://app.life-os.com',
    'http://localhost:3000'
  ];

  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // ========================================================================

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  // 2. Verificação Rigorosa do Token do Firebase
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Acesso negado. Token não fornecido.' });
  }

  const token = authHeader.split('Bearer ')[1];
  let decodedToken;

  try {
    decodedToken = await getAuth().verifyIdToken(token);
  } catch (error) {
    console.error('Erro ao verificar o token Firebase:', error.message);
    return res.status(403).json({ error: 'Token inválido ou expirado.' });
  }

  try {
    const userId = decodedToken.uid;
    const { timestamp, tasks, habits, finances } = req.body || {};

    // 3. Validação de Tipagem do Payload (Anti-Corrupção de Dados)
    if (
      (tasks && !Array.isArray(tasks)) ||
      (habits && !Array.isArray(habits)) ||
      (finances && !Array.isArray(finances))
    ) {
      return res.status(400).json({ error: 'Formato de dados inválido. As coleções devem ser do tipo array.' });
    }

    console.log(`Processando sincronização para o usuário: ${userId}`);

    const userRef = db.collection('users').doc(userId);
    const serverIsoString = new Date().toISOString();

    // 4. Estruturação segura dos dados para escrita parcial ou total
    const payloadToSave = {
      lastSync: timestamp || serverIsoString,
      updatedAt: serverIsoString,
    };

    if (tasks !== undefined) payloadToSave.tasks = tasks;
    if (habits !== undefined) payloadToSave.habits = habits;
    if (finances !== undefined) payloadToSave.finances = finances;

    // Salvando no Firestore de forma atômica
    await userRef.set(payloadToSave, { merge: true });

    return res.status(200).json({
      success: true,
      message: "Sincronização concluída e salva no Firestore com sucesso.",
      serverTimestamp: serverIsoString,
    });

  } catch (error) {
    console.error("Erro crítico no processo de sincronização com o banco:", error);
    return res.status(500).json({ error: "Erro interno ao processar a sincronização." });
  }
}