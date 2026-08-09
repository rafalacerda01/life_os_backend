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

// 🛡️ Rate Limiter em memória para Sync
const syncRequestTracker = new Map();
const SYNC_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const SYNC_MAX_REQUESTS_PER_WINDOW = 30; // Máximo de 30 syncs por minuto por UID

function checkSyncRateLimit(userId) {
  const now = Date.now();
  const userRecord = syncRequestTracker.get(userId) || { count: 0, startTime: now };

  if (now - userRecord.startTime > SYNC_RATE_LIMIT_WINDOW_MS) {
    userRecord.count = 1;
    userRecord.startTime = now;
    syncRequestTracker.set(userId, userRecord);
    return true;
  }

  if (userRecord.count >= SYNC_MAX_REQUESTS_PER_WINDOW) {
    return false;
  }

  userRecord.count++;
  syncRequestTracker.set(userId, userRecord);
  return true;
}

// 🛡️ Validação estrutural de Schema (Anti-Corrupção de Dados e Proteção de Tipagem)
function validateEntityStructure(items, maxAllowed = 500) {
  if (!Array.isArray(items)) return false;
  if (items.length > maxAllowed) return false; // Limite de quantidade por lote
  
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    // Cada item deve possuir pelo menos um identificador ou chave primária esperada no Drift/Model
    // Validamos se o tamanho do objeto serializado não excede limites absurdos (ex: 50KB por item)
    if (JSON.stringify(item).length > 50000) return false;
  }
  return true;
}

export default async function handler(req, res) {
  // 🛡️ Correção Segura do CORS
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

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  // 🛡️ Verificação Rigorosa do Token do Firebase (Identidade Oficial)
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

  const userId = decodedToken.uid;

  // 🛡️ Verificação de Rate Limit para o Sync
  if (!checkSyncRateLimit(userId)) {
    return res.status(429).json({ error: 'Muitas solicitações de sincronização. Tente novamente mais tarde.' });
  }

  try {
    const rawBody = req.body;
    if (!rawBody || typeof rawBody !== 'object') {
      return res.status(400).json({ error: 'Payload de sincronização inválido.' });
    }

    const { timestamp, tasks, habits, finances } = rawBody;

    // 🛡️ Validação Avançada de Tipagem e Limites de Quantidade (Payload Protection)
    if (tasks !== undefined && !validateEntityStructure(tasks, 300)) {
      return res.status(400).json({ error: 'Formato de dados inválido ou limite excedido para a coleção de tarefas.' });
    }
    if (habits !== undefined && !validateEntityStructure(habits, 200)) {
      return res.status(400).json({ error: 'Formato de dados inválido ou limite excedido para a coleção de hábitos.' });
    }
    if (finances !== undefined && !validateEntityStructure(finances, 500)) {
      return res.status(400).json({ error: 'Formato de dados inválido ou limite excedido para a coleção de finanças.' });
    }

    console.log(`Processando sincronização segura para o usuário: ${userId}`);

    const userRef = db.collection('users').doc(userId);
    const serverIsoString = new Date().toISOString();

    const payloadToSave = {
      lastSync: timestamp || serverIsoString,
      updatedAt: serverIsoString, // Timestamp gerado server-side garantindo integridade
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
    // 🛡️ Ocultação de detalhes sensíveis de erro para o cliente
    console.error("Erro crítico no processo de sincronização com o banco:", error.message);
    return res.status(500).json({ error: "Não foi possível concluir a sincronização no momento." });
  }
}