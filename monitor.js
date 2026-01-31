#!/usr/bin/env node

/**
 * Server Health Monitor
 * Monitors the server health and can restart it if needed
 */

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class ServerMonitor {
  constructor() {
    this.serverUrl = 'http://localhost:3000';
    this.healthEndpoint = '/health';
    this.checkInterval = 30000; // 30 seconds
    this.maxRetries = 3;
    this.retryCount = 0;
    this.isMonitoring = false;
    this.serverProcess = null;
    this.logFile = path.join(__dirname, 'monitor.log');
  }

  log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    
    console.log(logMessage.trim());
    
    // Write to log file
    fs.appendFileSync(this.logFile, logMessage);
  }

  async checkServerHealth() {
    return new Promise((resolve) => {
      const req = http.get(`${this.serverUrl}${this.healthEndpoint}`, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            const healthData = JSON.parse(data);
            resolve({
              isHealthy: res.statusCode === 200 && healthData.success,
              statusCode: res.statusCode,
              data: healthData
            });
          } catch (error) {
            resolve({
              isHealthy: false,
              statusCode: res.statusCode,
              error: error.message
            });
          }
        });
      });
      
      req.on('error', (error) => {
        resolve({
          isHealthy: false,
          error: error.message
        });
      });
      
      req.setTimeout(5000, () => {
        req.destroy();
        resolve({
          isHealthy: false,
          error: 'Request timeout'
        });
      });
    });
  }

  async startServer() {
    this.log('🚀 Starting server...');
    
    return new Promise((resolve, reject) => {
      this.serverProcess = spawn('node', ['index.js'], {
        stdio: ['inherit', 'pipe', 'pipe'],
        cwd: __dirname
      });
      
      let serverStarted = false;
      
      this.serverProcess.stdout.on('data', (data) => {
        const output = data.toString();
        console.log(output.trim());
        
        if (output.includes('HTTP Server running') && !serverStarted) {
          serverStarted = true;
          this.log('✅ Server started successfully');
          resolve();
        }
      });
      
      this.serverProcess.stderr.on('data', (data) => {
        const error = data.toString();
        console.error(error.trim());
        this.log(`❌ Server error: ${error.trim()}`);
      });
      
      this.serverProcess.on('close', (code) => {
        this.log(`🛑 Server process exited with code ${code}`);
        this.serverProcess = null;
        
        if (!serverStarted) {
          reject(new Error(`Server failed to start. Exit code: ${code}`));
        }
      });
      
      this.serverProcess.on('error', (error) => {
        this.log(`❌ Failed to start server: ${error.message}`);
        reject(error);
      });
      
      // Timeout after 30 seconds
      setTimeout(() => {
        if (!serverStarted) {
          this.log('⏰ Server start timeout');
          reject(new Error('Server start timeout'));
        }
      }, 30000);
    });
  }

  async stopServer() {
    if (this.serverProcess) {
      this.log('🛑 Stopping server...');
      
      return new Promise((resolve) => {
        this.serverProcess.kill('SIGTERM');
        
        this.serverProcess.on('close', () => {
          this.log('✅ Server stopped');
          this.serverProcess = null;
          resolve();
        });
        
        // Force kill after 10 seconds
        setTimeout(() => {
          if (this.serverProcess) {
            this.log('⚠️  Force killing server...');
            this.serverProcess.kill('SIGKILL');
            this.serverProcess = null;
            resolve();
          }
        }, 10000);
      });
    }
  }

  async restartServer() {
    this.log('🔄 Restarting server...');
    
    try {
      await this.stopServer();
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
      await this.startServer();
      this.retryCount = 0;
      this.log('✅ Server restarted successfully');
    } catch (error) {
      this.log(`❌ Failed to restart server: ${error.message}`);
      throw error;
    }
  }

  async monitor() {
    this.isMonitoring = true;
    this.log('🔍 Starting server monitoring...');
    
    while (this.isMonitoring) {
      try {
        const health = await this.checkServerHealth();
        
        if (health.isHealthy) {
          this.log(`✅ Server is healthy (${health.data?.health?.memoryUsage || 'unknown'})`);
          this.retryCount = 0;
        } else {
          this.log(`❌ Server health check failed: ${health.error || 'Unknown error'}`);
          this.retryCount++;
          
          if (this.retryCount >= this.maxRetries) {
            this.log(`🔄 Attempting server restart (${this.retryCount}/${this.maxRetries})`);
            
            try {
              await this.restartServer();
            } catch (error) {
              this.log(`❌ Restart failed: ${error.message}`);
              this.retryCount = this.maxRetries; // Don't retry again
            }
          }
        }
      } catch (error) {
        this.log(`❌ Health check error: ${error.message}`);
        this.retryCount++;
      }
      
      // Wait before next check
      await new Promise(resolve => setTimeout(resolve, this.checkInterval));
    }
  }

  stop() {
    this.log('🛑 Stopping monitor...');
    this.isMonitoring = false;
    
    if (this.serverProcess) {
      this.stopServer();
    }
  }
}

// Handle process signals
const monitor = new ServerMonitor();

process.on('SIGINT', () => {
  monitor.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  monitor.stop();
  process.exit(0);
});

// Start monitoring
if (require.main === module) {
  monitor.monitor().catch((error) => {
    console.error('❌ Monitor failed:', error);
    process.exit(1);
  });
}

module.exports = ServerMonitor;
