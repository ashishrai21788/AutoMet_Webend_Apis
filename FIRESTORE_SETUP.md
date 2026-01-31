# Firestore Setup Guide

This guide explains how to configure Firestore for driver logout functionality.

## Overview

Firestore is used to remove drivers from the Firestore database when they log out. The integration supports multiple configuration methods.

## Configuration Options

You have **4 options** to configure Firestore. Choose the one that best fits your setup:

### Option 1: Service Account JSON (Recommended for Production)

Store your Firebase service account JSON as an environment variable.

**Steps:**
1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project
3. Go to **Project Settings** → **Service Accounts**
4. Click **Generate New Private Key**
5. Download the JSON file
6. Copy the entire JSON content
7. Add to your `.env` file:

```bash
# Firestore Configuration (Option 1: Service Account JSON)
FIREBASE_SERVICE_ACCOUNT_KEY='{"type":"service_account","project_id":"your-project-id",...}'
```

**Note:** The entire JSON must be on a single line or properly escaped.

### Option 2: Service Account File Path (Recommended for Local Development)

Store the service account JSON file locally and reference it.

**Steps:**
1. Download your Firebase service account JSON (same as Option 1)
2. Save it in your project (e.g., `config/firebase-service-account.json`)
3. Add to your `.env` file:

```bash
# Firestore Configuration (Option 2: Service Account File Path)
FIREBASE_SERVICE_ACCOUNT_PATH=./config/firebase-service-account.json
```

**Security Note:** Add `firebase-service-account.json` to your `.gitignore` file!

### Option 3: Google Application Credentials (For Google Cloud Environments)

Use Google Cloud's default credentials.

**Steps:**
1. Set the path to your credentials file:

```bash
# Firestore Configuration (Option 3: Google Application Credentials)
GOOGLE_APPLICATION_CREDENTIALS=/path/to/your/credentials.json
```

### Option 4: Project ID Only (For Development/Testing)

Use only the project ID (limited functionality, may not work for all operations).

```bash
# Firestore Configuration (Option 4: Project ID Only)
FIREBASE_PROJECT_ID=your-firebase-project-id
```

## Additional Configuration

### Custom Collection Name (Optional)

By default, drivers are stored in the `drivers` collection. To use a different collection:

```bash
FIRESTORE_DRIVERS_COLLECTION=your_collection_name
```

## Complete .env Example

```bash
# Server Configuration
PORT=3000
HOST=0.0.0.0
NODE_ENV=development

# MongoDB Configuration
MONGODB_USERNAME=your_mongodb_username
MONGODB_PASSWORD=your_mongodb_password
MONGODB_CLUSTER=your_mongodb_cluster
DB_NAME=your_database_name

# JWT Configuration
JWT_SECRET=your_super_secret_jwt_key

# Firestore Configuration (Choose ONE option)
# Option 1: Service Account JSON
FIREBASE_SERVICE_ACCOUNT_KEY='{"type":"service_account",...}'

# Option 2: Service Account File Path (uncomment to use)
# FIREBASE_SERVICE_ACCOUNT_PATH=./config/firebase-service-account.json

# Option 3: Google Application Credentials (uncomment to use)
# GOOGLE_APPLICATION_CREDENTIALS=/path/to/credentials.json

# Option 4: Project ID Only (uncomment to use)
# FIREBASE_PROJECT_ID=your-firebase-project-id

# Optional: Custom Firestore Collection Name
# FIRESTORE_DRIVERS_COLLECTION=drivers
```

## Setup Instructions

### Quick Setup (Option 2 - Recommended for Development)

1. **Download Firebase Service Account:**
   - Go to [Firebase Console](https://console.firebase.google.com/)
   - Select your project
   - Go to **Project Settings** → **Service Accounts**
   - Click **Generate New Private Key**
   - Save the file as `config/firebase-service-account.json`

2. **Add to .gitignore:**
   ```bash
   echo "config/firebase-service-account.json" >> .gitignore
   ```

3. **Update .env file:**
   ```bash
   FIREBASE_SERVICE_ACCOUNT_PATH=./config/firebase-service-account.json
   ```

4. **Restart your server:**
   ```bash
   npm start
   ```

## Verification

After configuration, you should see:
```
✅ Firestore initialized successfully
```

If you see a warning, check:
1. Your environment variables are set correctly
2. The service account file exists (if using file path)
3. The JSON is valid (if using JSON string)
4. You have the correct permissions

## Troubleshooting

### Error: "Firestore not configured"
- Check that at least one Firestore environment variable is set
- Verify the variable name is correct
- Restart your server after adding environment variables

### Error: "Permission denied"
- Ensure your service account has Firestore permissions
- Check that the service account JSON is valid
- Verify the project ID matches your Firebase project

### Error: "File not found"
- Check the file path is correct
- Ensure the file exists at the specified location
- Use absolute path if relative path doesn't work

## Security Best Practices

1. **Never commit service account files to Git**
   - Add `firebase-service-account.json` to `.gitignore`
   - Use environment variables in production

2. **Use different credentials for development and production**
   - Create separate Firebase projects if needed
   - Use different service accounts for each environment

3. **Restrict service account permissions**
   - Only grant necessary Firestore permissions
   - Use IAM roles to limit access

## What Happens on Driver Logout?

When a driver logs out:
1. Driver status is updated in MongoDB (`isLoggedin: false`)
2. FCM token, device ID, and access token are cleared
3. Driver is **deleted from Firestore** (if configured)
4. Response includes Firestore deletion status

The Firestore deletion is **non-blocking** - if it fails, the logout still succeeds.

## Need Help?

If you're having issues:
1. Check the server logs for detailed error messages
2. Verify your Firebase project settings
3. Ensure your service account has the correct permissions
4. Test with a simple Firestore read operation first
