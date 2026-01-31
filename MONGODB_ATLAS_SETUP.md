# MongoDB Atlas Network Access Setup Guide

## 🔐 How to Configure Network Access in MongoDB Atlas

### Quick Steps

1. **Log in to MongoDB Atlas**
   - Go to: https://cloud.mongodb.com
   - Sign in with your MongoDB Atlas account

2. **Navigate to Network Access**
   - Click on **"Network Access"** in the left sidebar
   - Or go to **"Security"** → **"Network Access"**

3. **Add IP Address**

   **Option A: Allow Access from Anywhere (Development/Testing)**
   - Click **"Add IP Address"** button
   - Select **"Allow Access from Anywhere"** 
   - Or manually enter: `0.0.0.0/0`
   - Click **"Confirm"**
   - ⚠️ **Warning**: This allows access from any IP address. Only use for development!

   **Option B: Whitelist Specific IP (Recommended for Production)**
   - Click **"Add IP Address"** button
   - Click **"Add Current IP Address"** (automatically detects your IP)
   - Or manually enter your IP: `49.249.114.78` (your current IP)
   - Add a comment: "Development Machine" or "Home Network"
   - Click **"Confirm"**

4. **Wait for Changes to Take Effect**
   - Changes usually take effect within 1-2 minutes
   - You'll see a green checkmark when the IP is whitelisted

### 📍 Finding Your Current IP Address

Run this command in your terminal:
```bash
curl -s ifconfig.me
```

Or visit: https://whatismyipaddress.com/

### 🔄 If Your IP Changes

If you're on a dynamic IP (most home networks), your IP may change. You have two options:

1. **Update the whitelist** with your new IP in MongoDB Atlas
2. **Use "Allow Access from Anywhere"** (only for development/testing)

### ✅ Verify Network Access

After configuring network access, test your connection:

```bash
# Restart your server
npm run start:monitored

# Check the logs - you should see:
# ✅ MongoDB connected to database: api_database
```

### 🛡️ Security Best Practices

- **Development**: Use "Allow Access from Anywhere" (`0.0.0.0/0`) for convenience
- **Production**: Always whitelist specific IP addresses or IP ranges
- **Staging**: Use specific IP addresses or your deployment server's IP

### 📝 Current Configuration

Based on your `.env` file:
- **Cluster**: `ashishrai.rwyojvh.mongodb.net`
- **Database**: `api_database`
- **Current IP**: `49.249.114.78` (may change if you're on a dynamic IP)

### 🔗 Useful Links

- MongoDB Atlas Dashboard: https://cloud.mongodb.com
- Network Access Settings: https://cloud.mongodb.com/v2#/security/network/whitelist
- MongoDB Connection String Format: `mongodb+srv://username:password@cluster/database`

### ❌ Common Issues

**Issue**: "bad auth : authentication failed"
- **Solution**: Check your username and password in `.env` file
- Make sure password is NOT URL-encoded (use raw password like `Ashish@123`)

**Issue**: "Connection timeout" or "Network access denied"
- **Solution**: Verify your IP is whitelisted in MongoDB Atlas Network Access
- Wait 1-2 minutes after adding IP address
- Check if your IP has changed (run `curl -s ifconfig.me`)

**Issue**: "IP address changed"
- **Solution**: Update the whitelist in MongoDB Atlas with your new IP
- Or use "Allow Access from Anywhere" for development

