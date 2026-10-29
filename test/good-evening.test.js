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
const REQUEST_TIMEOUT_MS = 5000;

let server;
let liveChild = null;

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

    // The child is tracked from the moment it is spawned rather than from readiness, because the
    // paths that end this process before its stop hook runs leave no other handle on it.
    liveChild = child;

    let stdout = '';
    let stderr = '';
    let settled = false;
    let exitCode = null;
    let exitSignal = null;

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
    // a lost free port and has to tell that failure from any other. 'exit' only reports that the
    // process ended — its stdio may still be open — so the fate is recorded there and the error
    // is built on 'close', once every buffered chunk has arrived: an undrained stderr would read
    // as a failure of another kind and turn a lost free port into a hard abort.
    child.once('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });

    child.once('close', () => {
      // Cleared by this child's own 'close' and never by another: the guard keeps the slot
      // holding the most recently spawned child, so a stale 'close' cannot empty the live handle.
      if (liveChild === child) {
        liveChild = null;
      }

      const error = new Error(
        `The server exited before reporting readiness on port ${port} (code ${exitCode}, signal ${exitSignal})`
      );

      error.exitCode = exitCode;
      error.signal = exitSignal;
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

    // node:test applies no default timeout, so a server that never answers would hang the run here.
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`No response to ${method} ${target} on port ${port} within ${REQUEST_TIMEOUT_MS} ms`));
    });

    req.on('error', reject);
    req.end();
  });
}

function stopServer(child) {
  return new Promise((resolve, reject) => {
    let settled = false;

    function finish(error, fate) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(stopTimer);

      if (error) {
        reject(error);
        return;
      }

      resolve(fate);
    }

    // The stop settles on 'close' rather than 'exit': 'exit' only reports that the process ended,
    // while the hook that awaits this asserts on the child's stdout and stderr, which 'close'
    // follows once every buffered chunk has been handed over. A child that outlives its own exit
    // through an inherited pipe, or one killed outright, is what makes the difference visible.
    const stopTimer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`The server did not exit within ${STOP_TIMEOUT_MS} ms of the SIGINT request`));
    }, STOP_TIMEOUT_MS);

    child.once('close', (code, signal) => finish(null, { code, signal }));

    // A child that died before this hook ran — a crash during a case, which is what this suite
    // exists to catch — ignores the signal and is already gone, so its fate is settled here;
    // the streams must have ended first, because their end is the only proof its output can no
    // longer arrive, and until then 'close' is still to come.
    if (
      (child.exitCode !== null || child.signalCode !== null) &&
      child.stdout.readableEnded &&
      child.stderr.readableEnded
    ) {
      finish(null, { code: child.exitCode, signal: child.signalCode });
      return;
    }

    child.kill('SIGINT');
  });
}

// The stop hook is not the only way out of this process: a closed stdout pipe, a signal aimed at
// the run or an uncaught exception ends it before that hook runs, and the tracked child would
// survive as an orphan holding its port. So it is reaped from the last two points that can still
// act — the trappable signals, and 'exit', which every other way out reaches.
function reapLiveChild() {
  const child = liveChild;

  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  liveChild = null;

  // SIGKILL, because this process is already terminating, nothing will read the child's shutdown
  // lines, and it is the one signal the server cannot defer, so its port is released at once.
  try {
    child.kill('SIGKILL');
  } catch (error) {
    // An exit hook that threw would replace the failure that ended the run, and there is nowhere
    // left to report one.
  }
}

function endBySignal(signal, handler) {
  reapLiveChild();

  // Re-raised with this listener removed, so the default action ends the run exactly as it would
  // have without the handler, by the signal it received rather than with an invented status.
  process.removeListener(signal, handler);
  process.kill(process.pid, signal);
}

function onSigint() {
  endBySignal('SIGINT', onSigint);
}

function onSigterm() {
  endBySignal('SIGTERM', onSigterm);
}

// Both pipes can be closed while this process is still running — the runner's reader is gone —
// and an unhandled stream 'error' would then surface as an uncaught exception, ending the run on
// an EPIPE stack in place of its real result. Absorbing it lets the run reach its stop hook,
// which stops the child and reports what happened; there is no reader for anything written to a
// closed pipe anyway.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

process.on('SIGINT', onSigint);
process.on('SIGTERM', onSigterm);
process.on('exit', reapLiveChild);

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
