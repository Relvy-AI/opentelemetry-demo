# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

require "ostruct"
require "pony"
require "sinatra"
require "open_feature/sdk"
require "openfeature/flagd/provider"
require "net/smtp"
require "monitor"
require "thread"

require "opentelemetry/sdk"
require "opentelemetry-logs-sdk"
require "opentelemetry-metrics-sdk"
require "opentelemetry/exporter/otlp"
require "opentelemetry-exporter-otlp-logs"
require "opentelemetry-exporter-otlp-metrics"
require "opentelemetry/instrumentation/sinatra"

set :port, ENV["EMAIL_PORT"]

# ---------------------------------------------------------------------------
# SMTP Connection Pool configuration
# ---------------------------------------------------------------------------
# SMTP_POOL_SIZE  – maximum number of persistent SMTP connections kept open
#                   (default: 5). Each Puma worker thread checks out a
#                   connection from the pool, uses it, then returns it. If
#                   all connections are busy the caller blocks until one
#                   becomes available.
# SMTP_HOST       – SMTP server hostname (default: "localhost")
# SMTP_PORT       – SMTP server port    (default: 25)
# ---------------------------------------------------------------------------
SMTP_POOL_SIZE = ENV.fetch("SMTP_POOL_SIZE", "5").to_i.then { |n| n > 0 ? n : 5 }
SMTP_HOST      = ENV.fetch("SMTP_HOST", "localhost")
SMTP_PORT      = ENV.fetch("SMTP_PORT", "25").to_i

# ---------------------------------------------------------------------------
# SmtpConnectionPool
# A lightweight, thread-safe pool of Net::SMTP connections.
# ---------------------------------------------------------------------------
class SmtpConnectionPool
  # Raised when a checked-out connection cannot be re-established.
  class ConnectionError < StandardError; end

  def initialize(host:, port:, pool_size:)
    @host      = host
    @port      = port
    @pool_size = pool_size
    @monitor   = Monitor.new
    @available = @monitor.new_cond   # signalled whenever a slot is returned
    @pool      = []                  # idle connections
    @checked   = 0                   # number of connections currently in use

    # Pre-create all connections eagerly so the pool size is deterministic
    # from the very first request.
    @pool_size.times { @pool << _new_connection }
  end

  # Returns the configured maximum pool size.
  attr_reader :pool_size

  # Returns the number of connections currently checked out by callers.
  def checked_out
    @monitor.synchronize { @checked }
  end

  # Returns the number of idle (available) connections in the pool.
  def idle
    @monitor.synchronize { @pool.size }
  end

  # Yields a Net::SMTP connection to the block, then returns it to the pool.
  # If no connection is available the caller blocks until one is released.
  def with_connection
    conn = checkout
    begin
      yield conn
    rescue => e
      # Discard the broken connection and replace it with a fresh one so
      # pool capacity is always maintained.
      conn = nil
      @monitor.synchronize do
        @checked -= 1
        begin
          @pool << _new_connection
        rescue => inner
          # We could not re-establish – signal waiters and re-raise
          @available.signal
          raise ConnectionError, "Failed to replace broken SMTP connection: #{inner.message}"
        end
        @available.signal
      end
      raise e
    ensure
      checkin(conn) unless conn.nil?
    end
  end

  private

  def checkout
    @monitor.synchronize do
      @available.wait_while { @pool.empty? }
      conn = @pool.pop
      @checked += 1
      conn
    end
  end

  def checkin(conn)
    @monitor.synchronize do
      @pool.push(conn)
      @checked -= 1
      @available.signal
    end
  end

  def _new_connection
    smtp = Net::SMTP.new(@host, @port)
    # Using :test via Pony means we never actually connect to a real SMTP
    # server in development/test mode; the pool object is still created so
    # the configuration, metrics and span attributes are fully exercised.
    # In production (SMTP_HOST points to a real relay) start the session.
    smtp
  end
end

# Create the global pool – shared by all Puma threads.
$smtp_pool = SmtpConnectionPool.new(
  host:      SMTP_HOST,
  port:      SMTP_PORT,
  pool_size: SMTP_POOL_SIZE,
)

# ---------------------------------------------------------------------------
# Initialize OpenFeature SDK with flagd provider
# ---------------------------------------------------------------------------
flagd_client = OpenFeature::Flagd::Provider.build_client
flagd_client.configure do |config|
  config.host = ENV.fetch("FLAGD_HOST", "localhost")
  config.port = ENV.fetch("FLAGD_PORT", 8013).to_i
  config.tls  = ENV.fetch("FLAGD_TLS", "false") == "true"
end

OpenFeature::SDK.configure do |config|
  config.set_provider(flagd_client)
end

# ---------------------------------------------------------------------------
# OpenTelemetry SDK
# ---------------------------------------------------------------------------
OpenTelemetry::SDK.configure do |c|
  c.use "OpenTelemetry::Instrumentation::Sinatra"
end

$logger = OpenTelemetry.logger_provider.logger(name: "email")

otlp_metric_exporter = OpenTelemetry::Exporter::OTLP::Metrics::MetricsExporter.new
OpenTelemetry.meter_provider.add_metric_reader(otlp_metric_exporter)

meter = OpenTelemetry.meter_provider.meter("email")

$confirmation_counter = meter.create_counter(
  "app.confirmation.counter",
  unit:        "1",
  description: "Counts the number of order confirmation emails sent",
)

# Gauge that tracks how many connections are currently checked out of the pool.
$smtp_pool_checked_out_gauge = meter.create_observable_gauge(
  "app.smtp.pool.checked_out",
  unit:        "connections",
  description: "Number of SMTP connections currently checked out of the pool",
) { [{ value: $smtp_pool.checked_out }] }

# Gauge that reflects the configured maximum pool size (useful for dashboards
# so operators can see the setting without inspecting service configuration).
$smtp_pool_size_gauge = meter.create_observable_gauge(
  "app.smtp.pool.size",
  unit:        "connections",
  description: "Configured maximum size of the SMTP connection pool",
) { [{ value: $smtp_pool.pool_size }] }

puts "SMTP connection pool initialised: pool_size=#{SMTP_POOL_SIZE}, " \
     "smtp_host=#{SMTP_HOST}, smtp_port=#{SMTP_PORT}"

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
post "/send_order_confirmation" do
  data = JSON.parse(request.body.read, object_class: OpenStruct)

  # get the current auto-instrumented span
  current_span = OpenTelemetry::Trace.current_span
  current_span.add_attributes({
    "app.order.id"           => data.order.order_id,
    "smtp.pool.size"         => SMTP_POOL_SIZE,
    "smtp.pool.checked_out"  => $smtp_pool.checked_out,
  })

  $confirmation_counter.add(1)
  send_email(data)
end

error do
  OpenTelemetry::Trace.current_span.record_exception(env["sinatra.error"])
end

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def send_email(data)
  # create and start a manual span
  tracer = OpenTelemetry.tracer_provider.tracer("email")
  tracer.in_span("send_email") do |span|
    # Annotate the span with connection-pool metadata so it is visible in
    # distributed traces without needing to open a separate metrics query.
    span.set_attribute("smtp.pool.size",        SMTP_POOL_SIZE)
    span.set_attribute("smtp.pool.checked_out", $smtp_pool.checked_out)
    span.set_attribute("smtp.host",             SMTP_HOST)
    span.set_attribute("smtp.port",             SMTP_PORT)

    # Check if memory leak flag is enabled
    client = OpenFeature::SDK.build_client
    memory_leak_multiplier = client.fetch_number_value(flag_key: "emailMemoryLeak", default_value: 0)

    # To speed up the memory leak we create a long email body
    confirmation_content = erb(:confirmation, locals: { order: data.order })
    whitespace_length = [0, confirmation_content.length * (memory_leak_multiplier - 1)].max

    # Use a pooled connection slot for the duration of the send operation.
    # In :test (via) mode Pony does not open a real TCP socket, so the pool
    # tracks logical slots rather than live TCP connections – this keeps the
    # behaviour identical in all environments while still enforcing the
    # concurrency limit expressed by SMTP_POOL_SIZE.
    $smtp_pool.with_connection do |_smtp_conn|
      Pony.mail(
        to:      data.email,
        from:    "noreply@example.com",
        subject: "Your confirmation email",
        body:    confirmation_content + " " * whitespace_length,
        via:     :test,
      )
    end

    # Update the span with the checked-out count *after* the send so it
    # reflects how many connections were concurrently in use during the call.
    span.set_attribute("smtp.pool.checked_out_post_send", $smtp_pool.checked_out)

    # If not clearing the deliveries, the emails will accumulate in the test mailer.
    # We use this to create a memory leak.
    if memory_leak_multiplier < 1
      Mail::TestMailer.deliveries.clear
    end

    span.set_attribute("app.order.id", data.order.order_id)
    $logger.on_emit(
      timestamp:     Time.now,
      severity_text: "INFO",
      body:          "Order confirmation email sent",
      attributes:    {
        "app.order.id"   => data.order.order_id,
        "smtp.pool.size" => SMTP_POOL_SIZE,
      },
    )

    puts "Order confirmation email sent for order #{data.order.order_id} " \
         "(smtp.pool.size=#{SMTP_POOL_SIZE}, smtp.pool.checked_out=#{$smtp_pool.checked_out})"
  end
  # manually created spans need to be ended
  # in Ruby, the method `in_span` ends it automatically
  # check out the OpenTelemetry Ruby docs at:
  # https://opentelemetry.io/docs/instrumentation/ruby/manual/#creating-new-spans
end
