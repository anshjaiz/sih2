const env = require('./env');

// Validate critical env config at boot so a missing value fails loudly right
// away (in logs / deployment console) instead of surfacing later as a confusing
// 502 ("Unable to send the verification email") during registration.

const issues = [];

const error = (key, message) => issues.push({ level: 'error', key, message });
const warn = (key, message) => issues.push({ level: 'warn', key, message });

// MongoDB is the single source of truth — without it nothing works.
if (!env.mongoURI || env.mongoURI.includes('<db_user>')) {
  error('MONGO_URI', 'Missing or still a placeholder. Set a real MongoDB connection string.');
}

// The repo defaults are public, known values — flag them, but only block on a
// truly missing secret (missing breaks nothing now but is insecure in prod).
if (!env.jwtSecret) {
  error('JWT_SECRET', 'Missing. Set a long random secret before going live.');
} else if (env.jwtSecret === 'change_this_to_a_long_random_secret' || env.jwtSecret === 'dev_secret_change_me') {
  warn('JWT_SECRET', 'Still the repo default. Set a long random secret before going live.');
}

// Email verification OTPs. Fail loudly UNLESS the explicit dev fallback is on.
const emailConfigured = Boolean(env.emailUser && env.emailAppPassword);
if (!emailConfigured && !env.otpConsoleFallback) {
  error(
    'EMAIL_USER / EMAIL_APP_PASSWORD',
    'Email is not configured. Set EMAIL_USER and EMAIL_APP_PASSWORD (a Gmail App Password), ' +
      'or start with OTP_CONSOLE_FALLBACK=true for dev-only demos.'
  );
} else if (!emailConfigured && env.otpConsoleFallback) {
  warn(
    'EMAIL_USER / EMAIL_APP_PASSWORD',
    'Email is not configured and OTP_CONSOLE_FALLBACK=true: codes are only printed to the server console/logs. NEVER enable in production.'
  );
}

// Gmail app passwords are exactly 16 characters — sanity check before SMTP.
if (emailConfigured && env.emailAppPassword.length !== 16) {
  error(
    'EMAIL_APP_PASSWORD',
    `Should be a 16-character Gmail App Password, got ${env.emailAppPassword.length} characters.`
  );
}

// Payment keys are optional (mock gateway), but only warning if one is missing.
if (Boolean(env.razorpayKeyId) !== Boolean(env.razorpayKeySecret)) {
  warn(
    'RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET',
    'Only one Razorpay key is set. Both are required for real payments; otherwise the mock gateway is used.'
  );
}

const errors = issues.filter((i) => i.level === 'error');
const warnings = issues.filter((i) => i.level === 'warn');

const renderIssues = () => {
  const lines = [];
  for (const i of warnings) lines.push(`  [WARN]  ${i.key}: ${i.message}`);
  for (const i of errors) lines.push(`  [ERROR] ${i.key}: ${i.message}`);
  return lines.length ? lines.join('\n') : '  All required environment variables are set.';
};

const printIssues = () => {
  console.log('[config] Environment check:');
  console.log(renderIssues());
};

module.exports = { issues, errors, warnings, renderIssues, printIssues };