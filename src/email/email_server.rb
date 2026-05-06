# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

require "ostruct"
require "pony"
require "sinatra"
require "open_feature/sdk"
require "openfeature/flagd/provider"

require "opentelemetry/sdk"
require "opentelemetry-logs-sdk"
require "opentelemetry-metrics-sdk"
require "opentelemetry/exporter/otlp"
require "opentelemetry-exporter-otlp-logs"
require "opentelemetry-exporter-otlp-metrics"
require "opentelemetry/instrumentation/sinatra"

set :port, ENV["EMAIL_PORT"]

# ---------------------------------------------------------------------------
# SMTP connection pool configuration
#
# SMTP_POOL_SIZE controls how many persistent SMTP connections are kept open
# in the connection pool.  A higher value increases throughput under load at
# the cost of more open connections to the SMTP server.
#
# Default: 5
# ---------------------------------------------------------------------------
SMTP_POOL_SIZE = ENV.fetch("SMTP_POOL_SIZE", "5").to_i
raise ArgumentError, "SMTP_POOL_SIZE must be a positive integer" unless SMTP_POOL_SIZE > 0

# Build the Pony SMTP options hash used for every outgoing message.
# When no SMTP_HOST is configured the service falls back to :test transport
# (useful in development / the default demo setup where no real SMTP relay
# is available).  The pool size is recorded in the options regardless of
# transport so it is always visible in logs and spans.
SMTP_HOST = ENV.fetch("SMTP_HOST", "")
SMTP_PORT = ENV.fetch("SMTP_PORT", "25").to_i
SMTP_USER = ENV.fetch("SMTP_USER", "")
SMTP_PASSWORD = ENV.fetch("SMTP_PASSWORD", "")
SMTP_DOMAIN = ENV.fetch("SMTP_DOMAIN", "example.com")
SMTP_AUTH = ENV.fetch("SMTP_AUTH", "plain")           # plain | login | cram_md5
SMTP_ENABLE_TLS = ENV.fetch("SMTP_ENABLE_TLS", "false") == "true"

if SMTP_HOST.empty?
  # No relay configured – use the in-process test transport so that the demo
  # works out-of-the-box without an external SMTP server.
  PONY_VIA_OPTIONS = {
    via: :test
  }.freeze
else
  smtp_options = {
    address:              SMTP_HOST,
    port:                 SMTP_PORT,
    domain:               SMTP_DOMAIN,
    pool:                 SMTP_POOL_SIZE,
    enable_starttls_auto: SMTP_ENABLE_TLS,
  }
  smtp_options[:user_name]      = SMTP_USER     unless SMTP_USER.empty?
  smtp_options[:password]       = SMTP_PASSWORD unless SMTP_PASSWORD.empty?
  smtp_options[:authentication] = SMTP_AUTH     unless SMTP_USER.empty?

  PONY_VIA_OPTIONS = {
    via:         :smtp,
    via_options: smtp_options,
  }.freeze
end

# Initialize OpenFeature SDK with flagd provider
flagd_client = OpenFeature::Flagd::Provider.build_client
flagd_client.configure do |config|
  config.host = ENV.fetch("FLAGD_HOST", "localhost")
  config.port = ENV.fetch("FLAGD_PORT", 8013).to_i
  config.tls = ENV.fetch("FLAGD_TLS", "false") == "true"
end

OpenFeature::SDK.configure do |config|
  config.set_provider(flagd_client)
end

OpenTelemetry::SDK.configure do |c|
  c.use "OpenTelemetry::Instrumentation::Sinatra"
end

$logger = OpenTelemetry.logger_provider.logger(name: 'email')

otlp_metric_exporter = OpenTelemetry::Exporter::OTLP::Metrics::MetricsExporter.new
OpenTelemetry.meter_provider.add_metric_reader(otlp_metric_exporter)
meter = OpenTelemetry.meter_provider.meter("email")
$confirmation_counter = meter.create_counter("app.confirmation.counter", unit: "1", description: "Counts the number of order confirmation emails sent")

# Log the effective connection pool configuration at startup so operators can
# confirm the value that was picked up from the environment.
puts "Email service starting – SMTP transport: #{PONY_VIA_OPTIONS[:via]}, " \
     "SMTP_POOL_SIZE: #{SMTP_POOL_SIZE}"

post "/send_order_confirmation" do
  data = JSON.parse(request.body.read, object_class: OpenStruct)

  # get the current auto-instrumented span
  current_span = OpenTelemetry::Trace.current_span
  current_span.add_attributes({
    "app.order.id" => data.order.order_id,
  })

  $confirmation_counter.add(1)
  send_email(data)

end

error do
  OpenTelemetry::Trace.current_span.record_exception(env['sinatra.error'])
end

def send_email(data)
  # create and start a manual span
  tracer = OpenTelemetry.tracer_provider.tracer('email')
  tracer.in_span("send_email") do |span|
    # Check if memory leak flag is enabled
    client = OpenFeature::SDK.build_client
    memory_leak_multiplier = client.fetch_number_value(flag_key: "emailMemoryLeak", default_value: 0)

    # To speed up the memory leak we create a long email body
    confirmation_content = erb(:confirmation, locals: { order: data.order })
    whitespace_length = [0, confirmation_content.length * (memory_leak_multiplier-1)].max

    Pony.mail(
      to:      data.email,
      from:    "noreply@example.com",
      subject: "Your confirmation email",
      body:    confirmation_content + " " * whitespace_length,
      **PONY_VIA_OPTIONS
    )

    # If not clearing the deliveries, the emails will accumulate in the test mailer
    # We use this to create a memory leak.
    if memory_leak_multiplier < 1
      Mail::TestMailer.deliveries.clear
    end

    span.set_attribute("app.order.id", data.order.order_id)
    span.set_attribute("smtp.pool_size", SMTP_POOL_SIZE)
    $logger.on_emit(
      timestamp: Time.now,
      severity_text: 'INFO',
      body: 'Order confirmation email sent',
      attributes: {
        'app.order.id'    => data.order.order_id,
        'smtp.pool_size'  => SMTP_POOL_SIZE,
      },
    )

    puts "Order confirmation email sent for order #{data.order.order_id}"
  end
  # manually created spans need to be ended
  # in Ruby, the method `in_span` ends it automatically
  # check out the OpenTelemetry Ruby docs at: 
  # https://opentelemetry.io/docs/instrumentation/ruby/manual/#creating-new-spans 
end
