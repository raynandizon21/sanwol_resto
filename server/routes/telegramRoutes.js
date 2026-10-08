const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/unifiedAuth');
const TelegramController = require('../controllers/telegramController');

router.get('/telegram/config', authenticate, TelegramController.getConfig);
router.post('/telegram/config', authenticate, TelegramController.saveConfig);
router.post('/telegram/test-message', authenticate, TelegramController.sendTestMessage);
router.post('/telegram/report-menu', authenticate, TelegramController.sendReportMenu);

module.exports = router;
