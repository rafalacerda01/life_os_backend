import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

// 🛡️ Inicializa o Firebase Admin
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = getFirestore();

export default async function handler(req, res) {
  // 1. Configuração de CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  // 2. Verificação do Token do Firebase
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Acesso negado. Token não fornecido.' });
  }

  const token = authHeader.split('Bearer ')[1];
  let decodedToken;

  try {
    decodedToken = await getAuth().verifyIdToken(token);
  } catch (error) {
    console.error('Erro ao verificar o token Firebase:', error);
    return res.status(403).json({ error: 'Token inválido ou expirado.' });
  }

  try {
    const userId = decodedToken.uid;
    const { timestamp, tasks, habits, finances } = req.body;

    console.log(`Recebendo sincronização do usuário ${userId} em ${timestamp}`);

    // 3. Salvando os dados no Firestore (Coleção 'users' -> documento do usuário -> subcoleção ou campos de sync)
    const userRef = db.collection('users').doc(userId);
    
    await userRef.set({
      lastSync: timestamp || new Date().toISOString(),
      tasks: tasks || [],
      habits: habits || [],
      finances: finances || [],
      updatedAt: getFirestore.FieldValue.serverTimestamp()
    }, { merge: true }); // O { merge: true } garante que não apagamos dados antigos que não vieram nessa requisição

    return res.status(200).json({
      success: true,
      message: "Sincronização concluída e salva no Firestore com sucesso.",
      serverTimestamp: new Date().toISOString(),
      updatedData: {
        tasks: tasks || [],
        habits: habits || [],
        finances: finances || []
      }
    });

  } catch (error) {
    console.error("Erro no processo de sincronização com o banco:", error);
    return res.status(500).json({ error: "Erro interno ao processar a sincronização.", details: error.message });
  }
}