// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

const { SpanStatusCode } = require('@opentelemetry/api');
const logger = require('./logger');

class RetryConfig {
  constructor({
    maxRetries = 3,
    baseDelayMs = 100,
    maxDelayMs = 5000,
    backoffMultiplier = 2,
    jitterEnabled = true
  } = {}) {
    this.maxRetries = maxRetries;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.backoffMultiplier = backoffMultiplier;
    this.jitterEnabled = jitterEnabled;
  }

  static fromEnvironment() {
    return new RetryConfig({
      maxRetries: parseInt(process.env.PAYMENT_RETRY_MAX_ATTEMPTS || '3'),
      baseDelayMs: parseInt(process.env.PAYMENT_RETRY_BASE_DELAY_MS || '100'),
      maxDelayMs: parseInt(process.env.PAYMENT_RETRY_MAX_DELAY_MS || '5000'),
      backoffMultiplier: parseFloat(process.env.PAYMENT_RETRY_BACKOFF_MULTIPLIER || '2'),
      jitterEnabled: process.env.PAYMENT_RETRY_JITTER_ENABLED !== 'false'
    });
  }
}

class RetryableError extends Error {
  constructor(message, originalError, shouldRetry = true) {
    super(message);
    this.name = 'RetryableError';
    this.originalError = originalError;
    this.shouldRetry = shouldRetry;
  }
}

class RetryPolicy {
  constructor(config = new RetryConfig()) {
    this.config = config;
  }

  calculateDelay(attemptNumber) {
    let delay = this.config.baseDelayMs * Math.pow(this.config.backoffMultiplier, attemptNumber);
    delay = Math.min(delay, this.config.maxDelayMs);

    if (this.config.jitterEnabled) {
      // Add jitter (randomization) to prevent thundering herd
      delay = delay * (0.5 + Math.random() * 0.5);
    }

    return Math.floor(delay);
  }

  isRetryableError(error) {
    // Determine if an error should trigger a retry
    if (error instanceof RetryableError) {
      return error.shouldRetry;
    }

    // Common retryable conditions for payment APIs
    if (error.code) {
      const retryableCodes = [
        'ECONNRESET',
        'ECONNREFUSED',
        'ETIMEDOUT',
        'ENOTFOUND',
        'EAI_AGAIN'
      ];
      return retryableCodes.includes(error.code);
    }

    // HTTP status codes that should be retried
    if (error.status || error.statusCode) {
      const status = error.status || error.statusCode;
      const retryableStatuses = [429, 500, 502, 503, 504];
      return retryableStatuses.includes(status);
    }

    // Default: don't retry unknown errors
    return false;
  }

  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async executeWithRetry(operation, operationName = 'operation', span = null) {
    let lastError;
    let attempt = 0;

    while (attempt <= this.config.maxRetries) {
      try {
        const result = await operation();
        
        if (attempt > 0) {
          logger.info({
            operation: operationName,
            attempt: attempt + 1,
            totalAttempts: this.config.maxRetries + 1
          }, 'Operation succeeded after retry');

          span?.setAttributes({
            'app.payment.retry.success_attempt': attempt + 1,
            'app.payment.retry.total_attempts': attempt + 1
          });
        }

        return result;
      } catch (error) {
        lastError = error;
        attempt++;

        const shouldRetry = this.isRetryableError(error) && attempt <= this.config.maxRetries;

        logger.warn({
          operation: operationName,
          attempt,
          maxRetries: this.config.maxRetries,
          error: error.message,
          errorCode: error.code,
          errorStatus: error.status || error.statusCode,
          willRetry: shouldRetry
        }, 'Operation failed');

        span?.setAttributes({
          [`app.payment.retry.attempt_${attempt}.error`]: error.message,
          [`app.payment.retry.attempt_${attempt}.error_code`]: error.code || 'unknown',
          'app.payment.retry.total_attempts': attempt
        });

        if (!shouldRetry) {
          break;
        }

        if (attempt <= this.config.maxRetries) {
          const delay = this.calculateDelay(attempt - 1);
          
          logger.info({
            operation: operationName,
            attempt,
            delayMs: delay
          }, 'Retrying operation after delay');

          span?.setAttributes({
            [`app.payment.retry.attempt_${attempt}.delay_ms`]: delay
          });

          await this.sleep(delay);
        }
      }
    }

    // All retries exhausted
    logger.error({
      operation: operationName,
      totalAttempts: attempt,
      finalError: lastError.message
    }, 'Operation failed after all retries exhausted');

    span?.setAttributes({
      'app.payment.retry.exhausted': true,
      'app.payment.retry.total_attempts': attempt,
      'app.payment.retry.final_error': lastError.message
    });

    span?.setStatus({
      code: SpanStatusCode.ERROR,
      message: `${operationName} failed after ${attempt} attempts: ${lastError.message}`
    });

    throw lastError;
  }
}

module.exports = {
  RetryConfig,
  RetryPolicy,
  RetryableError
};