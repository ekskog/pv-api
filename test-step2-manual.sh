#!/bin/bash

echo "============================================================"
echo "STEP 2 MANUAL TEST: Test Conversion Endpoint with curl"
echo "============================================================"

API_URL="http://localhost:3001"

echo
echo "📋 Test 1: API Health Check"
echo "------------------------------"
curl -s "$API_URL/health" | jq '.' || echo "❌ Health check failed or jq not installed"

echo
echo "📋 Test 2: Test Conversion Endpoint (requires test image)"
echo "------------------------------"

# Check if we have a test image
if [ -f "test-image.png" ]; then
    echo "Using existing test-image.png"
    curl -X POST \
         -F "image=@test-image.png" \
         -H "Content-Type: multipart/form-data" \
         "$API_URL/convert-test" | jq '.' || echo "❌ Conversion test failed or jq not installed"
else
    echo "❌ No test-image.png found. Please create one or use test-step2.js instead."
    echo "   You can create one with: convert -size 100x100 xc:red test-image.png"
fi

echo
echo "📋 Test 3: Error Handling (no file)"
echo "------------------------------"
curl -X POST \
     -H "Content-Type: multipart/form-data" \
     "$API_URL/convert-test" | jq '.' || echo "❌ Error handling test failed or jq not installed"

echo
echo "🔧 Troubleshooting:"
echo "   1. Make sure both services are running:"
echo "      - photovault-api: npm run dev"
echo "      - avif-converter: cd ../avif-converter && node api.js"
echo "   2. Install jq for better JSON formatting: brew install jq"
echo "   3. For full test with image generation: node test-step2.js"
