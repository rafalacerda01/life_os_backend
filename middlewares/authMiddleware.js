const admin = require('firebase-admin');

// Inicialize o firebase-admin caso ainda não tenha sido inicializado no projeto
if (!admin.apps.length) {
  admin.initializeApp();
}

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Acesso negado. Token não fornecido.' });
  }

  const token = authHeader.split('Bearer ')[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken; // Injeta os dados do usuário (incluindo o ID) na requisição
    next();
  } catch (error) {
    console.error('Erro ao verificar o token Firebase:', error);
    return res.status(403).json({ error: 'Token inválido ou expirado.' });
  }
};

module.exports = verifyToken;