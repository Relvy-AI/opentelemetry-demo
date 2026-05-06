// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
const { context, propagation, trace, metrics, SpanStatusCode } = require('@opentelemetry/api');
const cardValidator = require('simple-card-validator');
const { v4: uuidv4 } = require('uuid');

const { OpenFeature } = require('@openfeature/server-sdk');
const { FlagdProvider } = require('@openfeature/flagd-provider');
const flagProvider = new FlagdProvider();

const logger = require('./logger');
const { PaymentGateway } = require('./paymentGateway');

const tracer = trace.getTracer('payment');
const meter = metrics.getMeter('payment');
const transactionsCounter = meter.createCounter('app.payment.transactions');
const retriesCounter = meter.createCounter('app.payment.retries');
const gatewayLatencyHistogram = meter.createHistogram('app.payment.gateway_latency', {
  description: 'Payment gateway response time',
  unit: 'ms'
});

const LOYALTY_LEVEL = ['platinum', 'gold', 'silver', 'bronze'];

// Initialize payment gateway with retry configuration
const paymentGateway = new PaymentGateway();

/** Return random element from given array */
function random(arr) {
  const index = Math.floor(Math.random() * arr.length);
  return arr[index];
}

module.exports.charge = async request => {
  const span = tracer.startSpan('charge');
  const startTime = Date.now();

  try {
    await OpenFeature.setProviderAndWait(flagProvider);

    // Check for feature flag to enable payment failures
    const numberVariant = await OpenFeature.getClient().getNumberValue("paymentFailure", 0);

    if (numberVariant > 0) {
      // n% chance to fail with app.loyalty.level=gold
      if (Math.random() < numberVariant) {
        span.setAttributes({'app.loyalty.level': 'gold' });
        throw new Error('Payment request failed. Invalid token. app.loyalty.level=gold');
      }
    }

    const {
      creditCardNumber: number,
      creditCardExpirationYear: year,
      creditCardExpirationMonth: month
    } = request.creditCard;
    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();
    const lastFourDigits = number.substr(-4);

    // Validate card information
    const card = cardValidator(number);
    const { card_type: cardType, valid } = card.getCardDetails();
    const loyalty_level = random(LOYALTY_LEVEL);

    span.setAttributes({
      'app.payment.card_type': cardType,
      'app.payment.card_valid': valid,
      'app.loyalty.level': loyalty_level,
      'app.payment.retry.enabled': true
    });

    // Basic validation checks
    if (!valid) {
      throw new Error('Credit card info is invalid.');
    }

    if (!['visa', 'mastercard'].includes(cardType)) {
      throw new Error(`Sorry, we cannot process ${cardType} credit cards. Only VISA or MasterCard is accepted.`);
    }

    if ((currentYear * 12 + currentMonth) > (year * 12 + month)) {
      throw new Error(`The credit card (ending ${lastFourDigits}) expired on ${month}/${year}.`);
    }

    // Check if this is a synthetic request (for load testing)
    const baggage = propagation.getBaggage(context.active());
    const isSyntheticRequest = baggage && 
      baggage.getEntry('synthetic_request') && 
      baggage.getEntry('synthetic_request').value === 'true';

    // Process payment through gateway with retry logic
    let gatewayResult;
    let transactionId;
    
    try {
      const gatewayStartTime = Date.now();
      gatewayResult = await paymentGateway.processPayment(request);
      const gatewayDuration = Date.now() - gatewayStartTime;
      
      // Record metrics
      gatewayLatencyHistogram.record(gatewayDuration, {
        'payment.gateway.status': 'success',
        'payment.card_type': cardType
      });
      
      transactionId = gatewayResult.transactionId;
      
      span.setAttributes({
        'app.payment.gateway.transaction_id': transactionId,
        'app.payment.gateway.processing_time_ms': gatewayResult.processingTime,
        'app.payment.gateway.success': true,
        'app.payment.gateway.auth_code': gatewayResult.gatewayResponse.authCode
      });

      logger.info({
        transactionId,
        gatewayTransactionId: gatewayResult.transactionId,
        cardType,
        lastFourDigits,
        amount: request.amount,
        loyalty_level,
        processingTime: gatewayResult.processingTime
      }, 'Payment processed successfully through gateway');

    } catch (gatewayError) {
      // Record retry metrics if retries were attempted
      if (gatewayError.message.includes('after') && gatewayError.message.includes('attempts')) {
        retriesCounter.add(1, {
          'payment.card_type': cardType,
          'payment.failure_reason': 'gateway_error'
        });
      }

      gatewayLatencyHistogram.record(Date.now() - startTime, {
        'payment.gateway.status': 'error',
        'payment.card_type': cardType
      });

      // Fall back to generating a local transaction ID for demo purposes
      transactionId = uuidv4();
      
      span.setAttributes({
        'app.payment.gateway.success': false,
        'app.payment.gateway.error': gatewayError.message,
        'app.payment.fallback.used': true,
        'app.payment.fallback.transaction_id': transactionId
      });

      logger.warn({
        transactionId,
        cardType,
        lastFourDigits,
        gatewayError: gatewayError.message,
        fallback: true
      }, 'Payment gateway failed, using fallback processing');

      // For demo purposes, we'll continue with local processing
      // In a real implementation, you might want to fail the payment here
    }

    // Set charge status based on synthetic request flag
    if (isSyntheticRequest) {
      span.setAttribute('app.payment.charged', false);
    } else {
      span.setAttribute('app.payment.charged', true);
    }

    // Record transaction metrics
    const { units, nanos, currencyCode } = request.amount;
    const totalProcessingTime = Date.now() - startTime;
    
    transactionsCounter.add(1, { 
      'app.payment.currency': currencyCode,
      'app.payment.card_type': cardType,
      'app.payment.loyalty_level': loyalty_level
    });

    span.setAttributes({
      'app.payment.total_processing_time_ms': totalProcessingTime
    });

    logger.info({ 
      transactionId, 
      cardType, 
      lastFourDigits, 
      amount: { units, nanos, currencyCode }, 
      loyalty_level,
      totalProcessingTime
    }, 'Transaction completed successfully');

    return { transactionId };

  } catch (err) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    
    // Record failure metrics
    retriesCounter.add(1, {
      'payment.failure_reason': 'validation_error'
    });

    throw err;
  } finally {
    span.end();
  }
};

// Health check function for the payment service
module.exports.healthCheck = async () => {
  try {
    const gatewayHealth = await paymentGateway.healthCheck();
    return {
      status: 'healthy',
      gateway: gatewayHealth,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error({ error: error.message }, 'Payment service health check failed');
    return {
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
};