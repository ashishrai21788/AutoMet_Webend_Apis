#!/usr/bin/env node
/**
 * Print this machine's local network IP for use on a physical device (same WiFi).
 * Run: node scripts/get-server-ip.js
 */
const os = require('os');

const interfaces = os.networkInterfaces();
const ips = [];

for (const name of Object.keys(interfaces)) {
  for (const iface of interfaces[name]) {
    if (iface.family === 'IPv4' && !iface.internal) {
      ips.push(iface.address);
    }
  }
}

const PORT = process.env.PORT || 3000;

if (ips.length === 0) {
  console.log('No local IPv4 address found. Are you connected to WiFi/Ethernet?');
  process.exit(1);
}

console.log('Use this URL on your physical device (same WiFi):\n');
ips.forEach((ip) => {
  console.log(`  http://${ip}:${PORT}`);
  console.log(`  API base: http://${ip}:${PORT}/api`);
  console.log(`  Health:   http://${ip}:${PORT}/health\n`);
});
