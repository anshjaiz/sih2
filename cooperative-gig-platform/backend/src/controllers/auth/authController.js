const User = require('../../models/User');
const Worker = require('../../models/WorkerProfile');
const Customer = require('../../models/CustomerProfile');
const Notification = require('../../models/Notification');
const { generateToken, sanitizeUser, generateResetToken } = require('../../utils/authHelper');
const { restoreIfExpired } = require('../../services/worker/workerSuspensionService');
const { suspensionStatus } = require('../../utils/workerStatus');
const { asyncHandler, ApiError } = require('../../middleware/errorMiddleware');

const EMAIL_RE = /^\S+@\S+\.\S+$/;

const validateEmail = (email) => {
  const normalized = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(normalized)) throw new ApiError('Please provide a valid email', 400);
  return normalized;
};

// Attaches the role-specific profile shape used by login/me responses.
const attachProfile = async (user) => {
  if (user.role === 'worker') {
    const workerProfile = await Worker.findOne({ user: user._id });
    return {
      verificationStatus: workerProfile ? workerProfile.verificationStatus : 'PENDING',
      workerId: workerProfile ? workerProfile._id : null,
    };
  }
  if (user.role === 'customer') {
    const customerProfile = await Customer.findOne({ user: user._id });
    return { customerId: customerProfile ? customerProfile._id : null };
  }
  return null;
};

// Returns a suspension/termination status for a worker, or null if the worker is active.
const getWorkerSuspension = async (user) => {
  if (user.role !== 'worker') return null;
  const workerProfile = await restoreIfExpired(await Worker.findOne({ user: user._id }));
  return suspensionStatus(workerProfile);
};

// @desc    Register a new user
// @route   POST /api/auth/register
const register = asyncHandler(async (req, res) => {
  const { name, email, phone, password, role, languages } = req.body;

  // Validate role
  if (!['customer', 'worker'].includes(role)) {
    throw new ApiError('Role must be customer or worker', 400);
  }

  const normalizedEmail = validateEmail(email);

  // Check if user exists
  const existingUser = await User.findOne({
    $or: [{ email: normalizedEmail }, { phone: phone ? String(phone).trim() : phone }],
  });
  if (existingUser) {
    throw new ApiError('Email already registered.', 400);
  }

  // Create user (active immediately — no email verification required)
  const user = await User.create({
    name,
    email: normalizedEmail,
    phone,
    password,
    role,
    languages: languages || ['English', 'Hindi'],
  });

  // Create role-specific profile
  if (role === 'worker') {
    await Worker.create({
      user: user._id,
      languages: languages || ['English', 'Hindi'],
      joinedDate: new Date(),
    });
  } else if (role === 'customer') {
    await Customer.create({
      user: user._id,
      preferredLanguages: languages || ['English', 'Hindi'],
    });
  }

  // Notify admin of new registration
  const admins = await User.find({ role: 'admin' });
  if (admins.length) {
    await Notification.create(
      admins.map((admin) => ({
        user: admin._id,
        type: role === 'worker' ? 'NEW_WORKER' : 'CUSTOM_REQUEST',
        title: role === 'worker' ? 'New worker registered' : 'New customer registered',
        message: `${name} (${normalizedEmail}) registered as ${role}`,
        data: { userId: user._id, role },
      }))
    );
  }

  res.status(201).json({
    success: true,
    message: 'Registration successful. You can now login.',
    data: { user: sanitizeUser(user) },
  });
});

// @desc    Login user
// @route   POST /api/auth/login
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    throw new ApiError('Please provide email and password', 400);
  }

  // Normalize email to match registration normalization
  const normalizedEmail = String(email).trim().toLowerCase();

  // Get user with password field
  const user = await User.findOne({ email: normalizedEmail }).select('+password');
  if (!user || !(await user.matchPassword(password))) {
    throw new ApiError('Invalid email or password', 401);
  }

  const status = await getWorkerSuspension(user);
  if (status) throw new ApiError(status.message, 403);

  if (!user.isActive) {
    throw new ApiError('Your account has been deactivated. Contact support.', 403);
  }

  // Update last login
  user.lastLoginAt = new Date();
  await user.save({ validateBeforeSave: false });

  // If worker, attach verification status
  let profile = null;
  if (user.role === 'worker') {
    const workerProfile = await Worker.findOne({ user: user._id });
    profile = {
      verificationStatus: workerProfile ? workerProfile.verificationStatus : 'PENDING',
      workerId: workerProfile ? workerProfile._id : null,
    };
  } else if (user.role === 'customer') {
    const customerProfile = await Customer.findOne({ user: user._id });
    profile = {
      customerId: customerProfile ? customerProfile._id : null,
    };
  }

  const token = generateToken(user);

  res.json({
    success: true,
    message: 'Login successful',
    data: {
      user: sanitizeUser(user),
      profile,
      token,
    },
  });
});

// @desc    Get current logged-in user
// @route   GET /api/auth/me
const getMe = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);
  let profile = null;

  if (user.role === 'worker') {
    const workerProfile = await Worker.findOne({ user: user._id });
    profile = {
      verificationStatus: workerProfile ? workerProfile.verificationStatus : 'PENDING',
      workerId: workerProfile ? workerProfile._id : null,
      rating: workerProfile ? workerProfile.rating : 0,
      completedJobs: workerProfile ? workerProfile.completedJobs : 0,
    };
  } else if (user.role === 'customer') {
    const customerProfile = await Customer.findOne({ user: user._id });
    profile = {
      customerId: customerProfile ? customerProfile._id : null,
    };
  }

  res.json({
    success: true,
    data: {
      user: sanitizeUser(user),
      profile,
    },
  });
});

// @desc    Forgot password (mock, generates reset token)
// @route   POST /api/auth/forgot-password
const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const user = await User.findOne({ email });
  if (!user) {
    // Don't reveal whether user exists
    return res.json({
      success: true,
      message: 'If an account with that email exists, a reset link will be sent.',
    });
  }

  // Generate reset token (mock - in real use send email)
  const resetToken = generateResetToken();
  user.resetPasswordToken = resetToken;
  user.resetPasswordExpire = new Date(Date.now() + 10 * 60 * 1000); // 10 min
  await user.save({ validateBeforeSave: false });

  // In a real system, email this token. For demo, return it in response (dev only).
  res.json({
    success: true,
    message: 'Password reset token generated. Check your email.',
    data: process.env.NODE_ENV !== 'production' ? { resetToken } : undefined,
  });
});

// @desc    Reset password
// @route   POST /api/auth/reset-password
const resetPassword = asyncHandler(async (req, res) => {
  const { email, resetToken, newPassword } = req.body;

  if (!email || !resetToken || !newPassword) {
    throw new ApiError('Please provide email, reset token and new password', 400);
  }

  const user = await User.findOne({ email }).select('+password');

  if (!user || user.resetPasswordToken !== resetToken) {
    throw new ApiError('Invalid reset token', 400);
  }

  if (user.resetPasswordExpire < new Date()) {
    throw new ApiError('Reset token expired', 400);
  }

  user.password = newPassword;
  user.resetPasswordToken = undefined;
  user.resetPasswordExpire = undefined;
  await user.save();

  res.json({
    success: true,
    message: 'Password reset successful. Please login with your new password.',
  });
});

// @desc    Logout user (stateless JWT, just client-side token removal)
// @route   POST /api/auth/logout
const logout = asyncHandler(async (req, res) => {
  // JWT is stateless; the client just removes the token
  res.json({
    success: true,
    message: 'Logged out successfully',
  });
});

module.exports = {
  register,
  login,
  getMe,
  forgotPassword,
  resetPassword,
  logout,
};