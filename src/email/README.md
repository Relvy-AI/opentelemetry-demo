# Email Service

The Email service "sends" an email to the customer with their order details by
rendering it as a log message. It expects a JSON payload like:

```json
{
  "email": "some.address@website.com",
  "order": "<serialized order protobuf>"
}
```

## Configuration

The service is configured entirely through environment variables.

| Variable          | Default       | Description                                                                                          |
|-------------------|---------------|------------------------------------------------------------------------------------------------------|
| `EMAIL_PORT`      | *(required)*  | TCP port the HTTP server listens on.                                                                 |
| `SMTP_POOL_SIZE`  | `5`           | Maximum number of SMTP connections kept open in the connection pool. Must be a positive integer.     |
| `SMTP_HOST`       | `localhost`   | Hostname of the SMTP relay. In test/development mode this is unused (Pony's `:test` transport is active). |
| `SMTP_PORT`       | `25`          | Port of the SMTP relay.                                                                              |
| `FLAGD_HOST`      | `localhost`   | Hostname of the flagd feature-flag server.                                                          |
| `FLAGD_PORT`      | `8013`        | Port of the flagd feature-flag server.                                                              |
| `FLAGD_TLS`       | `false`       | Set to `"true"` to enable TLS for the flagd connection.                                             |

### SMTP Connection Pool

On startup the service creates a fixed-size pool (`SMTP_POOL_SIZE`) of
`Net::SMTP` connection objects.  When an order-confirmation email is sent the
handler checks out a connection from the pool, uses it, and immediately returns
it so that the next concurrent request can reuse it.  If all connections are
busy the request blocks until one is released.

The pool is instrumented with two OpenTelemetry gauges exported via OTLP:

| Metric                         | Unit          | Description                                                       |
|--------------------------------|---------------|-------------------------------------------------------------------|
| `app.smtp.pool.size`           | `connections` | Configured maximum size of the SMTP connection pool.             |
| `app.smtp.pool.checked_out`    | `connections` | Number of connections currently checked out (in use).            |

Each `send_email` span is annotated with the following attributes:

- `smtp.pool.size` – configured pool size
- `smtp.pool.checked_out` – connections in use when the request arrived
- `smtp.pool.checked_out_post_send` – connections in use after the send returned
- `smtp.host` / `smtp.port` – SMTP relay coordinates

## Local Build

We use `bundler` to manage dependencies. To get started, simply `bundle install`.

## Running locally

```sh
export EMAIL_PORT=8080
export SMTP_POOL_SIZE=3   # optional, defaults to 5
bundle exec ruby email_server.rb
```

## Docker Build

From `src/email`, run `docker build .`
