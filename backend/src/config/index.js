const path = require('path');
const fs = require('fs');

// Load .env.local from project root first if present (Neon CLI generates .env.local in root)
const rootEnvLocal = path.resolve(__dirname, '../../../.env.local');
const backendEnvLocal = path.resolve(__dirname, '../../.env.local');
if (fs.existsSync(rootEnvLocal)) {
  require('dotenv').config({ path: rootEnvLocal });
} else if (fs.existsSync(backendEnvLocal)) {
  require('dotenv').config({ path: backendEnvLocal });
}

const rootEnv = path.resolve(__dirname, '../../../.env');
const backendEnv = path.resolve(__dirname, '../../.env');
if (fs.existsSync(rootEnv)) {
  require('dotenv').config({ path: rootEnv });
} else if (fs.existsSync(backendEnv)) {
  require('dotenv').config({ path: backendEnv });
}
require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT, 10) || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  db: {
    connectionString: process.env.DATABASE_URL || null,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'root',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME || 'petcare',
    ssl: (process.env.DATABASE_URL || process.env.DB_SSL === 'true')
      ? { rejectUnauthorized: false }
      : false,
  },
  groq: {
    apiKey: process.env.GROQ_API_KEY || '',
    baseURL: 'https://api.groq.com/openai/v1',
    whisperModel: process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3',
    llmModel: process.env.GROQ_LLM_MODEL || 'openai/gpt-oss-120b',
    failoverModel: process.env.GROQ_FAILOVER_MODEL || 'qwen/qwen3.8-27b',
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    realtimeModel: process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview',
  },
  audioRetentionDays: parseInt(process.env.AUDIO_RETENTION_DAYS, 10) || 30,
  auth: {
    jwtSecret: process.env.JWT_SECRET || 'petcare_dev_jwt_secret_super_secure_key_2026',
    cookieSecret: process.env.COOKIE_SECRET || 'petcare_dev_cookie_secret_super_secure_key_2026',
    accessTokenExpiry: '15m',
    refreshTokenDays: 14,
    stagingHardcodedOtp: '123456',
  },
  webPush: {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@petcare.ai',
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'PetCare AI <no-reply@petcare.ai>',
  },
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
};

module.exports = config;
