const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

// Load .env from project root (where this file lives) so it works regardless of cwd
dotenv.config({ path: path.join(__dirname, '.env') });

const connectDB = require('./config/db');
const { validateCloudinaryConfig, testCloudinaryConnection } = require('./config/cloudinary');
const { initializeFirestore } = require('./config/firestore');
const dynamicRoutes = require('./routes/dynamicRoutes');
const otpRoutes = require('./routes/otpRoutes');

// Server health monitoring
let serverHealth = {
  isHealthy: true,
  startTime: new Date(),
  lastHealthCheck: new Date(),
  memoryUsage: process.memoryUsage(),
  uptime: process.uptime(),
  dbConnected: false,
  totalRequests: 0,
  errorCount: 0
};

// Connect to MongoDB with retry logic
let connectionRetryCount = 0;
const maxRetries = 5;

const connectWithRetry = async () => {
  try {
    await connectDB();
    serverHealth.dbConnected = true;
    connectionRetryCount = 0;
    console.log('✅ Database connection established');
    
    // Validate Cloudinary configuration
    if (validateCloudinaryConfig()) {
      await testCloudinaryConnection();
    }
    
    // Initialize Firestore (non-blocking)
    try {
      initializeFirestore();
    } catch (firestoreError) {
      console.warn('⚠️  Firestore initialization failed (non-critical):', firestoreError.message);
    }
  } catch (error) {
    serverHealth.dbConnected = false;
    connectionRetryCount++;
    console.error(`❌ Database connection failed (attempt ${connectionRetryCount}/${maxRetries}):`, error.message);
    
    if (connectionRetryCount < maxRetries) {
      // Exponential backoff: 5s, 10s, 20s, 40s, 80s
      const retryDelay = Math.min(5000 * Math.pow(2, connectionRetryCount - 1), 80000);
      console.log(`🔄 Retrying database connection in ${retryDelay/1000} seconds...`);
      
      setTimeout(() => {
        connectWithRetry();
      }, retryDelay);
    } else {
      console.error('❌ Max database connection retries reached. Server will continue without database.');
      console.log('💡 Please check your MongoDB credentials and network connection.');
    }
  }
};

connectWithRetry();

// Function to get local network IP address
function getLocalIP() {
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
  } catch (err) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('[getLocalIP]', err.message || err);
    }
  }
  return '0.0.0.0';
}

const app = express();

// Request logging and health monitoring middleware
app.use((req, res, next) => {
  serverHealth.totalRequests++;
  serverHealth.lastHealthCheck = new Date();
  
  // Log requests in development
  if (process.env.NODE_ENV === 'development') {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path} - ${req.ip}`);
  }
  
  next();
});

// Database connection check middleware for API routes
app.use('/api', (req, res, next) => {
  // Skip database check for API health (so clients can diagnose when DB is down)
  if (req.path === '/api/health' || req.path === '/health') {
    return next();
  }
  
  // Check if database is connected
  if (!serverHealth.dbConnected || mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      success: false,
      message: 'Database connection not available. All /api/* routes need MongoDB. Check server logs for connection errors and ensure .env has correct MONGODB_* and DB is reachable.',
      error: 'DATABASE_CONNECTION_ERROR',
      timestamp: new Date().toISOString(),
      retryAfter: 30,
      hint: 'Check GET /health or GET /api/health for dbConnected status. Fix MongoDB credentials in .env and restart the server.'
    });
  }
  
  next();
});

// CORS middleware for mobile compatibility and Postman
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Cache-Control, Pragma');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Content-Type', 'application/json; charset=utf-8');
  res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.header('Pragma', 'no-cache');
  res.header('Expires', '0');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Body parsing middleware with better error handling
app.use(express.json({ 
  limit: '10mb',
  strict: true,
  verify: (req, res, buf, encoding) => {
    try {
      JSON.parse(buf.toString('utf8'));
    } catch (e) {
      console.error('JSON parse error:', e.message);
      console.error('Invalid JSON at position:', e.message.match(/position (\d+)/)?.[1] || 'unknown');
      throw new Error(`Invalid JSON: ${e.message}`);
    }
  }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Custom JSON error handler
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('JSON Syntax Error:', err.message);
    return res.status(400).json({
      success: false,
      error: 'Invalid JSON in request body',
      message: err.message,
      errorType: 'SyntaxError',
      timestamp: new Date().toISOString()
    });
  }
  next(err);
});

// Health check endpoint
app.get('/health', (req, res) => {
  const currentMemory = process.memoryUsage();
  const memoryUsageMB = Math.round(currentMemory.heapUsed / 1024 / 1024);
  
  serverHealth.memoryUsage = currentMemory;
  serverHealth.uptime = process.uptime();
  serverHealth.isHealthy = serverHealth.dbConnected && memoryUsageMB < 500; // 500MB limit
  
  res.status(serverHealth.isHealthy ? 200 : 503).json({
    success: serverHealth.isHealthy,
    message: serverHealth.isHealthy ? 'Server is healthy' : 'Server health issues detected',
    timestamp: new Date().toISOString(),
    health: {
      isHealthy: serverHealth.isHealthy,
      uptime: Math.round(serverHealth.uptime),
      memoryUsage: `${memoryUsageMB}MB`,
      dbConnected: serverHealth.dbConnected,
      totalRequests: serverHealth.totalRequests,
      errorCount: serverHealth.errorCount,
      startTime: serverHealth.startTime,
      lastHealthCheck: serverHealth.lastHealthCheck
    }
  });
});

// Test endpoint for mobile debugging
app.get('/test', (req, res) => {
  res.json({
    success: true,
    message: 'Server is working',
    timestamp: new Date().toISOString(),
    headers: req.headers
  });
});

// API health (no DB required - use to check if APIs will work)
app.get('/api/health', (req, res) => {
  const dbConnected = serverHealth.dbConnected && mongoose.connection.readyState === 1;
  res.status(dbConnected ? 200 : 503).json({
    success: dbConnected,
    message: dbConnected ? 'API and database ready' : 'Server is up but database is not connected. All other /api/* routes will return 503 until MongoDB connects.',
    dbConnected,
    mongooseState: mongoose.connection.readyState,
    timestamp: new Date().toISOString()
  });
});

// Routes
app.use('/api/users', require('./routes/userRoutes')); // User: register, login, verify-otp, profile, resend-otp, logout, notifications (collections: users, users_otp, users_notification)
app.use('/api/user-app-analytics', require('./routes/userAppAnalyticsRoutes')); // User app analytics (collection: user_app_analytics)
app.use('/api/driver-app-analytics', require('./routes/driverAppAnalyticsRoutes')); // Driver app analytics (collection: driver_app_analytics)
app.use('/api', dynamicRoutes); // Dynamic routes for any collection (includes drivers)
app.use('/api/otp', otpRoutes); // OTP routes for driver verification (collection: drivers_otp)
app.use('/api/images', require('./routes/imageRoutes')); // Image upload/delete routes
app.use('/api/v1/rides', require('./routes/rideRoutes')); // Ride request, accept, reject, status, timeline, check-timeouts
app.use('/api/v1/ride-actions', require('./routes/rideActionRoutes')); // Ride actions: request, accept, reject, cancel (atomic, idempotent)
app.use('/api/v1/trips', require('./routes/tripRoutes')); // Trip create-request (30s wait), driver-response, check-timeouts

// JSON Syntax Error Handler - must come before general error handler
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('JSON Syntax Error:', err.message);
    const positionMatch = err.message.match(/position (\d+)/);
    const position = positionMatch ? positionMatch[1] : 'unknown';
    console.error('Error at position:', position);
    
    return res.status(400).json({
      success: false,
      error: 'Invalid JSON in request body',
      message: err.message,
      errorType: 'SyntaxError',
      hint: 'Check for unescaped control characters (newlines, tabs, etc.) or special characters in your JSON strings. Make sure all string values are properly escaped.',
      position: position,
      timestamp: new Date().toISOString()
    });
  }
  next(err);
});

// Error handling middleware
app.use((err, req, res, next) => {
  serverHealth.errorCount++;
  console.error(`${new Date().toISOString()} - Error:`, err);
  console.error('Error Stack:', err.stack);
  
  // Log error details (safely handle body serialization)
  const errorDetails = {
    message: err.message,
    name: err.name,
    stack: err.stack,
    url: req.url,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  };
  
  // Try to log request body, but handle JSON errors
  try {
    if (req.body) {
      errorDetails.bodyKeys = Object.keys(req.body);
      // Only log body if it's not too large and can be serialized
      try {
        const bodyStr = JSON.stringify(req.body);
        if (bodyStr.length < 10000) {
          errorDetails.body = req.body;
        } else {
          errorDetails.bodySize = bodyStr.length;
        }
      } catch (bodyError) {
        errorDetails.bodyError = 'Could not serialize request body: ' + bodyError.message;
      }
    }
  } catch (e) {
    errorDetails.bodyError = 'Error accessing request body: ' + e.message;
  }
  
  console.error('Error Details:', errorDetails);
  
  // Handle Mongoose validation errors
  if (err.name === 'ValidationError') {
    const validationErrors = {};
    if (err.errors) {
      Object.keys(err.errors).forEach(key => {
        validationErrors[key] = err.errors[key].message;
      });
    }
    
    return res.status(400).json({
      success: false,
      error: 'Validation error',
      message: err.message,
      data: {
        validationErrors: validationErrors
      },
      timestamp: new Date().toISOString()
    });
  }
  
  res.status(500).json({ 
    success: false,
    error: 'Something went wrong!',
    message: err.message || 'Internal server error',
    errorType: err.name || 'UnknownError',
    timestamp: new Date().toISOString(),
    requestId: req.headers['x-request-id'] || 'unknown',
    ...(process.env.NODE_ENV === 'development' && {
      stack: err.stack
    })
  });
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // Listen on all interfaces for mobile access
const LOCAL_IP = getLocalIP(); // Get actual network IP

// Create HTTP server
const httpServer = http.createServer(app);

// Socket.IO for real-time ride events (optional; requires socket.io dependency)
try {
  const { initSocket } = require('./config/socket');
  initSocket(httpServer);
} catch (e) {
  console.warn('⚠️  Socket.IO not initialized:', e.message);
}

// Graceful shutdown handling
let isShuttingDown = false;

const gracefulShutdown = (signal) => {
  if (isShuttingDown) {
    console.log('⚠️  Shutdown already in progress...');
    return;
  }
  
  isShuttingDown = true;
  console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);
  
  // Check if server is still running
  if (httpServer && httpServer.listening) {
    httpServer.close(async (err) => {
      if (err) {
        console.error('❌ Error during server shutdown:', err);
      } else {
        console.log('✅ HTTP server closed');
      }
      
      // Close database connection
      if (mongoose.connection.readyState === 1) {
        try {
          await mongoose.connection.close(false);
          console.log('✅ Database connection closed');
        } catch (dbErr) {
          console.error('❌ Error closing database:', dbErr);
        }
      } else {
        console.log('✅ Database connection already closed');
      }
      console.log('👋 Server shutdown complete');
      process.exit(0);
    });
  } else {
    console.log('⚠️  Server was not running');
    // Close database connection
    if (mongoose.connection.readyState === 1) {
      mongoose.connection.close(false).then(() => {
        console.log('✅ Database connection closed');
        console.log('👋 Server shutdown complete');
        process.exit(0);
      }).catch((dbErr) => {
        console.error('❌ Error closing database:', dbErr);
        console.log('👋 Server shutdown complete');
        process.exit(0);
      });
    } else {
      console.log('✅ Database connection already closed');
      console.log('👋 Server shutdown complete');
      process.exit(0);
    }
  }
  
  // Force close after 10 seconds
  setTimeout(() => {
    console.error('❌ Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  console.error('Stack trace:', err.stack);
  serverHealth.errorCount++;
  
  // Log the error but don't crash the server for non-critical errors
  if (err.code === 'ERR_SERVER_NOT_RUNNING' || err.message.includes('Server is not running')) {
    console.log('⚠️  Server shutdown error - this is expected during shutdown');
    return;
  }
  
  // For other critical errors, shutdown gracefully
  gracefulShutdown('uncaughtException');
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  serverHealth.errorCount++;
  
  // Log but don't crash for mongoose connection errors during shutdown
  if (reason && reason.message && reason.message.includes('Connection.prototype.close() no longer accepts a callback')) {
    console.log('⚠️  Mongoose connection close error - this is expected during shutdown');
    return;
  }
});

// Database connection monitoring
mongoose.connection.on('connected', () => {
  console.log('✅ MongoDB connected');
  serverHealth.dbConnected = true;
});

mongoose.connection.on('disconnected', () => {
  console.log('❌ MongoDB disconnected');
  serverHealth.dbConnected = false;
});

mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB connection error:', err);
  serverHealth.dbConnected = false;
  serverHealth.errorCount++;
});

// Memory monitoring
setInterval(() => {
  const memUsage = process.memoryUsage();
  const memUsageMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  
  if (memUsageMB > 400) { // Warning at 400MB
    console.warn(`⚠️  High memory usage: ${memUsageMB}MB`);
  }
  
  if (memUsageMB > 500) { // Critical at 500MB
    console.error(`❌ Critical memory usage: ${memUsageMB}MB`);
    serverHealth.isHealthy = false;
  }
  
  serverHealth.memoryUsage = memUsage;
}, 60000); // Check every minute

// Start HTTP server
httpServer.listen(PORT, HOST, () => {
  console.log(`🚀 HTTP Server running on http://${HOST}:${PORT}`);
  console.log(`📍 Local HTTP access: http://localhost:${PORT}`);
  console.log(`🌐 Network HTTP access: http://${LOCAL_IP}:${PORT}`);
  if (LOCAL_IP !== '0.0.0.0') {
    console.log(`📱 Use on physical device (same WiFi): http://${LOCAL_IP}:${PORT}`);
    console.log(`   API Base URL: http://${LOCAL_IP}:${PORT}/api`);
    console.log(`   Health: http://${LOCAL_IP}:${PORT}/health`);
  } else {
    console.log(`📱 For physical device: run \`node scripts/get-server-ip.js\` or use your machine's LAN IP with port ${PORT}`);
  }
  console.log(`🔧 Test Endpoint: http://${LOCAL_IP}:${PORT}/test`);
  console.log(`⏰ Server started at: ${new Date().toISOString()}`);
  console.log(`🔄 Database connection status: ${serverHealth.dbConnected ? 'Connected' : 'Connecting...'}`);
}); 