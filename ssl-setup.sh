#!/bin/bash

echo "🔒 SSL Certificate Management"
echo "============================"

SSL_DIR="ssl"
KEY_FILE="$SSL_DIR/key.pem"
CERT_FILE="$SSL_DIR/cert.pem"

# Create SSL directory if it doesn't exist
if [ ! -d "$SSL_DIR" ]; then
    echo "📁 Creating SSL directory..."
    mkdir -p "$SSL_DIR"
fi

# Check if certificates exist
if [ -f "$KEY_FILE" ] && [ -f "$CERT_FILE" ]; then
    echo "✅ SSL certificates found:"
    echo "   Key: $KEY_FILE"
    echo "   Cert: $CERT_FILE"
    echo ""
    echo "🔍 Certificate details:"
    openssl x509 -in "$CERT_FILE" -text -noout | grep -E "(Subject:|Not Before:|Not After:)"
else
    echo "❌ SSL certificates not found. Generating new ones..."
    echo ""
    
    # Get IP address
    IP_ADDRESS=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | head -1)
    
    echo "🌐 Using IP address: $IP_ADDRESS"
    echo "📝 Generating SSL certificate..."
    
    openssl req -x509 -newkey rsa:4096 \
        -keyout "$KEY_FILE" \
        -out "$CERT_FILE" \
        -days 365 \
        -nodes \
        -subj "/C=US/ST=State/L=City/O=Organization/CN=$IP_ADDRESS"
    
    if [ $? -eq 0 ]; then
        echo "✅ SSL certificates generated successfully!"
        echo "   Key: $KEY_FILE"
        echo "   Cert: $CERT_FILE"
    else
        echo "❌ Failed to generate SSL certificates"
        exit 1
    fi
fi

echo ""
echo "🚀 Server URLs:"
echo "   HTTP:  http://$IP_ADDRESS:3000"
echo "   HTTPS: https://$IP_ADDRESS:3443"
echo ""
echo "📱 For mobile apps, use HTTPS URLs:"
echo "   Base URL: https://$IP_ADDRESS:3443/api"
echo ""
echo "⚠️  Note: This is a self-signed certificate for development."
echo "   For production, use a proper SSL certificate from a CA."
