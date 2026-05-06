# Payment Service

This service is responsible for processing and validating payments through the
application with robust retry logic for external payment API calls.

## Features

### Retry Logic
The payment service includes comprehensive retry logic for external payment API calls with the following features:

- **Exponential Backoff**: Progressively increases delay between retries
- **Jitter**: Adds randomization to prevent thundering herd problems
- **Configurable Limits**: Maximum retries, delays, and backoff multipliers
- **Smart Error Classification**: Distinguishes between retryable and non-retryable errors
- **Comprehensive Telemetry**: Detailed OpenTelemetry spans and metrics for retry attempts

### Configuration

The retry behavior can be configured using environment variables:

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PAYMENT_RETRY_MAX_ATTEMPTS` | `3` | Maximum number of retry attempts |
| `PAYMENT_RETRY_BASE_DELAY_MS` | `100` | Base delay in milliseconds before first retry |
| `PAYMENT_RETRY_MAX_DELAY_MS` | `5000` | Maximum delay in milliseconds between retries |
| `PAYMENT_RETRY_BACKOFF_MULTIPLIER` | `2` | Multiplier for exponential backoff |
| `PAYMENT_RETRY_JITTER_ENABLED` | `true` | Enable jitter to randomize delays |
| `PAYMENT_SIMULATE_FAILURES` | `false` | Enable failure simulation for testing |
| `PAYMENT_FAILURE_RATE` | `0.2` | Failure rate (0.0-1.0) when simulation is enabled |
| `PAYMENT_GATEWAY_URL` | `https://api.example-payment-provider.com` | Payment gateway base URL |
| `PAYMENT_GATEWAY_API_KEY` | `demo-key` | Payment gateway API key |
| `PAYMENT_GATEWAY_TIMEOUT_MS` | `5000` | Payment gateway timeout in milliseconds |
| `PAYMENT_HEALTH_CHECK_INTERVAL_MS` | `30000` | Health check interval in milliseconds |

### Retry Behavior

#### Retryable Errors
The following types of errors will trigger retry attempts:
- Network connectivity issues (ECONNRESET, ECONNREFUSED, ETIMEDOUT, etc.)
- DNS resolution failures (ENOTFOUND, EAI_AGAIN)
- HTTP status codes: 429 (Too Many Requests), 500, 502, 503, 504

#### Non-Retryable Errors
Business logic errors that won't be retried:
- Invalid card information
- Insufficient funds
- Expired cards
- Authentication failures
- HTTP 4xx errors (except 429)

#### Backoff Strategy
- **Initial delay**: Configured base delay (default: 100ms)
- **Exponential growth**: Each retry delay = previous delay × backoff multiplier
- **Maximum cap**: Delays won't exceed the configured maximum (default: 5000ms)
- **Jitter**: Random factor (50-100%) applied to prevent synchronized retries

### Observability

#### OpenTelemetry Spans
- `charge`: Main payment processing span
- `payment_gateway.process_payment`: Gateway processing with retry logic
- `payment_gateway.api_call`: Individual API call attempts
- `payment_gateway.health_check`: Gateway health verification

#### Metrics
- `app.payment.transactions`: Counter of payment transactions
- `app.payment.retries`: Counter of retry attempts
- `app.payment.gateway_latency`: Histogram of gateway response times

#### Span Attributes
Retry-related attributes added to spans:
- `app.payment.retry.enabled`: Whether retry logic is active
- `app.payment.retry.success_attempt`: Which attempt succeeded
- `app.payment.retry.total_attempts`: Total number of attempts made
- `app.payment.retry.attempt_N.error`: Error details for each attempt
- `app.payment.retry.attempt_N.delay_ms`: Delay before each retry
- `app.payment.retry.exhausted`: Whether all retries were exhausted
- `app.payment.retry.final_error`: Final error after exhausting retries

### Health Monitoring

The service includes automated health monitoring that:
- Periodically checks payment gateway connectivity
- Logs health status changes
- Provides health check endpoint results via the `healthCheck()` function

## Local Build

Copy the `demo.proto` file to this directory and run `npm ci`

## Docker Build

From the root directory, run:

```sh
docker compose build payment
```

## Testing Retry Logic

To test the retry functionality:

1. **Enable failure simulation**:
   ```bash
   export PAYMENT_SIMULATE_FAILURES=true
   export PAYMENT_FAILURE_RATE=0.5  # 50% failure rate
   ```

2. **Configure retry parameters**:
   ```bash
   export PAYMENT_RETRY_MAX_ATTEMPTS=5
   export PAYMENT_RETRY_BASE_DELAY_MS=200
   export PAYMENT_RETRY_MAX_DELAY_MS=10000
   ```

3. **Monitor retry behavior**:
   - Check logs for retry attempts and delays
   - View OpenTelemetry traces to see retry spans
   - Monitor retry metrics in your observability platform

## Implementation Details

### Architecture
- **RetryPolicy**: Core retry logic with configurable parameters
- **PaymentGateway**: Simulated external payment API with retry integration
- **RetryableError**: Custom error type for retry decision making

### Error Handling
- Graceful fallback to local transaction ID generation
- Comprehensive error logging and telemetry
- Preservation of original error context through retry attempts

### Performance Considerations
- Jitter prevents thundering herd problems
- Maximum delay caps prevent excessive wait times
- Health monitoring enables proactive issue detection
- Metrics enable performance monitoring and alerting