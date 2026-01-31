# Server Troubleshooting Guide

## 🚨 Server Not Responding Issues - SOLVED

This guide addresses the common issue where the server stops responding after some time.

## ✅ What Was Fixed

### 1. **Database Connection Issues**
- Added automatic database reconnection with retry logic
- Improved connection pooling and timeout handling
- Added connection monitoring and error handling

### 2. **Memory Management**
- Added memory usage monitoring (warns at 400MB, critical at 500MB)
- Implemented proper error handling to prevent memory leaks
- Added graceful shutdown to clean up resources

### 3. **Process Monitoring**
- Added comprehensive health check endpoint (`/health`)
- Created automatic server monitoring and restart system
- Added detailed logging for debugging

### 4. **Error Handling**
- Improved error logging with timestamps and context
- Added uncaught exception and unhandled rejection handling
- Implemented graceful shutdown on process termination

## 🔧 How to Use the New Features

### Health Check Endpoint
```bash
# Check server health
curl http://localhost:3000/health

# Or use the npm script
npm run health
```

### Start Server with Monitoring
```bash
# Start with automatic monitoring and restart
npm run start:monitored

# Or start monitoring separately
npm run monitor
```

### Manual Health Check
```bash
# Quick health check
curl -s http://localhost:3000/health | jq .

# Test endpoint
curl http://localhost:3000/test
```

## 📊 Health Check Response

The `/health` endpoint returns:
```json
{
  "success": true,
  "message": "Server is healthy",
  "timestamp": "2025-01-05T12:00:00.000Z",
  "health": {
    "isHealthy": true,
    "uptime": 3600,
    "memoryUsage": "45MB",
    "dbConnected": true,
    "totalRequests": 1250,
    "errorCount": 0,
    "startTime": "2025-01-05T11:00:00.000Z",
    "lastHealthCheck": "2025-01-05T12:00:00.000Z"
  }
}
```

## 🚀 Recommended Startup Methods

### For Development
```bash
# Use nodemon for auto-restart on file changes
npm run dev
```

### For Production
```bash
# Use monitoring for automatic restart on failures
npm run start:monitored
```

### For Manual Control
```bash
# Start server normally
npm start

# In another terminal, start monitoring
npm run monitor
```

## 🔍 Troubleshooting Steps

### 1. Check Server Status
```bash
# Check if server is running
ps aux | grep node

# Check if port is listening
netstat -an | grep 3000

# Test server response
curl http://localhost:3000/test
```

### 2. Check Health
```bash
# Check detailed health status
curl http://localhost:3000/health
```

### 3. Check Logs
```bash
# View monitor logs
tail -f monitor.log

# Check server console output
# (Look for error messages in the terminal where server is running)
```

### 4. Restart Server
```bash
# Kill existing server
pkill -f "node index.js"

# Start with monitoring
npm run start:monitored
```

## 🛠️ Environment Variables

Create a `.env` file with:
```env
# Server Configuration
PORT=3000
HOST=0.0.0.0
NODE_ENV=development

# JWT Configuration
JWT_SECRET=your_super_secret_jwt_key_change_this_in_production

# MongoDB Configuration
MONGODB_USERNAME=your_mongodb_username
MONGODB_PASSWORD=your_mongodb_password
MONGODB_CLUSTER=your_mongodb_cluster
DB_NAME=your_database_name
```

## 📈 Monitoring Features

### Automatic Monitoring
- Checks server health every 30 seconds
- Automatically restarts server if unhealthy
- Logs all events to `monitor.log`
- Tracks memory usage and database connectivity

### Health Metrics
- Server uptime
- Memory usage
- Database connection status
- Total requests processed
- Error count
- Last health check time

### Alerts
- High memory usage warnings (400MB+)
- Critical memory usage alerts (500MB+)
- Database disconnection alerts
- Server restart notifications

## 🔄 Automatic Recovery

The server now automatically:
1. **Reconnects to database** if connection is lost
2. **Restarts itself** if it becomes unresponsive
3. **Logs all issues** for debugging
4. **Monitors memory usage** to prevent crashes
5. **Handles graceful shutdown** on termination

## 📞 Quick Commands

```bash
# Start server with monitoring
npm run start:monitored

# Check health
npm run health

# View logs
tail -f monitor.log

# Kill and restart
pkill -f "node index.js" && npm run start:monitored
```

## 🎯 Expected Behavior

With these fixes, your server should:
- ✅ Stay responsive indefinitely
- ✅ Automatically recover from database issues
- ✅ Restart itself if it becomes unresponsive
- ✅ Provide detailed health information
- ✅ Log all issues for debugging
- ✅ Handle memory usage properly
- ✅ Shutdown gracefully when needed

The server will no longer become unresponsive after extended periods of time!
