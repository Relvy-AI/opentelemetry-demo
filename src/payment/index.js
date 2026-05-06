// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')
const health = require('grpc-js-health-check')
const opentelemetry = require('@opentelemetry/api')

const charge = require('./charge')
const logger = require('./logger')

async function chargeServiceHandler(call, callback) {
  const span = opentelemetry.trace.getActiveSpan();

  try {
    const amount = call.request.amount
    span?.setAttributes({
      'app.payment.amount': parseFloat(`${amount.units}.${amount.nanos}`).toFixed(2)
    })
    logger.info("Charge request received.")

    const response = await charge.charge(call.request)
    callback(null, response)

  } catch (err) {
    logger.warn({ err })

    span?.setStatus({ code: opentelemetry.SpanStatusCode.ERROR, message: err.message })
    callback(err)
  }
}

async function closeGracefully(signal) {
  server.forceShutdown()
  process.kill(process.pid, signal)
}

// Log retry configuration on startup
function logRetryConfiguration() {
  const retryConfig = {
    maxRetries: process.env.PAYMENT_RETRY_MAX_ATTEMPTS || '3',
    baseDelayMs: process.env.PAYMENT_RETRY_BASE_DELAY_MS || '100',
    maxDelayMs: process.env.PAYMENT_RETRY_MAX_DELAY_MS || '5000',
    backoffMultiplier: process.env.PAYMENT_RETRY_BACKOFF_MULTIPLIER || '2',
    jitterEnabled: process.env.PAYMENT_RETRY_JITTER_ENABLED !== 'false',
    simulateFailures: process.env.PAYMENT_SIMULATE_FAILURES === 'true',
    failureRate: process.env.PAYMENT_FAILURE_RATE || '0.2'
  };
  
  logger.info({ retryConfig }, 'Payment service retry configuration loaded');
}

// Perform health check periodically
async function startHealthMonitoring() {
  const healthCheckInterval = parseInt(process.env.PAYMENT_HEALTH_CHECK_INTERVAL_MS || '30000'); // 30 seconds
  
  setInterval(async () => {
    try {
      const healthStatus = await charge.healthCheck();
      if (healthStatus.status === 'unhealthy') {
        logger.warn({ healthStatus }, 'Payment service health check failed');
      } else {
        logger.debug({ healthStatus }, 'Payment service health check passed');
      }
    } catch (error) {
      logger.error({ error: error.message }, 'Health check monitoring error');
    }
  }, healthCheckInterval);
}

const otelDemoPackage = grpc.loadPackageDefinition(protoLoader.loadSync('demo.proto'))
const server = new grpc.Server()

server.addService(health.service, new health.Implementation({
  '': health.servingStatus.SERVING
}))

server.addService(otelDemoPackage.oteldemo.PaymentService.service, { charge: chargeServiceHandler })

let ip = "0.0.0.0";

const ipv6_enabled = process.env.IPV6_ENABLED;

if (ipv6_enabled == "true") {
  ip = "[::]";
  logger.info(`Overwriting Localhost IP: ${ip}`)
}

const address = ip + `:${process.env['PAYMENT_PORT']}`;

server.bindAsync(address, grpc.ServerCredentials.createInsecure(), (err, port) => {
  if (err) {
    return logger.error({ err })
  }

  logger.info(`payment gRPC server started on ${address}`)
  
  // Log configuration and start health monitoring after server starts
  logRetryConfiguration();
  startHealthMonitoring();
})

process.once('SIGINT', closeGracefully)
process.once('SIGTERM', closeGracefully)