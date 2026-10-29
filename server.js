const http = require('node:http');

function resolvePort(rawPort) {
  if (rawPort === undefined || rawPort === '') {
    return 3000;
  }

  const port = /^[0-9]+$/.test(rawPort) ? Number(rawPort) : NaN;

  if (Number.isInteger(port) && port >= 1024 && port <= 65535) {
    return port;
  }

  // The value is rendered through JSON.stringify rather than interpolated raw: JSON.stringify
  // supplies the surrounding quotes and escapes control characters, so a newline in the
  // environment value cannot end this one-line message and continue it on a second line that
  // reads as the startup line or a request line, while the rejected value stays visible.
  console.error(
    `Invalid PORT value ${JSON.stringify(rawPort)}: PORT must be an integer between 1024 and 65535. Example: PORT=8080 node server.js`
  );
  process.exitCode = 1;
  return null;
}

const ORIGIN_FORM = /^\/(?![/\\])/;
const ABSOLUTE_FORM = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

function getPathname(req) {
  try {
    // Matching compares this parsed pathname rather than req.url, because the raw request
    // target carries the query string: '/hello?x=1' would fail an exact string comparison
    // against '/hello' and be answered with a 404 even though the path matches. A target
    // that cannot be parsed returns null from the catch, so it takes the ordinary 404 and
    // the request line reports the raw target in place of a pathname. The form guard below
    // admits only an origin-form or absolute-form target, because the parse adopts the
    // authority the target itself names: '//host/hello' and '/\host/hello' would otherwise be
    // matched against this route table as a path addressed to another host. A target the guard
    // rejects takes the ordinary 404, including '//hello': it names no path of its own, and
    // without the guard its parse would yield the base's '/'.
    if (typeof req.url !== 'string' || !(ORIGIN_FORM.test(req.url) || ABSOLUTE_FORM.test(req.url))) {
      return null;
    }

    return new URL(req.url, 'http://localhost').pathname;
  } catch {
    return null;
  }
}

function logRequest(req, pathname) {
  console.log(`${new Date().toISOString()} ${req.method} ${pathname ?? req.url}`);
}

const ROUTES = {
  'GET /hello': handleHello,
  'GET /good-evening': handleGoodEvening,
};

function router(req, res, pathname) {
  const handler = ROUTES[`${req.method} ${pathname}`];

  if (handler) {
    handler(res);
    return;
  }

  sendNotFound(res);
}

function handleHello(res) {
  sendText(res, 200, 'Hello world');
}

function handleGoodEvening(res) {
  sendText(res, 200, 'Good evening');
}

const NOT_FOUND_BODY = 'Not Found';

function sendNotFound(res) {
  sendText(res, 404, NOT_FOUND_BODY);
}

function sendText(res, statusCode, body) {
  // res.writeHead() is deliberately not used: it commits the headers before the body length
  // is known, so Node frames the response as Transfer-Encoding: chunked with no
  // Content-Length. Assigning the status and setting the header instead leaves them
  // implicit, so res.end(body) lets Node generate Content-Length from the byte length
  // (11 bytes for 'Hello world', 9 for 'Not Found') and add Date, Connection and Keep-Alive.
  // Every handler writes through here, so status, header and framing cannot diverge.
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/plain');
  res.end(body);
}

function handleRequest(req, res) {
  const pathname = getPathname(req);

  logRequest(req, pathname);
  router(req, res, pathname);
}

function handleConnect(req, socket) {
  // Node never delivers a CONNECT request to the request listener: it emits 'connect' with the
  // tunnelled socket instead, and with no listener the connection is destroyed and the method
  // receives no response at all. Answering the catch-all from this event is what keeps the 404
  // contract true for every method; the socket carries no ServerResponse, so the response is
  // written to it directly and closed, with no internal detail and nothing request-derived.
  // The destroy runs in end()'s completion callback so the socket is released as soon as the
  // bytes are handed to the kernel, not left to the socket's allowHalfOpen default or a timer.
  logRequest(req, getPathname(req));

  // Node hands this socket over with its own error listener already detached, so a client that
  // has gone away would otherwise turn the write below into an uncaught 'error' event that ends
  // the process. There is nothing to report on a connection that is already closed, and the
  // four log points the product defines are the only lines it writes, so the failure is
  // absorbed and the socket torn down.
  socket.on('error', () => socket.destroy());

  socket.end(
    'HTTP/1.1 404 Not Found\r\n' +
      'Content-Type: text/plain\r\n' +
      `Date: ${new Date().toUTCString()}\r\n` +
      'Connection: close\r\n' +
      `Content-Length: ${Buffer.byteLength(NOT_FOUND_BODY)}\r\n` +
      '\r\n' +
      NOT_FOUND_BODY,
    () => socket.destroy()
  );
}

function handleServerError(err) {
  if (err.code === 'EADDRINUSE') {
    // The suggested alternative must itself be a value resolvePort accepts (1024-65535), so
    // the next port is named only where it falls inside that range: at 65535 the advice would
    // be 65536, which this same program rejects. err.port is absent when the error arrives
    // without a bind attempt, so the port token falls back to the configured port and then to
    // the default rather than being printed as 'undefined' with a 'NaN' remedy.
    const busyPort = Number.isInteger(err.port) ? err.port : (Number(process.env.PORT) || 3000);
    const remedy = Number.isInteger(busyPort) && busyPort >= 1024 && busyPort < 65535
      ? `PORT=${busyPort + 1} node server.js`
      : 'any unused port in the 1024-65535 range';
    console.error(
      `Port ${busyPort} is already in use. Stop the process using it, or start the server on an unused port: ${remedy}`
    );
  } else {
    console.error(`Fatal server error (${err.code ?? 'UNKNOWN'}): ${err.message}`);
  }

  process.exitCode = 1;
}

function registerShutdownHandlers(server) {
  let shuttingDown = false;

  process.on('SIGINT', () => {
    // A second Ctrl+C must be ignored rather than close the server again: server.close() is
    // already in progress, and its callback receives an Error when the server was closed.
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;

    console.log('Received SIGINT, shutting down');

    server.close(() => {
      console.log('Server closed');
      process.exitCode = 0;
    });

    // closeIdleConnections() arrived in Node 18.2.0, and this server runs from 18.0.0, so it
    // is called only where the runtime provides it. On 18.0.0 and 18.1.0 an idle keep-alive
    // socket defers the exit until server.keepAliveTimeout elapses (5000 ms by default).
    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }
  });
}

function start() {
  // Configuration is validated before any socket is created, so a privileged port is refused
  // rather than bound, and a rejected value never leaves a half-configured server running.
  const port = resolvePort(process.env.PORT);

  if (port === null) {
    return;
  }

  const server = http.createServer(handleRequest);

  // The 'error' listener is registered before listen(): an 'error' event with no listener is
  // thrown and crashes the process instead of producing the actionable EADDRINUSE message.
  server.on('error', handleServerError);

  server.on('listening', () => {
    console.log(`Server listening on port ${port}`);
  });

  server.on('connect', handleConnect);

  server.listen(port);

  registerShutdownHandlers(server);
}

start();
