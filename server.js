const http = require('node:http');

function resolvePort(rawPort) {
  if (rawPort === undefined || rawPort === '') {
    return 3000;
  }

  const port = /^[0-9]+$/.test(rawPort) ? Number(rawPort) : NaN;

  if (Number.isInteger(port) && port >= 1024 && port <= 65535) {
    return port;
  }

  console.error(
    `Invalid PORT value "${rawPort}": PORT must be an integer between 1024 and 65535. Example: PORT=8080 node server.js`
  );
  process.exitCode = 1;
  return null;
}

function getPathname(req) {
  try {
    // Matching compares this parsed pathname rather than req.url, because the raw request
    // target carries the query string: '/hello?x=1' would fail an exact string comparison
    // against '/hello' and be answered with a 404 even though the path matches. A target
    // that cannot be parsed returns null from the catch, so it takes the ordinary 404 and
    // the request line reports the raw target in place of a pathname.
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

function sendNotFound(res) {
  sendText(res, 404, 'Not Found');
}

function sendText(res, statusCode, body) {
  // res.writeHead() is deliberately not used: it commits the headers before the body length
  // is known, so Node frames the response as Transfer-Encoding: chunked with no
  // Content-Length. Assigning the status and setting the header instead leaves them
  // implicit, so res.end(body) lets Node generate Content-Length from the byte length
  // (11 bytes for 'Hello world', 9 for 'Not Found') and add Date, Connection and Keep-Alive.
  // Both handlers write through here, so status, header and framing cannot diverge.
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/plain');
  res.end(body);
}

function handleRequest(req, res) {
  const pathname = getPathname(req);

  logRequest(req, pathname);
  router(req, res, pathname);
}

function handleServerError(err) {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `Port ${err.port} is already in use. Stop the process using it, or start the server on an unused port: PORT=${err.port + 1} node server.js`
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

  server.listen(port);

  registerShutdownHandlers(server);
}

start();
