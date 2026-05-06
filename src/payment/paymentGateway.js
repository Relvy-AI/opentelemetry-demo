// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

const { trace, SpanStatusCode } = require('@opentelemetry/api');
const { RetryPolicy, RetryConfig, RetryableError } = require('./retry');
const logger = require('./logger');

const tracer = trace.getTracer('payment-gateway');

class PaymentGateway {
  constructor(retryConfig = RetryConfig.fromEnvironment()) {
    this.retryPolicy = new RetryPolicy(retryConfig);
    this.baseUrl = process.env.PAYMENT_GATEWAY_URL || 'https://api.example-payment-provider.com';
    this.apiKey = process.env.PAYMENT_GATEWAY_API_KEY || 'demo-key';
    this.timeout = parseInt(process.env.PAYMENT_GATEWAY_TIMEOUT_MS || '5000');
    
    // Simulation settings for demo purposes
    this.simulateFailures = process.env.PAYMENT_SIMULATE_FAILURES === 'true';
    this.failureRate = parseFloat(process.env.PAYMENT_FAILURE_RATE || '0.2'); // 20% failure rate
  }

  async processPayment(paymentRequest) {
    const span = tracer.startSpan('payment_gateway.process_payment');
    
    try {
      span.setAttributes({
        'payment.gateway.url': this.baseUrl,
        'payment.amount.units': paymentRequest.amount.units,
        'payment.amount.nanos': paymentRequest.amount.nanos,
        'payment.currency': paymentRequest.amount.currencyCode,
        'payment.card_type': this.getCardType(paymentRequest.creditCard.creditCardNumber)
      });

      const result = await this.retryPolicy.executeWithRetry(
        () => this._makePaymentApiCall(paymentRequest),
        'payment_gateway_api_call',
        span
      );

      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: `Payment gateway error: ${error.message}`
      });
      throw error;
    } finally {
      span.end();
    }
  }

  async _makePaymentApiCall(paymentRequest) {
    // This simulates an external payment API call
    // In a real implementation, this would make HTTP requests to actual payment providers
    
    const operationSpan = tracer.startSpan('payment_gateway.api_call');
    
    try {
      operationSpan.setAttributes({
        'http.url': `${this.baseUrl}/payments`,
        'http.method': 'POST'
      });

      // Simulate network delay
      await this._simulateNetworkDelay();

      // Simulate potential failures for demo purposes
      if (this.simulateFailures && Math.random() < this.failureRate) {
        const errorType = this._getRandomErrorType();
        throw errorType;
      }

      // Simulate successful payment processing
      const transactionId = this._generateTransactionId();
      const processingTime = Math.floor(Math.random() * 1000) + 100; // 100-1100ms
      
      await new Promise(resolve => setTimeout(resolve, processingTime));

      operationSpan.setAttributes({
        'payment.transaction_id': transactionId,
        'payment.processing_time_ms': processingTime,
        'http.status_code': 200
      });

      logger.info({
        transactionId,
        processingTime,
        amount: paymentRequest.amount
      }, 'Payment processed successfully');

      return {
        success: true,
        transactionId,
        processingTime,
        gatewayResponse: {
          status: 'approved',
          authCode: this._generateAuthCode(),
          timestamp: new Date().toISOString()
        }
      };
    } catch (error) {
      operationSpan.recordException(error);
      operationSpan.setAttributes({
        'http.status_code': error.status || error.statusCode || 0,
        'error.type': error.constructor.name
      });
      throw error;
    } finally {
      operationSpan.end();
    }
  }

  async _simulateNetworkDelay() {
    // Simulate variable network latency (50-200ms)
    const delay = Math.floor(Math.random() * 150) + 50;
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  _getRandomErrorType() {
    const errorTypes = [
      // Network errors (retryable)
      new RetryableError('Network timeout', new Error('ETIMEDOUT'), true),
      new RetryableError('Connection reset', new Error('ECONNRESET'), true),
      new RetryableError('Service unavailable', { status: 503 }, true),
      new RetryableError('Gateway timeout', { status: 504 }, true),
      new RetryableError('Too many requests', { status: 429 }, true),
      
      // Business logic errors (non-retryable)
      new RetryableError('Invalid card number', new Error('Invalid card'), false),
      new RetryableError('Insufficient funds', new Error('Declined'), false),
      new RetryableError('Card expired', new Error('Expired'), false)
    ];

    return errorTypes[Math.floor(Math.random() * errorTypes.length)];
  }

  _generateTransactionId() {
    return `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  _generateAuthCode() {
    return Math.random().toString(36).substr(2, 8).toUpperCase();
  }

  getCardType(cardNumber) {
    const firstDigit = cardNumber.charAt(0);
    if (firstDigit === '4') return 'visa';
    if (firstDigit === '5') return 'mastercard';
    if (firstDigit === '3') return 'amex';
    return 'unknown';
  }

  // Health check method for payment gateway connectivity
  async healthCheck() {
    const span = tracer.startSpan('payment_gateway.health_check');
    
    try {
      // Simulate a lightweight health check call
      await this._simulateNetworkDelay();
      
      if (this.simulateFailures && Math.random() < 0.1) { // 10% health check failure rate
        throw new RetryableError('Health check failed', { status: 503 }, true);
      }

      span.setAttributes({
        'health_check.status': 'healthy',
        'http.status_code': 200
      });

      return { status: 'healthy', timestamp: new Date().toISOString() };
    } catch (error) {
      span.recordException(error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: `Health check failed: ${error.message}`
      });
      throw error;
    } finally {
      span.end();
    }
  }
}

module.exports = { PaymentGateway };