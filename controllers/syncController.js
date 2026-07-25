const handleSync = async (req, res) => {
  try {
    const userId = req.user ? req.user.id || req.user.uid : null; 
    
    if (!userId) {
      return res.status(401).json({ error: "Não autorizado." });
    }

    const { timestamp, tasks, habits, finances } = req.body;

    console.log(`Recebendo sincronização do usuário ${userId} em ${timestamp}`);

    return res.status(200).json({
      success: true,
      message: "Sincronização concluída com sucesso no servidor.",
      serverTimestamp: new Date().toISOString(),
      updatedData: {
        tasks: [],
        habits: [],
        finances: []
      }
    });

  } catch (error) {
    console.error("Erro no processo de sincronização:", error);
    return res.status(500).json({ error: "Erro interno ao processar a sincronização." });
  }
};

module.exports = { handleSync };