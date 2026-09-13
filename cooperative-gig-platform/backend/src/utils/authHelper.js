const jwt = require('jsonwebtoken');
const { jwtSecret, jwtExpiresIn } = require('../config/env');

// Generate JWT token
const generateToken = (user) => {
  return jwt.sign(
    {
      id: user._id,
      role: user.role,
      email: user.email,
    },
    jwtSecret,
    { expiresIn: jwtExpiresIn }
  );
};

// Sanitize user object (remove password, etc.)
const sanitizeUser = (user) => {
  if (!user) return null;
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    avatar: user.avatar || '',
    languages: user.languages || [],
    isActive: user.isActive,
    createdAt: user.createdAt,
  };
};

// Generate a random reset token (for password reset)
const generateResetToken = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Generate a random 6-digit reference/transaction number
const generateRef = (prefix) => {
  const random = Math.floor(100000 + Math.random() * 900000);
  return `${prefix}-${Date.now()}-${random}`;
};

module.exports = { generateToken, sanitizeUser, generateResetToken, generateRef };
