#!/bin/bash

# Environment Setup Script
echo "🔧 Setting up environment variables..."

# Create .env file if it doesn't exist
if [ ! -f .env ]; then
    echo "📝 Creating .env file..."
    cat > .env << EOF
# Server Configuration
PORT=3000
HOST=0.0.0.0
NODE_ENV=development

# JWT Configuration
JWT_SECRET=your_super_secret_jwt_key_change_this_in_production_$(date +%s)

# MongoDB Configuration
MONGODB_USERNAME=your_mongodb_username
MONGODB_PASSWORD=your_mongodb_password
MONGODB_CLUSTER=your_mongodb_cluster
DB_NAME=your_database_name

# Server Health Check Configuration
HEALTH_CHECK_INTERVAL=30000
MAX_MEMORY_USAGE=500

# Firestore Configuration (Choose ONE option - uncomment the one you want to use)
# Option 1: Service Account JSON (recommended for production)
# FIREBASE_SERVICE_ACCOUNT_KEY='{"type":"service_account","project_id":"your-project-id",...}'

# Option 2: Service Account File Path (recommended for local development)
# FIREBASE_SERVICE_ACCOUNT_PATH=./config/firebase-service-account.json

# Option 3: Google Application Credentials
# GOOGLE_APPLICATION_CREDENTIALS=/path/to/your/credentials.json

# Option 4: Project ID Only (for development/testing)
# FIREBASE_PROJECT_ID=your-firebase-project-id

# Optional: Custom Firestore Collection Name (default: drivers)
# FIRESTORE_DRIVERS_COLLECTION=drivers
EOF
    echo "✅ .env file created"
else
    echo "⚠️  .env file already exists"
fi

echo ""
echo "📋 Next steps:"
echo "1. Edit the .env file with your actual MongoDB credentials"
echo "2. Update MONGODB_USERNAME, MONGODB_PASSWORD, MONGODB_CLUSTER, and DB_NAME"
echo "3. Restart your server: npm run start:monitored"
echo ""
echo "🔍 To check server health: npm run health"
echo "📊 To monitor server: npm run monitor"
