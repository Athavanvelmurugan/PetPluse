const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

// Cache directory for synthesized audio chunks
const CACHE_DIR = path.resolve(__dirname, '../../../cache/tts');
try {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
} catch (_) {}

class TtsService {
  /**
   * Synthesize and stream high-quality Microsoft Neural speech via edge-tts.
   * - en-IN-NeerjaExpressiveNeural: English & Tanglish (Soft, melodious, natural Indian English)
   * - ta-IN-PallaviNeural: Pure Tamil (Soft, native Tamil pronunciation)
   */
  async streamAudio({ text, voice, res }) {
    if (!text || typeof text !== 'string') {
      res.status(400).json({ success: false, error: 'Text is required' });
      return;
    }

    // Clean text and limit size
    const cleanText = text
      .replace(/[*_#`~[\]]/g, '')
      .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
      .trim()
      .slice(0, 500);

    if (!cleanText) {
      res.status(400).json({ success: false, error: 'Valid text is required' });
      return;
    }

    // Determine voice:
    // If text contains Tamil Unicode script (\u0B80-\u0BFF), use ta-IN-PallaviNeural
    // Otherwise (English / Tanglish), use en-IN-NeerjaExpressiveNeural
    const isTamilScript = /[\u0B80-\u0BFF]/.test(cleanText);
    let selectedVoice = voice;
    if (!selectedVoice) {
      selectedVoice = isTamilScript ? 'ta-IN-PallaviNeural' : 'en-IN-NeerjaExpressiveNeural';
    } else if (selectedVoice.includes('Pallavi') || isTamilScript) {
      selectedVoice = 'ta-IN-PallaviNeural';
    } else {
      selectedVoice = 'en-IN-NeerjaExpressiveNeural';
    }

    const hash = crypto.createHash('md5').update(`${selectedVoice}:${cleanText}`).digest('hex');
    const cacheFile = path.join(CACHE_DIR, `${hash}.mp3`);

    // 1. If cached file exists, stream immediately
    if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 100) {
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      fs.createReadStream(cacheFile).pipe(res);
      return;
    }

    // 2. Synthesize using python -m edge_tts
    const args = [
      '-m', 'edge_tts',
      '--text', cleanText,
      '--voice', selectedVoice,
      '--write-media', cacheFile,
    ];

    execFile('python', args, { timeout: 15000 }, (error) => {
      if (error) {
        console.error('[TtsService] edge-tts error:', error);
        if (!res.headersSent) {
          res.status(500).json({ success: false, error: 'TTS synthesis failed' });
        }
        return;
      }

      if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 100) {
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        fs.createReadStream(cacheFile).pipe(res);
      } else {
        if (!res.headersSent) {
          res.status(500).json({ success: false, error: 'Empty audio output' });
        }
      }
    });
  }
}

module.exports = new TtsService();

