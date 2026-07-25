const express = require('express');
const router = express.Router();
const { handleSync } = require('../controllers/syncController');
const verifyToken = require('../middlewares/authMiddleware');

router.post('/sync', verifyToken, handleSync);

module.exports = router;