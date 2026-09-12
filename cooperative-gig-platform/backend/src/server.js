require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const connectDB = require('./config/db');
const { port, clientURL } = require('./config/env');
const { errorHandler, notFound } = require('./middleware/errorMiddleware');
const { setIO } = require('./config/socket');

// Routes
const authRoutes = require('./routes/authRoutes');
const serviceRoutes = require('./routes/serviceRoutes');
const customerRoutes = require('./routes/customerRoutes');
const workerRoutes = require('./routes/workerRoutes');
const adminRoutes = require('./routes/adminRoutes');
const reviewRoutes = require('./routes/reviewRoutes');
const complaintRoutes = require('./routes/complaintRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const aiRoutes = require('./routes/aiRoutes');

// Initialize express app
const app = express();
const server = http.createServer(app);

// Socket.IO
const { Server } = require('socket.io');
const io = new Server(server, {
  cors: {
    origin: clientURL,
    methods: ['GET', 'POST'],
  },
});
setIO(io);

// Socket.IO connection handler
io.on('connection', (socket) => {
  // Join room based on user type/id
  socket.on('identity', (userId) => {
    socket.join(`user_${userId}`);
  });

  socket.on('worker_join', (workerId) => {
    socket.join(`worker_${workerId}`);
  });

  socket.on('customer_join', (customerId) => {
    socket.join(`customer_${customerId}`);
  });

  socket.on('disconnect', () => {
    // handle disconnect
  });
});

// ---------- Middleware ----------
app.use(helmet()); // secure HTTP headers
app.use(cors({ origin: clientURL, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests, please try again later',
  },
});
app.use('/api', apiLimiter);

// Strict rate limit for auth
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 50,
  message: {
    success: false,
    message: 'Too many auth attempts, please try again later',
  },
});
app.use('/api/auth', authLimiter);

// Static uploads
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'Cooperative Gig Platform API is running',
    timestamp: new Date().toISOString(),
  });
});

// ---------- Routes ----------
app.use('/api/auth', authRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/workers', workerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/complaints', complaintRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/collaborations', require('./routes/collaboratorRoutes'));
app.use('/api/cancellations', require('./routes/cancellationRoutes'));
app.use('/api/chat', require('./routes/chatRoutes'));
app.use('/api/routes', require('./routes/routingRoutes'));
app.use('/api/ai', aiRoutes);
app.use('/api/payments', require('./routes/paymentRoutes'));
app.use('/api/wallet', require('./routes/walletRoutes'));
const { payoutMethodRouter, payoutsRouter } = require('./routes/payoutRoutes');
app.use('/api/payout-methods', payoutMethodRouter);
app.use('/api/payouts', payoutsRouter);

// Root route
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Cooperative Gig Services Platform API',
    version: '1.0.0',
  });
});

// 404 handler
app.use(notFound);

// Centralized error handler
app.use(errorHandler);

// ---------- Start Server ----------
const startServer = async () => {
  try {
    await connectDB();
    server.listen(port, async () => {
      console.log(`🚀 Server running on port ${port}`);
      console.log(`Health check: http://localhost:${port}/api/health`);
      // Worker reliability scheduler: job expiry + no-show detection cron.
      require('./services/reliability/scheduler').startScheduler();
      // Warm-up: run the AI pipeline quietly in the background so forecasts
      // and learned models exist from the very first request.
      require('./services/ai/aiPipelineService')
        .runPipeline({ quiet: true })
        .catch(() => {});
    });
  } catch (err) {
    console.error(`Failed to start server: ${err.message}`);
    process.exit(1);
  }
};

// Only start server if this file is run directly (not imported)
if (require.main === module) {
  startServer();
}

module.exports = { app, server, io, startServer };