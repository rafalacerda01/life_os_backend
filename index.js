const express = require('express');
const cors = require('cors');
const syncRoutes = require('./routes/syncRoutes');

const app = express();

// Middlewares globais
app.use(cors());
app.use(express.json());

// Rota de Teste / Verificação
app.get('/', (req, res) => {
  res.json({ status: 'Life OS Backend online!' });
});

// Registrar as rotas de sincronização
app.use('/api', syncRoutes);

// Porta para ambiente local (a Vercel gerencia isso automaticamente em produção)
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

module.exports = app;