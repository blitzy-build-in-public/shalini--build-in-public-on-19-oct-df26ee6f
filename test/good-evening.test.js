const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const STARTUP_PREFIX = 'Server listening on port ';
const START_ATTEMPTS = 4;
const READY_TIMEOUT_MS = 10000;
const STOP_TIMEOUT_MS = 5000;
const RELEASE_TIMEOUT_MS = 3000;
const RELEASE_RETRY_MS = 50;

let server;

function discoverFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();

    probe.once('error', reject);

    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();

      probe.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }

        // The port is passed to the child explicitly rather than left to the default, and
        // resolvePort refuses anything outside 1024-65535, so the discovered value has to be
        // inside that range before it is worth handing over.
        if (!(port >= 1024 && port <= 65535)) {
          reject(new Error(`Discovered port ${port} is outside the 1024-65535 range the server accepts`));
          return;
        }

        resolve(port);
      });
    });
  });
}

// The server is driven as a process over real HTTP rather than imported: start() is called at
// module scope and the file exports nothing, so requiring it would bind a socket and hand back
// no handle to the handlers, the route table or the response writer.
function startOnce(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: REPO_ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    function finish(error) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(readinessTimer);

      if (error) {
        reject(error);
        return;
      }

      resolve({ child, port, readStdout: () => stdout, readStderr: () => stderr });
    }

    const readinessTimer = setTimeout(() => {
      finish(new Error(`The server did not report readiness on port ${port} within ${READY_TIMEOUT_MS} ms`));
      child.kill('SIGKILL');
    }, READY_TIMEOUT_MS);

    // Readiness is the child's own startup line, and stdout arrives in chunks that can split
    // that line, so the test is made against everything received so far rather than against
    // the chunk that just arrived.
    child.stdout.on('data', (chunk) => {
      stdout += chunk;

      if (stdout.includes(`${STARTUP_PREFIX}${port}`)) {
        finish();
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.once('error', (error) => finish(error));

    // A start that fails carries its exit code and both streams, because the caller retries on
    // a lost free port and has to tell that failure from any other.
    child.once('exit', (code, signal) => {
      const error = new Error(
        `The server exited before reporting readiness on port ${port} (code ${code}, signal ${signal})`
      );

      error.exitCode = code;
      error.signal = signal;
      error.stdout = stdout;
      error.stderr = stderr;

      finish(error);
    });
  });
}

async function startServer(attempts = START_ATTEMPTS) {
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = await discoverFreePort();

    try {
      return await startOnce(port);
    } catch (error) {
      lastError = error;

      // Releasing the probe and binding the child are two steps, so another process can take the
      // port in between. That failure is the child's own in-use line with exit status 1, and a
      // freshly discovered port is what recovers from it; anything else is a real failure.
      const lostPort =
        error.exitCode === 1 &&
        typeof error.stderr === 'string' &&
        error.stderr.includes(`Port ${port} is already in use`);

      if (!lostPort) {
        throw error;
      }
    }
  }

  throw lastError;
}

function request(port, target, method = 'GET') {
  return new Promise((resolve, reject) => {
    // agent: false gives every request its own socket: a pooled keep-alive socket would hold the
    // connection open and defer the server's close() when the child is asked to stop.
    const req = http.request({ host: '127.0.0.1', port, path: target, method, agent: false }, (res) => {
      const chunks = [];

      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });

    req.on('error', reject);
    req.end();
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    const killTimer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);

    child.once('exit', (code, signal) => {
      clearTimeout(killTimer);
      resolve({ code, signal });
    });

    child.kill('SIGINT');
  });
}

async function assertPortReleased(port) {
  const deadline = Date.now() + RELEASE_TIMEOUT_MS;

  for (;;) {
    try {
      await new Promise((resolve, reject) => {
        const probe = net.createServer();

        probe.once('error', reject);

        probe.listen(port, '127.0.0.1', () => {
          probe.close((closeError) => (closeError ? reject(closeError) : resolve()));
        });
      });

      return;
    } catch (error) {
      // Binding the port again is the positive proof that it was released, and a listener closed
      // moments ago can still refuse one, so EADDRINUSE alone is retried, and only to the deadline.
      if (error.code !== 'EADDRINUSE' || Date.now() >= deadline) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, RELEASE_RETRY_MS));
    }
  }
}

before(async () => {
  server = await startServer();
});

after(async () => {
  assert.ok(server, 'the server under test was never started');

  const { code, signal } = await stopServer(server.child);

  assert.strictEqual(signal, null, 'the server should end through its own SIGINT handling, not a signal');
  assert.strictEqual(code, 0);
  assert.match(server.readStdout(), /Received SIGINT, shutting down/);
  assert.match(server.readStdout(), /Server closed/);
  assert.strictEqual(server.readStderr(), '');

  await assertPortReleased(server.port);
});

test('the server starts with both endpoints registered and no errors', () => {
  assert.match(server.readStdout(), new RegExp(`^${STARTUP_PREFIX}${server.port}$`, 'm'));
  assert.strictEqual(server.readStderr(), '');
});

test('GET /good-evening answers 200 text/plain with the 12-byte body Good evening', async () => {
  const res = await request(server.port, '/good-evening');

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.headers['content-type'], 'text/plain');
  assert.strictEqual(res.headers['content-length'], '12');
  assert.strictEqual(res.headers['transfer-encoding'], undefined);
  assert.strictEqual(Buffer.byteLength(res.body), 12);
  assert.ok(
    res.body.equals(Buffer.from('Good evening')),
    `body should be exactly "Good evening", got ${JSON.stringify(res.body.toString('utf8'))}`
  );
});

test('GET /hello still answers 200 text/plain with the 11-byte body Hello world', async () => {
  const res = await request(server.port, '/hello');

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.headers['content-type'], 'text/plain');
  assert.strictEqual(res.headers['content-length'], '11');
  assert.strictEqual(res.headers['transfer-encoding'], undefined);
  assert.strictEqual(Buffer.byteLength(res.body), 11);
  assert.ok(
    res.body.equals(Buffer.from('Hello world')),
    `body should be exactly "Hello world", got ${JSON.stringify(res.body.toString('utf8'))}`
  );
});

test('an unregistered method or path is refused with 404 and no Allow header', async () => {
  for (const [target, method] of [['/good-evening', 'POST'], ['/unknown', 'GET']]) {
    const res = await request(server.port, target, method);
    const label = `${method} ${target}`;

    assert.strictEqual(res.statusCode, 404, label);
    assert.strictEqual(res.headers['content-type'], 'text/plain', label);
    assert.strictEqual(res.headers['content-length'], '9', label);
    assert.strictEqual(res.headers.allow, undefined, `${label} must not be answered with an Allow header`);
    assert.ok(res.body.equals(Buffer.from('Not Found')), `${label} should be refused with "Not Found"`);
  }
});

test('the query string is ignored and the trailing slash is a different path', async () => {
  const queried = await request(server.port, '/good-evening?x=1');

  assert.strictEqual(queried.statusCode, 200);
  assert.ok(queried.body.equals(Buffer.from('Good evening')), 'the query string should not affect the match');

  const slashed = await request(server.port, '/good-evening/');

  assert.strictEqual(slashed.statusCode, 404);
  assert.ok(slashed.body.equals(Buffer.from('Not Found')), 'the trailing slash should make this a different path');
});
