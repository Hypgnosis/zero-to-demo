#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# voice-proxy/deploy.sh — Cloud Run deployment with warm instance
#
# Usage:
#   chmod +x deploy.sh
#   ./deploy.sh [PROJECT_ID]
#
# Requires: gcloud CLI authenticated with deploy permissions.
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

PROJECT_ID="${1:-${GCLOUD_PROJECT:-}}"
REGION="${CLOUD_RUN_REGION:-us-central1}"
SERVICE_NAME="axiom-voice-proxy"
IMAGE="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

if [[ -z "$PROJECT_ID" ]]; then
  echo "❌ Usage: ./deploy.sh <PROJECT_ID>"
  echo "   Or set GCLOUD_PROJECT env var."
  exit 1
fi

echo "═══════════════════════════════════════════════════════════"
echo "  Deploying ${SERVICE_NAME} to Cloud Run"
echo "  Project:  ${PROJECT_ID}"
echo "  Region:   ${REGION}"
echo "═══════════════════════════════════════════════════════════"

# 1. Build container
echo "▶ Building container image..."
gcloud builds submit \
  --project "${PROJECT_ID}" \
  --tag "${IMAGE}" \
  .

# 2. Deploy to Cloud Run with warm instance
echo "▶ Deploying to Cloud Run..."
gcloud run deploy "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --image "${IMAGE}" \
  --region "${REGION}" \
  --platform managed \
  --port 8080 \
  --allow-unauthenticated \
  --min-instances 1 \
  --max-instances 10 \
  --memory 512Mi \
  --cpu 1 \
  --timeout 3600 \
  --set-env-vars "NODE_ENV=production" \
  --update-secrets "GOOGLE_API_KEY=GOOGLE_API_KEY:latest,VOICE_PROXY_SECRET=VOICE_PROXY_SECRET:latest"

# 3. Get the service URL
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --format "value(status.url)")

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ✅ Deployed: ${SERVICE_URL}"
echo ""
echo "  IMPORTANT: Set this in Vercel dashboard:"
echo "    VOICE_PROXY_URL=${SERVICE_URL}"
echo ""
echo "  Min instances: 1 (WebSocket proxy stays warm)"
echo "  Timeout: 3600s (long-lived voice sessions)"
echo "═══════════════════════════════════════════════════════════"
