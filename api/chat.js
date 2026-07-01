// api/chat.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Chave ausente.' });

  try {
    const { message, context } = req.body; 

    if (!message) return res.status(400).json({ error: 'Mensagem obrigatória.' });

    const systemInstruction = 
      "Você é o Core, a IA exclusiva do Life OS. " +
      "DIRETRIZES: Responda usando emojis cyberpunk (⚡, 🚀, 🦾, 🎯). " +
      "Proibido responder assuntos fora de produtividade, saúde e hábitos. " +
      "SEMPRE que o usuário perguntar sobre o estado de saúde (hidratação, humor, medicamentos), você DEVE citar explicitamente os valores numéricos ou descritivos contidos no [CONTEXTO ATUAL]. Se não houver dados, informe que os registros estão pendentes.";
    
    // 🧠 Construção do contexto biológico (sem revelar dados brutos excessivos)
    const bioContext = context 
      ? `\n\n[CONTEXTO ATUAL DO USUÁRIO]: ${JSON.stringify(context)}. Use estes dados para sua análise.`
      : "";

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/interactions?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: "gemini-3.5-flash",
        input: `${systemInstruction}${bioContext}\n\nUsuário diz: ${message}`
      })
    });

    const data = await response.json();
    if (response.ok && data.steps) {
      const outputStep = data.steps.find(step => step.type === "model_output");
      if (outputStep?.content?.[0]?.text) {
        return res.status(200).json({ reply: outputStep.content[0].text });
      }
    }
    return res.status(500).json({ error: 'Erro na API', details: data });
  } catch (error) {
    return res.status(500).json({ error: 'Erro interno', details: error.message });
  }
}