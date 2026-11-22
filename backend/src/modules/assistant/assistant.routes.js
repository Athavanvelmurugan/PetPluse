const express = require('express');
const multer = require('multer');
const router = express.Router();
const controller = require('./assistant.controller');
const { ownerAuthenticate } = require('../../middleware/ownerAuthenticate');
const { assistantLimiter } = require('../../middleware/rateLimiters');

// Memory storage: zero disk writes, in-memory transcription and immediate buffer disposal
const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB max
  },
});

// All assistant routes require Pet Guardian authentication and are rate-limited
router.use(ownerAuthenticate);
router.use(assistantLimiter);

// 1. Conversational turn (accepts JSON or multipart audio)
router.post('/turn', memoryUpload.single('audio'), (req, res, next) => controller.handleTurn(req, res, next));

// 2. Cancel active assistant session
router.post('/session/:id/cancel', (req, res, next) => controller.cancelSession(req, res, next));

// 3. Web Push subscription management
router.get('/push/vapid-key', (req, res) => controller.getVapidPublicKey(req, res));
router.post('/push/subscribe', (req, res, next) => controller.subscribePush(req, res, next));
router.delete('/push/subscribe', (req, res, next) => controller.unsubscribePush(req, res, next));

// 4. Telegram Bot Account Linking
router.post('/telegram/link-code', (req, res, next) => controller.getTelegramLinkCode(req, res, next));

// 5. High-fidelity Neural Text-to-Speech audio streaming (Neerja / Pallavi)
router.get('/tts', (req, res, next) => controller.streamTts(req, res, next));

module.exports = router;

