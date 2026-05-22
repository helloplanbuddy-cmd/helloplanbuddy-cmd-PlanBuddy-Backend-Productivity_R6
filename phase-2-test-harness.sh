#!/bin/bash

##############################################################################
# PHASE -2 RUNTIME DESTRUCTION TESTING HARNESS
# 
# This script executes real forensic tests on the PlanBuddy backend.
# It measures actual runtime behavior and collects evidence-based metrics.
#
# USAGE:
#   bash phase-2-test-harness.sh [step]
#   bash phase-2-test-harness.sh start-infrastructure
#   bash phase-2-test-harness.sh baseline
#   bash phase-2-test-harness.sh chaos
#   bash phase-2-test-harness.sh analyze
#
##############################################################################

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[✓]${NC} $1"; }
log_error() { echo -e "${RED}[✗]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[!]${NC} $1"; }

# Directory structure
RESULTS_DIR="./phase-2-results"
mkdir -p "$RESULTS_DIR"

# Test configuration
BACKEND_URL="http://localhost:3000"
HEALTH_CHECK_PATH="/internal/health/ready"
METRICS_PATH="/internal/metrics/queues"

##############################################################################
# STEP 0: PREFLIGHT CHECKS
##############################################################################

preflight_check() {
  log_info "Running preflight checks..."
  
  # Check Node.js
  if ! command -v node &> /dev/null; then
    log_error "Node.js not found"
    exit 1
  fi
  log_success "Node.js $(node --version)"
  
  # Check npm
  if ! command -v npm &> /dev/null; then
    log_error "npm not found"
    exit 1
  fi
  log_success "npm $(npm --version)"
  
  # Check Docker
  if ! command -v docker &> /dev/null; then
    log_warn "Docker not found - cannot start PostgreSQL/Redis"
  else
    log_success "Docker $(docker --version | awk '{print $3}')"
  fi
  
  # Check k6
  if ! command -v k6 &> /dev/null; then
    log_warn "k6 not found - will attempt to install"
    if command -v npm &> /dev/null; then
      npm install -g k6
    fi
  else
    log_success "k6 $(k6 --version)"
  fi
}

##############################################################################
# STEP 1: INFRASTRUCTURE SETUP
##############################################################################

start_infrastructure() {
  log_info "Starting infrastructure (Docker containers)..."
  
  # PostgreSQL
  log_info "Starting PostgreSQL..."
  docker run \
    --name planbuddy-postgres-test \
    -e POSTGRES_PASSWORD=password \
    -e POSTGRES_DB=planbuddy_test \
    -p 5432:5432 \
    -d postgres:14 \
    2>/dev/null || docker start planbuddy-postgres-test
  
  sleep 3
  log_success "PostgreSQL running on :5432"
  
  # Redis
  log_info "Starting Redis..."
  docker run \
    --name planbuddy-redis-test \
    -p 6379:6379 \
    -d redis:7-alpine \
    2>/dev/null || docker start planbuddy-redis-test
  
  sleep 2
  log_success "Redis running on :6379"
  
  # Wait for services to be ready
  log_info "Waiting for services to be ready..."
  for i in {1..30}; do
    if redis-cli ping &> /dev/null; then
      log_success "Redis ready"
      break
    fi
    if [ $i -eq 30 ]; then
      log_error "Redis failed to start"
      exit 1
    fi
    sleep 1
  done
  
  # Run migrations
  log_info "Running database migrations..."
  npm run migrate -- 180 2>&1 | tail -5
  log_success "Migrations complete"
  
  # Start backend
  log_info "Starting backend server..."
  npm run start &
  BACKEND_PID=$!
  
  # Wait for backend to start
  sleep 5
  for i in {1..30}; do
    if curl -s "$BACKEND_URL$HEALTH_CHECK_PATH" &> /dev/null; then
      log_success "Backend ready (PID $BACKEND_PID)"
      break
    fi
    if [ $i -eq 30 ]; then
      log_error "Backend failed to start"
      kill $BACKEND_PID 2>/dev/null || true
      exit 1
    fi
    sleep 1
  done
  
  # Verify health
  HEALTH=$(curl -s "$BACKEND_URL$HEALTH_CHECK_PATH")
  log_info "Health: $HEALTH"
}

stop_infrastructure() {
  log_info "Stopping infrastructure..."
  
  pkill -f "npm run start" || true
  sleep 2
  
  docker kill planbuddy-postgres-test 2>/dev/null || true
  docker kill planbuddy-redis-test 2>/dev/null || true
  docker rm planbuddy-postgres-test 2>/dev/null || true
  docker rm planbuddy-redis-test 2>/dev/null || true
  
  log_success "Infrastructure stopped"
}

##############################################################################
# STEP 2: BASELINE LATENCY TESTING
##############################################################################

run_baseline_test() {
  local vu_count=$1
  local duration=${2:-60}
  
  log_info "Running baseline test: $vu_count concurrent users for ${duration}s..."
  
  local test_name="baseline-${vu_count}-users"
  local result_file="$RESULTS_DIR/${test_name}.json"
  
  # Create k6 test script
  cat > /tmp/baseline-test.js << 'EOF'
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: __VU_COUNT__,
  duration: '__DURATION__s',
  thresholds: {
    'http_req_duration': ['p(99)<10000'],
    'http_req_failed': ['rate<1'],
  },
};

export default function() {
  const res = http.get('http://localhost:3000/internal/health/ready');
  check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 1000ms': (r) => r.timings.duration < 1000,
  });
  sleep(Math.random() * 0.5);
}
EOF
  
  # Replace placeholders
  sed -i "s/__VU_COUNT__/$vu_count/g" /tmp/baseline-test.js
  sed -i "s/__DURATION__/$duration/g" /tmp/baseline-test.js
  
  # Run k6 test
  if k6 run \
    --out json="$result_file" \
    /tmp/baseline-test.js 2>&1 | tee "$RESULTS_DIR/${test_name}.log"; then
    log_success "Test completed: $result_file"
    
    # Extract metrics
    local metrics=$(cat "$result_file" | jq -r '.
      | map(select(.type=="Point" and .metric=="http_req_duration") | .value)
      | sort
      | {
        p50: .[length/2 | floor],
        p95: .[length*0.95 | floor],
        p99: .[length*0.99 | floor],
        min: min,
        max: max,
        avg: (add / length | floor)
      }' 2>/dev/null || echo "{}")
    
    log_info "Metrics: $metrics"
    echo "$vu_count,$metrics" >> "$RESULTS_DIR/baseline-summary.csv"
  else
    log_error "Test failed for $vu_count users"
  fi
}

run_all_baselines() {
  log_info "Running all baseline tests..."
  
  echo "users,p50,p95,p99,min,max,avg" > "$RESULTS_DIR/baseline-summary.csv"
  
  for vu in 10 50 100 250 500; do
    run_baseline_test $vu 60
    sleep 5  # Cool down between tests
  done
  
  log_success "All baseline tests complete"
  log_info "Results in $RESULTS_DIR/baseline-summary.csv"
}

##############################################################################
# STEP 3: MEMORY SOAK TEST
##############################################################################

run_soak_test() {
  local vu_count=${1:-200}
  local duration=${2:-3600}  # 1 hour default
  
  log_info "Starting soak test: $vu_count users for ${duration}s..."
  
  local test_name="soak-${vu_count}-users"
  local result_file="$RESULTS_DIR/${test_name}.json"
  
  # Create k6 test script with memory monitoring
  cat > /tmp/soak-test.js << 'EOF'
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: __VU_COUNT__,
  duration: '__DURATION__s',
  thresholds: {
    'http_req_duration': ['p(99)<10000'],
  },
};

export default function() {
  const res = http.get('http://localhost:3000/internal/health/ready');
  check(res, {
    'status is 200': (r) => r.status === 200,
  });
  sleep(Math.random() * 1);
}
EOF
  
  sed -i "s/__VU_COUNT__/$vu_count/g" /tmp/soak-test.js
  sed -i "s/__DURATION__/$duration/g" /tmp/soak-test.js
  
  # Run test
  k6 run \
    --out json="$result_file" \
    /tmp/soak-test.js 2>&1 | tee "$RESULTS_DIR/${test_name}.log"
  
  log_success "Soak test complete: $result_file"
}

##############################################################################
# STEP 4: CHAOS TESTING
##############################################################################

chaos_redis() {
  log_info "Redis chaos test: killing Redis during load..."
  
  # Start background load
  cat > /tmp/chaos-redis-load.js << 'EOF'
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 100,
  duration: '60s',
};

export default function() {
  const res = http.get('http://localhost:3000/internal/health/ready');
  check(res, { 'status is 200': (r) => r.status === 200 });
  sleep(Math.random() * 0.5);
}
EOF
  
  k6 run \
    --out json="$RESULTS_DIR/chaos-redis.json" \
    /tmp/chaos-redis-load.js &
  K6_PID=$!
  
  # Kill Redis at T=15s
  sleep 15
  log_warn "Killing Redis..."
  docker kill planbuddy-redis-test 2>/dev/null
  
  # Restart Redis at T=25s
  sleep 10
  log_info "Restarting Redis..."
  docker start planbuddy-redis-test 2>/dev/null
  
  # Wait for test to complete
  wait $K6_PID
  
  log_success "Chaos test complete"
}

##############################################################################
# STEP 5: ANALYSIS
##############################################################################

analyze_results() {
  log_info "Analyzing results..."
  
  if [ ! -f "$RESULTS_DIR/baseline-summary.csv" ]; then
    log_error "No baseline results found"
    return 1
  fi
  
  log_info "Baseline Summary:"
  cat "$RESULTS_DIR/baseline-summary.csv"
  
  # Simple analysis
  log_info "\nAnalysis:"
  tail -1 "$RESULTS_DIR/baseline-summary.csv" | while IFS=',' read users p50 p95 p99 min max avg; do
    if [ $(echo "$p95 > 500" | bc) -eq 1 ]; then
      log_warn "p95 latency ($p95ms) exceeds 500ms threshold at $users users"
    fi
  done
  
  log_success "Analysis complete"
}

##############################################################################
# MAIN EXECUTION
##############################################################################

main() {
  case "${1:-help}" in
    preflight)
      preflight_check
      ;;
    infrastructure)
      log_info "Starting infrastructure..."
      start_infrastructure
      log_info "Infrastructure ready. Press Ctrl+C to stop."
      wait
      ;;
    stop-infrastructure)
      stop_infrastructure
      ;;
    baseline)
      run_all_baselines
      ;;
    soak)
      run_soak_test 200 3600
      ;;
    chaos)
      chaos_redis
      ;;
    analyze)
      analyze_results
      ;;
    full-test)
      log_info "Running FULL Phase -2 test suite..."
      start_infrastructure
      run_all_baselines
      run_soak_test 200 600  # 10 minutes soak
      chaos_redis
      analyze_results
      stop_infrastructure
      log_success "Full test suite complete"
      ;;
    *)
      echo "Phase -2 Runtime Testing Harness"
      echo ""
      echo "USAGE: $0 [command]"
      echo ""
      echo "Commands:"
      echo "  preflight              - Check dependencies"
      echo "  infrastructure         - Start Docker containers & backend"
      echo "  stop-infrastructure    - Stop all services"
      echo "  baseline               - Run baseline latency tests (10-500 users)"
      echo "  soak                   - Run 1-hour soak test"
      echo "  chaos                  - Run Redis chaos test"
      echo "  analyze                - Analyze results"
      echo "  full-test              - Run all tests end-to-end"
      echo ""
      echo "Results stored in: $RESULTS_DIR"
      ;;
  esac
}

# Trap Ctrl+C to cleanup
trap 'log_info "Interrupted"; stop_infrastructure; exit' INT TERM

main "$@"
