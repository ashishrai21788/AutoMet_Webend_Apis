#!/bin/bash

# Firestore Setup Script
echo "🔥 Firestore Setup Guide"
echo "========================"
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo "⚠️  .env file not found. Creating it..."
    ./setup-env.sh
fi

echo ""
echo "Choose your Firestore configuration method:"
echo ""
echo "1. Service Account File Path (Recommended for Development)"
echo "2. Service Account JSON String (Recommended for Production)"
echo "3. Google Application Credentials"
echo "4. Project ID Only (Limited functionality)"
echo "5. Skip Firestore setup (logout will still work, but won't delete from Firestore)"
echo ""
read -p "Enter your choice (1-5): " choice

case $choice in
    1)
        echo ""
        echo "📁 Option 1: Service Account File Path"
        echo "======================================"
        echo ""
        echo "Steps:"
        echo "1. Go to https://console.firebase.google.com/"
        echo "2. Select your project"
        echo "3. Go to Project Settings → Service Accounts"
        echo "4. Click 'Generate New Private Key'"
        echo "5. Save the file as: config/firebase-service-account.json"
        echo ""
        read -p "Enter the path to your service account file (or press Enter for default): " filepath
        filepath=${filepath:-./config/firebase-service-account.json}
        
        if [ ! -f "$filepath" ]; then
            echo "⚠️  File not found at: $filepath"
            echo "Please download the service account JSON and save it to this location."
            exit 1
        fi
        
        # Add to .env
        if grep -q "FIREBASE_SERVICE_ACCOUNT_PATH" .env; then
            sed -i '' "s|FIREBASE_SERVICE_ACCOUNT_PATH=.*|FIREBASE_SERVICE_ACCOUNT_PATH=$filepath|" .env
        else
            echo "" >> .env
            echo "# Firestore Configuration" >> .env
            echo "FIREBASE_SERVICE_ACCOUNT_PATH=$filepath" >> .env
        fi
        
        echo "✅ Configuration added to .env"
        echo "✅ File path: $filepath"
        ;;
    2)
        echo ""
        echo "📝 Option 2: Service Account JSON String"
        echo "========================================"
        echo ""
        echo "Paste your Firebase service account JSON below (press Ctrl+D when done):"
        echo ""
        json_content=$(cat)
        
        # Add to .env (escape single quotes)
        escaped_json=$(echo "$json_content" | sed "s/'/'"'"'/g")
        
        if grep -q "FIREBASE_SERVICE_ACCOUNT_KEY" .env; then
            sed -i '' "s|FIREBASE_SERVICE_ACCOUNT_KEY=.*|FIREBASE_SERVICE_ACCOUNT_KEY='$escaped_json'|" .env
        else
            echo "" >> .env
            echo "# Firestore Configuration" >> .env
            echo "FIREBASE_SERVICE_ACCOUNT_KEY='$escaped_json'" >> .env
        fi
        
        echo "✅ Configuration added to .env"
        ;;
    3)
        echo ""
        echo "🔑 Option 3: Google Application Credentials"
        echo "==========================================="
        read -p "Enter the path to your credentials file: " credpath
        
        if grep -q "GOOGLE_APPLICATION_CREDENTIALS" .env; then
            sed -i '' "s|GOOGLE_APPLICATION_CREDENTIALS=.*|GOOGLE_APPLICATION_CREDENTIALS=$credpath|" .env
        else
            echo "" >> .env
            echo "# Firestore Configuration" >> .env
            echo "GOOGLE_APPLICATION_CREDENTIALS=$credpath" >> .env
        fi
        
        echo "✅ Configuration added to .env"
        ;;
    4)
        echo ""
        echo "🆔 Option 4: Project ID Only"
        echo "==========================="
        read -p "Enter your Firebase Project ID: " projectid
        
        if grep -q "FIREBASE_PROJECT_ID" .env; then
            sed -i '' "s|FIREBASE_PROJECT_ID=.*|FIREBASE_PROJECT_ID=$projectid|" .env
        else
            echo "" >> .env
            echo "# Firestore Configuration" >> .env
            echo "FIREBASE_PROJECT_ID=$projectid" >> .env
        fi
        
        echo "✅ Configuration added to .env"
        echo "⚠️  Note: This option has limited functionality"
        ;;
    5)
        echo ""
        echo "⏭️  Skipping Firestore setup"
        echo "Driver logout will still work, but drivers won't be deleted from Firestore."
        exit 0
        ;;
    *)
        echo "❌ Invalid choice"
        exit 1
        ;;
esac

echo ""
echo "📋 Next steps:"
echo "1. Restart your server: npm start"
echo "2. Check the logs for: '✅ Firestore initialized successfully'"
echo ""
echo "📖 For more details, see: FIRESTORE_SETUP.md"
echo ""
