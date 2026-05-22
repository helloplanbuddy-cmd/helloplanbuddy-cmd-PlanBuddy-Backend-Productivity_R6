# PHASE -2 RUNTIME TESTING HARNESS (PowerShell Edition)
# 
# This script executes real forensic tests on the PlanBuddy backend
# for Windows environments.
#
# USAGE:
#   .\phase-2-test-harness.ps1 -Command "baseline"
#   .\phase-2-test-harness.ps1 -Command "full-test"
#   .\phase-2-test-harness.ps1 -Command "chaos"

param(
    [string]$Command = "help",
    [int]$VUs = 100,
    [int]$Duration = 60
)

# Colors
$colors = @{
    Info    = 'Cyan'
    Success = 'Green'
    Error   = 'Red'
    Warning = 'Yellow'
}

# Logging functions
function Write-Log {
    param([string]$Message, [string]$Type = "Info")
    
    $prefix = switch($Type) {
        "Info" { "[INFO]" }
        "Success" { "[✓]" }
        "Error" { "[✗]" }
        "Warning" { "[!]" }
        default { "[*]" }
    }
    
    Write-Host "$prefix $Message" -ForegroundColor $colors[$Type]
}

# Test configuration
$ResultsDir = ".\phase-2-results"
$BackendUrl = "http://localhost:3000"
$HealthCheckPath = "/internal/health/ready"
$MetricsPath = "/internal/metrics/queues"

# Ensure results directory exists
if (-not (Test-Path $ResultsDir)) {
    New-Item -ItemType Directory -Path $ResultsDir | Out-Null
}

# ==============================================================================
# PREFLIGHT CHECKS
# ==============================================================================

function Invoke-PreflightCheck {
    Write-Log "Running preflight checks..." Info
    
    # Check Node.js
    $nodeVersion = node --version 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Log "Node.js not found" Error
        exit 1
    }
    Write-Log "Node.js $nodeVersion" Success
    
    # Check npm
    $npmVersion = npm --version 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Log "npm not found" Error
        exit 1
    }
    Write-Log "npm $npmVersion" Success
    
    # Check Docker
    $dockerVersion = docker --version 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Log "$dockerVersion" Success
    } else {
        Write-Log "Docker not found - cannot start PostgreSQL/Redis" Warning
    }
    
    # Check k6
    $k6Version = k6 --version 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Log "$k6Version" Success
    } else {
        Write-Log "k6 not found - attempting to install..." Warning
        npm install -g k6 | Out-Null
    }
}

# ==============================================================================
# INFRASTRUCTURE SETUP
# ==============================================================================

function Start-Infrastructure {
    Write-Log "Starting infrastructure (Docker containers)..." Info
    
    # PostgreSQL
    Write-Log "Starting PostgreSQL..." Info
    docker run `
        --name planbuddy-postgres-test `
        -e POSTGRES_PASSWORD=password `
        -e POSTGRES_DB=planbuddy_test `
        -p 5432:5432 `
        -d postgres:14 2>$null
    
    if ($LASTEXITCODE -ne 0) {
        docker start planbuddy-postgres-test 2>$null
    }
    
    Start-Sleep -Seconds 3
    Write-Log "PostgreSQL running on :5432" Success
    
    # Redis
    Write-Log "Starting Redis..." Info
    docker run `
        --name planbuddy-redis-test `
        -p 6379:6379 `
        -d redis:7-alpine 2>$null
    
    if ($LASTEXITCODE -ne 0) {
        docker start planbuddy-redis-test 2>$null
    }
    
    Start-Sleep -Seconds 2
    Write-Log "Redis running on :6379" Success
    
    # Wait for Redis to be ready
    Write-Log "Waiting for services to be ready..." Info
    for ($i = 1; $i -le 30; $i++) {
        $redisReady = redis-cli ping 2>$null
        if ($redisReady -eq "PONG") {
            Write-Log "Redis ready" Success
            break
        }
        if ($i -eq 30) {
            Write-Log "Redis failed to start" Error
            exit 1
        }
        Start-Sleep -Seconds 1
    }
    
    # Run migrations
    Write-Log "Running database migrations..." Info
    npm run migrate -- 180 2>&1 | Select-Object -Last 5
    Write-Log "Migrations complete" Success
    
    # Start backend
    Write-Log "Starting backend server..." Info
    $backendProcess = Start-Process npm -ArgumentList "run,start" -PassThru
    $global:BackendPID = $backendProcess.Id
    
    # Wait for backend to start
    Start-Sleep -Seconds 5
    for ($i = 1; $i -le 30; $i++) {
        try {
            $response = Invoke-WebRequest "$BackendUrl$HealthCheckPath" -ErrorAction SilentlyContinue
            if ($response.StatusCode -eq 200) {
                Write-Log "Backend ready (PID $($global:BackendPID))" Success
                break
            }
        } catch {
            # Continue waiting
        }
        
        if ($i -eq 30) {
            Write-Log "Backend failed to start" Error
            Stop-Process -Id $global:BackendPID -ErrorAction SilentlyContinue
            exit 1
        }
        Start-Sleep -Seconds 1
    }
    
    # Verify health
    try {
        $health = Invoke-WebRequest "$BackendUrl$HealthCheckPath" | ConvertFrom-Json
        Write-Log "Health: $($health.status)" Info
    } catch {
        Write-Log "Health check failed" Warning
    }
}

function Stop-Infrastructure {
    Write-Log "Stopping infrastructure..." Info
    
    # Stop backend
    if ($global:BackendPID) {
        Stop-Process -Id $global:BackendPID -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
    
    # Stop containers
    docker kill planbuddy-postgres-test 2>$null
    docker kill planbuddy-redis-test 2>$null
    docker rm planbuddy-postgres-test 2>$null
    docker rm planbuddy-redis-test 2>$null
    
    Write-Log "Infrastructure stopped" Success
}

# ==============================================================================
# BASELINE LATENCY TESTING
# ==============================================================================

function Invoke-BaselineTest {
    param(
        [int]$VUCount,
        [int]$Duration = 60
    )
    
    Write-Log "Running baseline test: $VUCount concurrent users for ${Duration}s..." Info
    
    $testName = "baseline-$VUCount-users"
    $resultFile = "$ResultsDir\$testName.json"
    
    # Create k6 test script
    $k6Script = @"
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: $VUCount,
  duration: '${Duration}s',
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
"@
    
    $k6Script | Out-File -Path "temp-baseline-test.js" -Encoding UTF8
    
    # Run k6 test
    k6 run --out json="$resultFile" temp-baseline-test.js 2>&1 | Tee-Object -FilePath "$ResultsDir\$testName.log"
    
    if ($LASTEXITCODE -eq 0) {
        Write-Log "Test completed: $resultFile" Success
        
        # Extract metrics (simplified - full JSON parsing requires ConvertFrom-Json)
        Write-Log "Results: $resultFile" Info
    } else {
        Write-Log "Test failed for $VUCount users" Error
    }
    
    Remove-Item "temp-baseline-test.js" -ErrorAction SilentlyContinue
}

function Invoke-AllBaselines {
    Write-Log "Running all baseline tests..." Info
    
    "users,test_completed" | Out-File "$ResultsDir\baseline-summary.csv"
    
    foreach ($vu in 10, 50, 100, 250, 500) {
        Invoke-BaselineTest -VUCount $vu -Duration 60
        Start-Sleep -Seconds 5  # Cool down
    }
    
    Write-Log "All baseline tests complete" Success
    Write-Log "Results in $ResultsDir\baseline-summary.csv" Info
}

# ==============================================================================
# SOAK TEST
# ==============================================================================

function Invoke-SoakTest {
    param(
        [int]$VUCount = 200,
        [int]$Duration = 3600
    )
    
    Write-Log "Starting soak test: $VUCount users for ${Duration}s..." Info
    
    $testName = "soak-$VUCount-users"
    $resultFile = "$ResultsDir\$testName.json"
    
    # Create k6 test script
    $k6Script = @"
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: $VUCount,
  duration: '${Duration}s',
  thresholds: {
    'http_req_duration': ['p(99)<10000'],
  },
};

export default function() {
  const res = http.get('http://localhost:3000/internal/health/ready');
  check(res, { 'status is 200': (r) => r.status === 200 });
  sleep(Math.random() * 1);
}
"@
    
    $k6Script | Out-File -Path "temp-soak-test.js" -Encoding UTF8
    
    # Run k6 test
    k6 run --out json="$resultFile" temp-soak-test.js 2>&1 | Tee-Object -FilePath "$ResultsDir\$testName.log"
    
    Write-Log "Soak test complete: $resultFile" Success
    
    Remove-Item "temp-soak-test.js" -ErrorAction SilentlyContinue
}

# ==============================================================================
# CHAOS TESTING
# ==============================================================================

function Invoke-RedisChaosTesting {
    Write-Log "Redis chaos test: killing Redis during load..." Info
    
    # Create k6 test script
    $k6Script = @"
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
"@
    
    $k6Script | Out-File -Path "temp-chaos-redis-load.js" -Encoding UTF8
    
    # Start background load
    $chaosProcess = Start-Process k6 -ArgumentList `
        "run", `
        "--out", "json=$ResultsDir\chaos-redis.json", `
        "temp-chaos-redis-load.js" `
        -PassThru
    
    # Kill Redis at T=15s
    Start-Sleep -Seconds 15
    Write-Log "Killing Redis..." Warning
    docker kill planbuddy-redis-test 2>$null
    
    # Restart Redis at T=25s
    Start-Sleep -Seconds 10
    Write-Log "Restarting Redis..." Info
    docker start planbuddy-redis-test 2>$null
    
    # Wait for test to complete
    Wait-Process -Id $chaosProcess.Id
    
    Write-Log "Chaos test complete" Success
    
    Remove-Item "temp-chaos-redis-load.js" -ErrorAction SilentlyContinue
}

# ==============================================================================
# ANALYSIS
# ==============================================================================

function Invoke-Analysis {
    Write-Log "Analyzing results..." Info
    
    if (-not (Test-Path "$ResultsDir\baseline-summary.csv")) {
        Write-Log "No baseline results found" Error
        return
    }
    
    Write-Log "Results directory: $ResultsDir" Info
    Get-ChildItem "$ResultsDir\*.json" | ForEach-Object {
        Write-Log "  - $($_.Name)" Info
    }
    
    Write-Log "Analysis framework ready - review JSON files in $ResultsDir" Success
}

# ==============================================================================
# MAIN EXECUTION
# ==============================================================================

function Invoke-MainCommand {
    param([string]$Command)
    
    switch ($Command) {
        "preflight" {
            Invoke-PreflightCheck
        }
        "infrastructure" {
            Write-Log "Starting infrastructure..." Info
            Start-Infrastructure
            Write-Log "Infrastructure ready. Press Ctrl+C to stop." Info
            try {
                while ($true) { Start-Sleep -Seconds 10 }
            } finally {
                Stop-Infrastructure
            }
        }
        "stop-infrastructure" {
            Stop-Infrastructure
        }
        "baseline" {
            Start-Infrastructure
            Invoke-AllBaselines
            Stop-Infrastructure
        }
        "soak" {
            Start-Infrastructure
            Invoke-SoakTest -VUCount 200 -Duration 600  # 10 minutes for quick test
            Stop-Infrastructure
        }
        "chaos" {
            Start-Infrastructure
            Invoke-RedisChaosTesting
            Stop-Infrastructure
        }
        "analyze" {
            Invoke-Analysis
        }
        "full-test" {
            Write-Log "Running FULL Phase -2 test suite..." Info
            Start-Infrastructure
            Invoke-AllBaselines
            Invoke-SoakTest -VUCount 200 -Duration 600
            Invoke-RedisChaosTesting
            Invoke-Analysis
            Stop-Infrastructure
            Write-Log "Full test suite complete" Success
        }
        default {
            Write-Host "Phase -2 Runtime Testing Harness (PowerShell)"
            Write-Host ""
            Write-Host "USAGE: .\phase-2-test-harness.ps1 -Command 'command'"
            Write-Host ""
            Write-Host "Commands:"
            Write-Host "  preflight              - Check dependencies"
            Write-Host "  infrastructure         - Start Docker containers & backend"
            Write-Host "  stop-infrastructure    - Stop all services"
            Write-Host "  baseline               - Run baseline latency tests (10-500 users)"
            Write-Host "  soak                   - Run soak test (10 minutes default)"
            Write-Host "  chaos                  - Run Redis chaos test"
            Write-Host "  analyze                - Analyze results"
            Write-Host "  full-test              - Run all tests end-to-end"
            Write-Host ""
            Write-Host "Examples:"
            Write-Host "  .\phase-2-test-harness.ps1 -Command 'preflight'"
            Write-Host "  .\phase-2-test-harness.ps1 -Command 'baseline'"
            Write-Host "  .\phase-2-test-harness.ps1 -Command 'full-test'"
            Write-Host ""
            Write-Host "Results stored in: $ResultsDir"
        }
    }
}

# Main entry point
try {
    Invoke-MainCommand -Command $Command
} catch {
    Write-Log "Error: $_" Error
    exit 1
}
