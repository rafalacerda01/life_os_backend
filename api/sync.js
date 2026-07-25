import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

// 🛡️ Inicializa o Firebase Admin (Igual ao chat.js)
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

export default async function handler(req, res) {
  // 1. Configuração de CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  // 2. Middleware de Autenticação Incorporado
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Acesso negado. Token não fornecido.' });
  }

  const idToken = authHeader.split('Bearer ')[1];
  let decodedToken;

  try {
    decodedToken = await getAuth().verifyIdToken(idToken);
  } catch (error) {
    console.error('Erro ao verificar o token Firebase:', error);
    return res.status(403).json({ error: 'Token inválido ou expirado.' });
  }

  // 3. Lógica do Sync (O que ficava no seu syncController)
  try {
    const payload = req.body;
    const userId = decodedToken.uid; // ID do usuário autenticado no Firebase

    // AQUI VOCÊ INSERE A INTEGRAÇÃO COM O BANCO DE DADOS
    // Exemplo: await database.save(userId, payload);

    return res.status(200).json({ 
        message: 'Sincronização recebida com sucesso',
        userId: userId,
        receivedData: payload
    });

  } catch (error) {
    console.error('Erro na lógica de sincronização:', error);
    return res.status(500).json({ error: 'Erro interno do servidor', details: error.message });
  }
}