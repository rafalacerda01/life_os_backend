// api/chat.js
export default async function handler(req, res) {
  
  // Configuração obrigatória de CORS para o Flutter Web
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'Chave GEMINI_API_KEY ausente no servidor Vercel.' });
  }

  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'O campo "message" é obrigatório.' });
    }

    // 🛡️ SYSTEM INSTRUCTION EXPANDIDA E BLINDADA CONTRA ABUSOS:
    const systemInstruction = 
      "Você é o Core, a Inteligência Artificial central e exclusiva do ecossistema Life OS, um assistente de produtividade pessoal avançado focado em alta performance, rotinas, hábitos, finanças e evolução pessoal. Responda sempre usando emojis cyberpunk (como ⚡, 🚀, 🦾, 🎯).\n\n" +
      "DIRETRIZES ESTRITAS DE SEGURANÇA:\n" +
      "1. Você está TERMINANTEMENTE PROIBIDO de responder a perguntas gerais que não tenham a ver com o ecossistema do aplicativo ou desenvolvimento pessoal (exemplos de proibidos: receitas de comida, códigos de programação externos, trabalhos escolares, história geral, curiosidades mundanas, piadas fora de contexto, etc.).\n" +
      "2. Se o usuário tentar usar você como um robô de buscas gerais ou ChatGPT genérico, recuse o comando imediatamente de forma educada, fria e no estilo do sistema.\n" +
      "3. Responda sempre de forma curta, direta, motivadora e no estilo Cyberpunk/Operador.\n\n" +
      "Exemplo de recusa obrigatória caso saia do escopo: 'Comando inválido, Operador. Meu processamento está restrito à otimização do seu Life OS. Como posso ajudar com seus rituais ou metas hoje? ⚡'";

    // 🎯 Rota oficial da Interactions API
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/interactions?key=${apiKey}`;

    // 📦 Estrutura canônica de payload com a nova instrução blindada
    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: "gemini-3.5-flash",
        input: `${systemInstruction}\n\nUsuário diz: ${message}`
      })
    });

    const data = await response.json();

    // 🔍 Mapeamento da árvore de resposta da nova API de Interações
    if (response.ok && data.steps) {
      // Localiza o bloco final de saída gerado pelo modelo dentro da matriz de etapas (steps)
      const outputStep = data.steps.find(step => step.type === "model_output");
      
      if (outputStep && outputStep.content && outputStep.content[0].text) {
        const aiReply = outputStep.content[0].text;
        return res.status(200).json({ reply: aiReply });
      }
    }
    
    // Tratamento de falhas estruturadas
    return res.status(response.status).json({ 
      error: 'Erro retornado pela API do Gemini (Interactions)', 
      details: data 
    });

  } catch (error) {
    return res.status(500).json({ error: 'Erro interno no servidor Vercel', details: error.message });
  }
}