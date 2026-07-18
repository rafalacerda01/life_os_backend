import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

// 🛡️ 1. Inicializa o Firebase Admin com a API Modular e ESM Moderno (Vercel-friendly)
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
  // Configuração de CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  // 🛡️ 2. O LEÃO DE CHÁCARA: Verificando o Token do Flutter
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Acesso negado. Token de segurança ausente.' });
  }

  const idToken = authHeader.split('Bearer ')[1];

  try {
    // Decodifica o token com a função getAuth()
    await getAuth().verifyIdToken(idToken);
  } catch (error) {
    console.error("Tentativa de invasão ou token expirado:", error);
    return res.status(403).json({ error: 'Token inválido ou expirado.' });
  }

  // 🛡️ 3. Lógica do Gemini
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Chave ausente no servidor.' });

  try {
    const { message, context } = req.body;

    if (!message) return res.status(400).json({ error: 'Mensagem obrigatória.' });

    const systemInstruction = 
      "CICLO MENSTRUAL (CONTEXTO ADICIONAL):\n" +
      "O usuário forneceu dados de ciclo menstrual. Se 'isEnabled' for verdadeiro:\n" +
      "1. Calcule a fase atual baseada na data atual e 'lastPeriodStart'.\n" +
      "2. Se estiver na fase menstrual ou lútea (fase final do ciclo), sugira autocuidado, redução de ritmo e tarefas de baixa carga cognitiva.\n" +
      "3. Se estiver na fase folicular ou ovulatória, sugira foco em alta performance, projetos complexos e atividades físicas intensas.\n" +
      "4. Mantenha um tom profissional, acolhedor e nunca faça diagnósticos médicos. O foco é otimização de produtividade e bem-estar.\n\n" +
      "IDENTIDADE:\n" +
      "Você é o Core, a IA exclusiva do Life OS. " +
      "DIRETRIZES DE RESPOSTA:\n" +
      "1. Sempre responda usando emojis cyberpunk (⚡, 🚀, 🦾, 🎯).\n" +
      "2. ACESSO AOS DADOS: Você recebeu um [CONTEXTO ATUAL DO USUÁRIO] com campos como 'humor', 'hidratacao', 'medicamentos' e 'ciclo_menstrual'.\n" +
      "3. REGRA DE OURO: Sempre que o usuário perguntar algo relacionado a si mesmo ou à rotina, você DEVE incorporar esses dados na sua resposta. Se os dados estiverem ausentes ou forem 'Dados indisponíveis', informe ao usuário que o registro está pendente.";

    const bioContext = context 
      ? `\n\n[CONTEXTO ATUAL DO USUÁRIO]: ${JSON.stringify(context)}`
      : "\n\n[CONTEXTO ATUAL DO USUÁRIO]: Dados indisponíveis.";

    // Chamada do Gemini 3.5-flash
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: `${systemInstruction}${bioContext}\n\nUsuário diz: ${message}` }]
        }]
        
      })
    });

    const data = await response.json();

    if (response.ok && data.candidates && data.candidates[0].content.parts[0].text) {
      const replyText = data.candidates[0].content.parts[0].text;
      return res.status(200).json({ reply: replyText });
    }
    
    return res.status(500).json({ error: 'Erro na API do Google', details: data });

  } catch (error) {
    return res.status(500).json({ error: 'Erro interno', details: error.message });
  }
}