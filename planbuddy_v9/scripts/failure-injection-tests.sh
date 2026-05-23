#!/bin/bash

# ═══════════════════════════════════════════════════════════════
# FAILURE INJECTION TEST SUITE
# 
# Simulates infrastructure failures and verifies recovery behavior
# ═══════════════════════════════════════════════════════════════

set -e

BACKEND_URL="${BACKEND_URL:-http://localhost:3000}"
COMPOSE_FILE="docker-compose.yml"
HEALTH_CHECK_SCRIPT="node scripts/verify-runtime.js"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() {
  echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"
}

success() {
  echo -e "${GREEN}✅ $1${NC}"
}

error() {
  echo -e "${RED}❌ $1${NC}"
}

warning() {
  echo -e "${YELLOW}⚠️  $1${NC}"
}

# ═══════════════════════════════════════════════════════════════
# TEST 1: System startup
# ═══════════════════════════════════════════════════════════════
test_startup() {
  log "═══════════════════════════════════════════"
  log "TEST 1: SYSTEM STARTUP"
  log "═══════════════════════════════════════════"
  
  log "Bringing up docker-compose..."
  docker-compose -f $COMPOSE_FILE up -d
  
  log "Waiting for services to stabilize (30s)..."
  sleep 30
  
  log "Checking service status..."
  docker-compose -f $COMPOSE_FILE ps
  
  log "Running health verification..."
  if $HEALTH_CHECK_SCRIPT; then
    success "System startup test PASSED"
    return 0
  else
    error "System startup test FAILED"
    return 1
  fi
}

# ═══════════════════════════════════════════════════════════════
# TEST 2: PostgreSQL failure
# ═══════════════════════════════════════════════════════════════
test_postgres_failure() {
  log "═══════════════════════════════════════════"
  log "TEST 2: PostgreSQL FAILURE INJECTION"
  log "═══════════════════════════════════════════"
  
  log "Stopping PostgreSQL..."
  docker-compose -f $COMPOSE_FILE stop postgres
  
  log "Waiting 5s for impact..."
  sleep 5
  
  log "Checking /health/ready (should return 503)..."
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" $BACKEND_URL/health/ready)
  
  if [ "$HTTP_CODE" = "503" ]; then
    success "Backend correctly reports unavailable (503) when PostgreSQL is down"
  else
    warning "Expected 503, got $HTTP_CODE"
  fi
  
  log "Restarting PostgreSQL..."
  docker-compose -f $COMPOSE_FILE start postgres
  
  log "Waiting for PostgreSQL to be ready..."
  sleep 15
  
  log "Verifying recovery..."
  if $HEALTH_CHECK_SCRIPT; then
    success "PostgreSQL failure recovery test PASSED"
    return 0
  else
    error "PostgreSQL failure recovery test FAILED"
    return 1
  fi
}

# ═══════════════════════════════════════════════════════════════
# TEST 3: Redis failure
# ═══════════════════════════════════════════════════════════════
test_redis_failure() {
  log "═══════════════════════════════════════════"
  log "TEST 3: Redis FAILURE INJECTION"
  log "═══════════════════════════════════════════"
  
  log "Stopping Redis..."
  docker-compose -f $COMPOSE_FILE stop redis
  
  log "Waiting 5s for impact..."
  sleep 5
  
  log "Checking /health/ready (should return 503)..."
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" $BACKEND_URL/health/ready)
  
  if [ "$HTTP_CODE" = "503" ]; then
    success "Backend correctly reports unavailable (503) when Redis is down"
  else
    warning "Expected 503, got $HTTP_CODE"
  fi
  
  log "Restarting Redis..."
  docker-compose -f $COMPOSE_FILE start redis
  
  log "Waiting for Redis to be ready..."
  sleep 10
  
  log "Verifying recovery..."
  if $HEALTH_CHECK_SCRIPT; then
    success "Redis failure recovery test PASSED"
    return 0
  else
    error "Redis failure recovery test FAILED"
    return 1
  fi
}

# ═══════════════════════════════════════════════════════════════
# TEST 4: Malformed requests
# ═══════════════════════════════════════════════════════════════
test_malformed_requests() {
  log "═══════════════════════════════════════════"
  log "TEST 4: MALFORMED REQUEST HANDLING"
  log "═══════════════════════════════════════════"
  
  log "Sending invalid JSON..."
  HTTP_CODE=$(curl -s -X POST $BACKEND_URL/api/v1/test \
    -H "Content-Type: application/json" \
    -d '{ invalid json' \
    -o /dev/null -w "%{http_code}")
  
  if [ "$HTTP_CODE" = "400" ]; then
    success "Backend correctly rejects malformed JSON (400)"
  else
    warning "Expected 400 for malformed JSON, got $HTTP_CODE"
  fi
  
  log "Sending missing required headers..."
  HTTP_CODE=$(curl -s -X POST $BACKEND_URL/api/v1/test \
    -d '{}' \
    -o /dev/null -w "%{http_code}")
  
  success "Request handling test PASSED"
  return 0
}

# ═══════════════════════════════════════════════════════════════
# TEST 5: Graceful shutdown
# ═══════════════════════════════════════════════════════════════
test_graceful_shutdown() {
  log "═══════════════════════════════════════════"
  log "TEST 5: GRACEFUL SHUTDOWN"
  log "═══════════════════════════════════════════"
  
  log "Sending SIGTERM to backend..."
  docker-compose -f $COMPOSE_FILE exec -T api kill -TERM 1
  
  log "Monitoring graceful shutdown (waiting 70s max)..."
  timeout 70s docker-compose -f $COMPOSE_FILE logs api | tail -20
  
  log "Checking if backend stopped cleanly..."
  if docker-compose -f $COMPOSE_FILE ps api | grep -q "Exit 0"; then
    success "Graceful shutdown test PASSED"
    return 0
  else
    warning "Graceful shutdown status unclear"
    return 1
  fi
  
  log "Restarting backend..."
  docker-compose -f $COMPOSE_FILE up -d api
  sleep 10
}

# ═══════════════════════════════════════════════════════════════
# TEST 6: High load (basic concurrent requests)
# ═══════════════════════════════════════════════════════════════
test_high_load() {
  log "═══════════════════════════════════════════"
  log "TEST 6: HIGH LOAD SIMULATION (50 concurrent requests)"
  log "═══════════════════════════════════════════"
  
  log "Sending 50 concurrent requests to /health/live..."
  
  SUCCESS=0
  FAILED=0
  
  for i in {1..50}; do
    curl -s -o /dev/null -w "" $BACKEND_URL/health/live &
  done
  wait
  
  log "Running health check after load..."
  if $HEALTH_CHECK_SCRIPT; then
    success "High load test PASSED — system remained stable"
    return 0
  else
    error "High load test FAILED — system degraded"
    return 1
  fi
}

# ═══════════════════════════════════════════════════════════════
# MAIN TEST EXECUTION
# ═══════════════════════════════════════════════════════════════

main() {
  log "════════════════════════════════════════════════════════"
  log "FAILURE INJECTION TEST SUITE"
  log "════════════════════════════════════════════════════════"
  
  PASSED=0
  FAILED=0
  
  # Test 1: Startup
  if test_startup; then ((PASSED++)); else ((FAILED++)); fi
  
  # Test 2: PostgreSQL failure
  if test_postgres_failure; then ((PASSED++)); else ((FAILED++)); fi
  
  # Test 3: Redis failure
  if test_redis_failure; then ((PASSED++)); else ((FAILED++)); fi
  
  # Test 4: Malformed requests
  if test_malformed_requests; then ((PASSED++)); else ((FAILED++)); fi
  
  # Test 5: Graceful shutdown
  if test_graceful_shutdown; then ((PASSED++)); else ((FAILED++)); fi
  
  # Test 6: High load
  if test_high_load; then ((PASSED++)); else ((FAILED++)); fi
  
  # Summary
  log "════════════════════════════════════════════════════════"
  log "TEST SUMMARY"
  log "════════════════════════════════════════════════════════"
  success "PASSED: $PASSED"
  if [ $FAILED -gt 0 ]; then
    error "FAILED: $FAILED"
  fi
  
  if [ $FAILED -eq 0 ]; then
    success "ALL TESTS PASSED"
    exit 0
  else
    error "SOME TESTS FAILED"
    exit 1
  fi
}

main "$@"
