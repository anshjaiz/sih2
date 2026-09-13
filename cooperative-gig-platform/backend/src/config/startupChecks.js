const env = require('./env');

// Validate critical env config at boot so a missing value fails loudly right
// away (in logs / deployment console) instead of surfacing later as a confusing
// error during a request.

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