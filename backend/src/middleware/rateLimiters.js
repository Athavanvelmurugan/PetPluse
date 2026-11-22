const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const buildKey = (req) => {
  const ipKey = ipKeyGenerator(req.ip || '127.0.0.1');
  const target = (
    req.body?.email ||
    req.body?.hospitalEmail ||
    req.body?.identifier ||
    req.body?.phone ||
    ''
  )
    .toString()
    .trim()
    .toLowerCase();
  return target ? `${ipKey}:${target}` : ipKey;
};

function createAuthLimiter({ windowMs, max, message }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: buildKey,
    handler: (req, res) => {
      res.status(429).json({
        success: false,
        error: message,
        code: 'RATE_LIMITED',
      });
    },
  });
}

const loginMax = parseInt(process.env.AUTH_LOGIN_RATE_LIMIT || '15', 10);
const registerMax = parseInt(process.env.AUTH_REGISTER_RATE_LIMIT || '15', 10);
const verifyMax = parseInt(process.env.AUTH_VERIFY_RATE_LIMIT || '20', 10);
const resetMax = parseInt(process.env.AUTH_RESET_RATE_LIMIT || '10', 10);
const refreshMax = parseInt(process.env.AUTH_REFRESH_RATE_LIMIT || '60', 10);

const authLoginLimiter = createAuthLimiter({
  windowMs: 15 * 60 * 1000,
  max: loginMax,
  message: 'Too many login attempts. Please wait 15 minutes before trying again.',
});

const authRegisterLimiter = createAuthLimiter({
  windowMs: 15 * 60 * 1000,
  max: registerMax,
  message: 'Too many registration requests. Please try again later.',
});

const authVerificationLimiter = createAuthLimiter({
  windowMs: 15 * 60 * 1000,
  max: verifyMax,
  message: 'Too many verification attempts. Please request a new code later.',
});

const authResetLimiter = createAuthLimiter({
  windowMs: 15 * 60 * 1000,
  max: resetMax,
  message: 'Too many password reset requests. Please try again later.',
});

const authRefreshLimiter = createAuthLimiter({
  windowMs: 15 * 60 * 1000,
  max: refreshMax,
  message: 'Too many session refresh requests.',
});

const assistantLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.ASSISTANT_RATE_LIMIT || '20', 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.owner?.id ? `owner_${req.owner.id}` : (req.ip || '127.0.0.1');
  },
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: 'Too many requests. Please wait a moment before sending another message to the assistant.',
      code: 'RATE_LIMITED',
    });
  },
});

module.exports = {
  authLoginLimiter,
  authRegisterLimiter,
  authVerificationLimiter,
  authResetLimiter,
  authRefreshLimiter,
  assistantLimiter,
};
