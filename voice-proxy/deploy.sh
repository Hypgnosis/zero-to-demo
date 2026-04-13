#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# voice-proxy/deploy.sh — Cloud Run deployment (Phase 3 Hardened)
#
# Finding 5 Remedy:
# - Ingress locked to internal-and-cloud-load-balancing.
# - NO --allow-unauthenticated — IAM-protected.
# - Frontend reaches proxy ONLY via backend-assigned endpoint.
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
echo "  Deploying ${SERVICE_NAME} to Cloud Run (Phase 3 Hardened)"
echo "  Project:  ${PROJECT_ID}"
echo "  Region:   ${REGION}"
echo "  Ingress:  internal-and-cloud-load-balancing (Finding 5)"
echo "═══════════════════════════════════════════════════════════"

# 1. Build container
echo "▶ Building container image..."
gcloud builds submit \
  --project "${PROJECT_ID}" \
  --tag "${IMAGE}" \
  .

# 2. Deploy to Cloud Run — HARDENED
#
# Phase 3 Security Controls:
# --ingress=internal-and-cloud-load-balancing
#   → Blocks direct access from the public internet.
#   → Only reachable via Cloud Load Balancer or internal traffic.
#
# --no-allow-unauthenticated
#   → Requires IAM invoker role. The Axiom-0 backend service account
#     must have roles/run.invoker on this service.
#
echo "▶ Deploying to Cloud Run (VPC-locked)..."
gcloud run deploy "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --image "${IMAGE}" \
  --region "${REGION}" \
  --platform managed \
  --port 8080 \
  --ingress internal-and-cloud-load-balancing \
  --no-allow-unauthenticated \
  --min-instances 1 \
  --max-instances 10 \
  --memory 512Mi \
  --cpu 1 \
  --timeout 3600 \
  --set-env-vars "NODE_ENV=production" \
  --update-secrets "GOOGLE_API_KEY=GOOGLE_API_KEY:latest,VOICE_PROXY_SECRET=VOICE_PROXY_SECRET:latest,UPSTASH_VECTOR_REST_URL=UPSTASH_VECTOR_REST_URL:latest,UPSTASH_VECTOR_REST_TOKEN=UPSTASH_VECTOR_REST_TOKEN:latest"

# 3. Get the service URL
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --format "value(status.url)")

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ✅ Deployed: ${SERVICE_URL}"
echo ""
echo "  ⚠️  INGRESS LOCKED: internal-and-cloud-load-balancing"
echo "  ⚠️  IAM REQUIRED: Grant roles/run.invoker to the backend SA"
echo ""
echo "  IMPORTANT: Set this in Vercel dashboard:"
echo "    VOICE_PROXY_URL=${SERVICE_URL}"
echo ""
echo "  Min instances: 1 (WebSocket proxy stays warm)"
echo "  Timeout: 3600s (long-lived voice sessions)"
echo "═══════════════════════════════════════════════════════════"

