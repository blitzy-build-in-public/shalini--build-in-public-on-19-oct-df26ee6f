# nodejs-tutorial-hello-world

## Purpose

A minimal, dependency-free Node.js HTTP server, written as a teaching reference: the entire application is one file, `server.js`, and it can be read from top to bottom in a few minutes. It answers a single endpoint — `GET /hello` returns `200 OK` with the plain-text body `Hello world` — and answers every other request with `404 Not Found`.

The server is built directly on the `http` module. There is no framework (Express, Fastify, Koa), no middleware library and no routing library, and `node:http` is the only module the program requires — because the absence of a framework is what this project is meant to show: how the server is created and bound, how a request is matched to a handler, how a status code, header and body are written, and how the process starts and stops cleanly.

| Method | Path | Status | Content-Type | Body |
|--------|------|--------|--------------|------|
| `GET` | `/hello` | `200` | `text/plain` | `Hello world` |
| Any other method or path | catch-all | `404` | `text/plain` | `Not Found` |

The method is part of the route key, so a request such as `POST /hello` does not match the `/hello` route and receives the 404 response.

## Prerequisites

Node.js 18.0.0 or newer, and nothing else. Check the installed version:

```bash
node --version
```

`package.json` declares the requirement in its `engines` field as `"node": ">=18.0.0"`. npm treats `engines` as advisory: it warns when the installed runtime does not satisfy the range, and refuses to run only when the `engine-strict` configuration option is enabled.

## Installation

None is required beyond Node.js. The project has no dependencies to install, `npm install` has nothing to fetch, and no lockfile or `node_modules` directory is shipped. Everything the server uses is either a built-in module (`node:http`) or a JavaScript global (`process`, `console`, `URL`, `Date`), so it runs from a fresh checkout.

## Running the server

From the repository root, start the server with either entry point:

```bash
node server.js
```

```bash
npm start
```

Both run the same program: `scripts.start` in `package.json` is `node server.js`. Once the port is bound, the server logs one line:

```console
$ node server.js
Server listening on port 3000
```

`npm start` prints npm's own banner before that line — a blank line, the `> nodejs-tutorial-hello-world@1.0.0 start` heading, the `> node server.js` command it runs, and another blank line — so the server's line is the fifth line of the output:

```console
$ npm start

> nodejs-tutorial-hello-world@1.0.0 start
> node server.js

Server listening on port 3000
```

The server listens on port `3000` by default and binds the unspecified address, so it answers on `localhost`, on `127.0.0.1` and on the machine's own address. To run it on another port, see [Configuration](#configuration).

## Verifying the server

With the server running, issue requests with `curl`. There is no test suite to run: the project installs no test framework, so every check is made directly against the running server. The port in the commands below is the default; substitute the port you configured if you changed it.

```bash
curl http://localhost:3000/hello
```

Prints `Hello world`, the response to a matched route.

```bash
curl -i http://localhost:3000/hello
```

Adds the response headers, which `-i` shows alongside the status line and body.

```bash
curl -i http://localhost:3000/invalid
```

Returns `404 Not Found` with the body `Not Found`, because no route matches `/invalid`.

```bash
curl -i -X POST http://localhost:3000/hello
```

Returns the same `404 Not Found` response — not `405` and not `200`, because the route key includes the method, so only `GET /hello` matches. `PUT`, `PATCH`, `DELETE`, `OPTIONS` and `HEAD` against `/hello` are answered the same way.

```bash
curl -i 'http://localhost:3000/hello?x=1'
```

Returns `200 OK` with `Hello world`. The query string is discarded before matching, so the path still matches the `/hello` route.

```bash
curl -i http://localhost:3000/hello/
```

Returns `404 Not Found`. The trailing slash makes this a different pathname than `/hello`, and routes are matched on the exact path.

```bash
curl -i http://localhost:3000/
```

Returns `404 Not Found`, as does any other method and path that is not `GET /hello`.

## Expected output

A request that matches `GET /hello`:

```console
$ curl -i http://localhost:3000/hello
HTTP/1.1 200 OK
Content-Type: text/plain
Date: Mon, 19 Oct 2026 06:12:03 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Content-Length: 11

Hello world
```

A request that matches nothing:

```console
$ curl -i http://localhost:3000/invalid
HTTP/1.1 404 Not Found
Content-Type: text/plain
Date: Mon, 19 Oct 2026 06:12:03 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Content-Length: 9

Not Found
```

The bodies are fixed: `Hello world` is 11 bytes and `Not Found` is 9, which is the `Content-Length` reported in each case. `Content-Type` is exactly `text/plain`, with no charset parameter — both bodies are plain ASCII, so none is needed. `Date`, `Connection` and `Keep-Alive` are added by Node.js; the `Date` value is the time of the response, not the fixed value shown here. No `Transfer-Encoding` header ever appears: the server sets the status and `Content-Type` and leaves the rest implicit, so Node.js generates `Content-Length` from the body and the response is always framed as a fixed length. A `HEAD` request receives the status line, `Content-Type`, `Date`, `Connection` and `Keep-Alive` with no body and no `Content-Length`, because Node.js suppresses both for a response to `HEAD`.

Every request is logged to the console before it is routed, so matched and unmatched requests alike produce one line — in the format `[ISO-8601 timestamp] [HTTP method] [request path]`:

```console
2026-10-19T06:12:03.123Z GET /hello
2026-10-19T06:12:04.456Z GET /invalid
2026-10-19T06:12:05.789Z POST /hello
```

The three fields are separated by single spaces: the UTC timestamp in ISO-8601 form, the HTTP method as received, and the request path. The path is the pathname alone, with the query string excluded because the pathname is what routing matches on, so the request for `/hello?x=1` is logged as `GET /hello`. A request target that cannot be parsed is logged with the raw target in place of the pathname, and is answered with the ordinary 404 response rather than an error page or a stack trace.

## Shutting down

Press CTRL+C in the terminal running the server. That sends `SIGINT`, and the server logs two lines before the process ends:

```console
^CReceived SIGINT, shutting down
Server closed
```

The shutdown stops accepting new connections and lets requests already in flight finish, after which the process exits with status code `0`. A second CTRL+C while the shutdown is in progress is ignored. Only `SIGINT` is handled — there is no `SIGTERM` handler, so a `SIGTERM` terminates the process without those two lines.

An idle keep-alive connection is closed as part of the shutdown so the exit is immediate. `server.closeIdleConnections()` exists from Node.js 18.2.0 only, so the server calls it behind a capability check: on Node.js 18.0.0 and 18.1.0 an idle connection can defer the exit by up to five seconds — the default `keepAliveTimeout` — after which Node.js destroys the socket.

To send the signal from another terminal or from a script instead of pressing CTRL+C:

```bash
kill -INT "$(lsof -ti :3000)"
```

## Configuration

One environment variable configures the server:

| Variable | Default | Accepted values |
|----------|---------|-----------------|
| `PORT` | `3000`, when the variable is unset or empty | An integer between `1024` and `65535` |

Start the server on a different port:

```bash
PORT=8080 node server.js
```

The startup line reports the configured port, and the server answers on it:

```console
$ PORT=8080 node server.js
Server listening on port 8080
```

```bash
curl -i http://localhost:8080/hello
```

The value must be a base-10 integer written in digits, with no sign, whitespace, decimal point, exponent or trailing characters, and it must fall within the `1024`–`65535` range. A value that fails either test is rejected before any socket is created, so the server reports the reason and exits with status code `1` without binding anything:

```console
$ PORT=abc node server.js
Invalid PORT value "abc": PORT must be an integer between 1024 and 65535. Example: PORT=8080 node server.js
$ echo $?
1
```

The message quotes the value as it was supplied, so `PORT=80` produces `Invalid PORT value "80": ...`. Control characters in the value — a newline above all — are shown escaped (`\n`, `\r`, `\t`), so the message stays on one line while still showing the value that was rejected. It is written to stderr, while the startup, request and shutdown lines go to stdout. `80`, `0`, `65536`, `abc`, `80.5`, `3000.5`, `-3000`, `0x1F90`, `3e3`, `3000abc` and `+3000` are all rejected with that same message whatever the reason, and no startup line is logged.

Ports `1`–`1023` are privileged on Unix-like systems, which is the reason for the `1024` floor: a privileged port is refused rather than bound, and because the value is validated before the server is created, no bind is ever attempted for one.

If the port is already held by another process, the bind failure is caught, reported and exited from instead of crashing the process:

```console
$ node server.js
Port 3000 is already in use. Stop the process using it, or start the server on an unused port: PORT=3001 node server.js
$ echo $?
1
```

The message names the port that failed and the next one as the suggested alternative, so an instance started on 8080 reports `Port 8080 is already in use.` and suggests `PORT=8081 node server.js`. `65535` is the highest port the server accepts, so when that port is the one held there is no next port to name and the message advises any unused port in the `1024`–`65535` range instead of a `65536` it would reject:

```console
$ PORT=65535 node server.js
Port 65535 is already in use. Stop the process using it, or start the server on an unused port: any unused port in the 1024-65535 range
```
