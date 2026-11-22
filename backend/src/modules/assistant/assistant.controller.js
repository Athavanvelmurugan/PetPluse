const assistantService = require('./assistant.service');
const assistantSessions = require('./assistant.sessions');
const assistantContext = require('./assistant.context');
const whisperClient = require('../transcription/whisper.client');
const ttsService = require('./tts.service');
const db = require('../../db/connection');

class AssistantController {
  /**
   * Main conversational turn endpoint (supports JSON or multipart voice audio)
   * POST /api/v1/owner-portal/assistant/turn
   */
  async handleTurn(req, res, next) {
    try {
      const owner = req.owner;
      let { sessionId, channel, text, action } = req.body || {};
      let transcript = null;

      // Parse JSON action if sent as a stringified multipart form field
      if (typeof action === 'string') {
        try {
          action = JSON.parse(action);
        } catch (_) {}
      }

      // Voice Audio Ingestion: Process in-memory buffer, transcribe via Whisper, discard buffer
      if (req.file && req.file.buffer) {
        channel = 'voice';
        const clinicId = owner.clinic_id || owner.clinicId || 1;
        const context = await assistantContext.loadContext(owner.id, clinicId);
        const doctorHints = context.doctors.map((d) => d.name).join(', ');
        const promptHint = `Veterinary appointment booking. Doctor names: ${doctorHints}. Pet names: ${context.pets.map((p) => p.name).join(', ')}.`;

        console.log(`[AssistantController] Ingesting voice chunk: ${req.file.buffer.length} bytes, file=${req.file.originalname}, mime=${req.file.mimetype}`);

        try {
          const transcription = await whisperClient.transcribe({
            buffer: req.file.buffer,
            fileName: req.file.originalname || 'voice_chunk.webm',
            language: 'en',
            prompt: promptHint,
          });

          transcript = (transcription.fullText || '').trim();
          console.log(`[AssistantController] Whisper transcript result: "${transcript}"`);
          text = transcript;
        } catch (transcribeErr) {
          console.warn(`[AssistantController] Whisper transcription warning: ${transcribeErr.message}. Treating as inaudible utterance.`);
          transcript = '';
          text = null;
        } finally {
          // Zero-disk safety: explicitly release buffer memory immediately
          req.file.buffer = null;
        }
      }

      const result = await assistantService.processTurn({
        owner,
        sessionId: sessionId || null,
        channel: channel || 'chat',
        text: text || null,
        action: action || null,
        transcript,
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Cancel an active booking session
   * POST /api/v1/owner-portal/assistant/session/:id/cancel
   */
  async cancelSession(req, res, next) {
    try {
      const sessionId = req.params.id;
      const owner = req.owner;
      await assistantSessions.cancelSession(sessionId, owner.id);
      res.json({
        success: true,
        message: 'Assistant session cancelled.',
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Return VAPID public key for browser push subscription registration
   * GET /api/v1/owner-portal/assistant/push/vapid-key
   */
  getVapidPublicKey(req, res) {
    const publicKey = process.env.VAPID_PUBLIC_KEY || '';
    res.json({
      success: true,
      data: { publicKey },
    });
  }

  /**
   * Generate 6-digit one-time linking code for Telegram Bot integration
   * POST /api/v1/owner-portal/assistant/telegram/link-code
   */
  async getTelegramLinkCode(req, res, next) {
    try {
      const telegramService = require('./telegram.service');
      const ownerId = req.owner.id;
      const linkInfo = await telegramService.generateLinkCode(ownerId);
      res.json({
        success: true,
        data: linkInfo,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Register Web Push notification subscription
   * POST /api/v1/owner-portal/assistant/push/subscribe
   */
  async subscribePush(req, res, next) {
    try {
      const { endpoint, keys } = req.body || {};
      if (!endpoint || !keys || !keys.auth || !keys.p256dh) {
        return res.status(400).json({
          success: false,
          error: 'Invalid push subscription payload. Requires endpoint and keys (auth, p256dh).',
        });
      }

      const userId = req.owner.userId || (req.user && req.user.id) || null;
      const ownerId = req.owner.id || null;

      await db.query(
        `INSERT INTO push_subscriptions (user_id, owner_id, endpoint, keys)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (endpoint)
         DO UPDATE SET keys = EXCLUDED.keys, user_id = EXCLUDED.user_id, owner_id = EXCLUDED.owner_id;`,
        [userId, ownerId, endpoint, JSON.stringify(keys)]
      );

      res.json({
        success: true,
        message: 'Push subscription registered successfully.',
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Remove Web Push subscription
   * DELETE /api/v1/owner-portal/assistant/push/subscribe
   */
  async unsubscribePush(req, res, next) {
    try {
      const { endpoint } = req.body || {};
      if (!endpoint) {
        return res.status(400).json({
          success: false,
          error: 'Endpoint is required to unsubscribe.',
        });
      }

      const userId = req.owner.userId || (req.user && req.user.id) || null;
      const ownerId = req.owner.id || null;
      await db.query(
        `DELETE FROM push_subscriptions WHERE endpoint = $1 AND (user_id = $2 OR owner_id = $3);`,
        [endpoint, userId, ownerId]
      );

      res.json({
        success: true,
        message: 'Push subscription removed.',
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * High-quality Neural Text-to-Speech stream (NeerjaExpressive / Pallavi)
   * GET /api/v1/owner-portal/assistant/tts
   */
  async streamTts(req, res, next) {
    try {
      const text = req.query.text || req.body?.text;
      const voice = req.query.voice || req.body?.voice;
      await ttsService.streamAudio({ text, voice, res });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new AssistantController();

