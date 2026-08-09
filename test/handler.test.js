const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const dns = require("dns");

process.env.HOSTS = "localhost";
process.env.ALLOW_PRIVATE_HOSTS = "1"; // tests run against 127.0.0.1
process.env.ALLOWED_PORTS = "*"; // tests run on an ephemeral port
process.env.CACHE_TTL_MS = "0"; // disable in-memory cache between calls

const handler = require("../api/v1/index.js");
const { checkHostSafe } = handler;

function callHandler({ referer, url }) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) {
        this.headers[k] = v;
      },
      send(payload) {
        resolve({ statusCode: this.statusCode, headers: this.headers, payload });
      },
    };
    const req = {
      headers: referer ? { referer } : {},
      query: { url },
    };
    handler(req, res);
  });
}

function startServer() {
  return new Promise((resolve) => {
    const routes = {
      "/page": (_req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          "<!doctype html><html><head>" +
            "<title>Test Site</title>" +
            '<meta name="description" content="A test page">' +
            '<link rel="icon" href="/favicon.ico">' +
            "</head><body>hi</body></html>"
        );
      },
      "/relative-icon": (_req, res) => {
        res.end('<!doctype html><html><head><link rel="icon" href="favicon.ico"></head></html>');
      },
      "/redirect": (_req, res) => {
        res.statusCode = 302;
        res.setHeader("Location", "/page");
        res.end();
      },
      "/loop-a": (_req, res) => {
        res.statusCode = 302;
        res.setHeader("Location", "/loop-b");
        res.end();
      },
      "/loop-b": (_req, res) => {
        res.statusCode = 302;
        res.setHeader("Location", "/loop-a");
        res.end();
      },
      "/slow": () => {
        // never respond
      },
      "/big": (_req, res) => {
        res.end("x".repeat(4096));
      },
      "/status-404": (_req, res) => {
        res.statusCode = 404;
        res.end("not found");
      },
    };
    const server = http.createServer((req, res) => {
      const route = routes[req.url];
      if (!route) {
        res.statusCode = 404;
        return res.end("not found");
      }
      route(req, res);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

let server;
let baseUrl;

test.before(async () => {
  server = await startServer();
  baseUrl = "http://127.0.0.1:" + server.address().port;
});

test.after(() => {
  server.close();
});

test("rejects a referer host that is not allowed", async () => {
  const r = await callHandler({ referer: "https://evil.com/x", url: baseUrl + "/page" });
  assert.equal(r.statusCode, 403);
});

test("rejects a request without referer when empty host is not allowed", async () => {
  const r = await callHandler({ url: baseUrl + "/page" });
  assert.equal(r.statusCode, 403);
});

test("allows requests without referer when ALLOW_EMPTY_REFERER is enabled", async () => {
  process.env.ALLOW_EMPTY_REFERER = "1";
  try {
    const r = await callHandler({ url: baseUrl + "/page" });
    assert.equal(r.statusCode, 200);
    assert.equal(r.payload.title, "Test Site");
  } finally {
    delete process.env.ALLOW_EMPTY_REFERER;
  }
});

test("extracts title, description and absolute icon URL", async () => {
  const r = await callHandler({ referer: "https://localhost/x", url: baseUrl + "/page" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.payload.title, "Test Site");
  assert.equal(r.payload.desc, "A test page");
  assert.equal(r.payload.icon, baseUrl + "/favicon.ico");
  assert.equal(r.payload.url, baseUrl + "/page");
  assert.ok(r.headers["Vercel-CDN-Cache-Control"]);
});

test("resolves a relative icon path without a leading slash", async () => {
  const r = await callHandler({ referer: "https://localhost/x", url: baseUrl + "/relative-icon" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.payload.icon, baseUrl + "/favicon.ico");
});

test("follows redirects", async () => {
  const r = await callHandler({ referer: "https://localhost/x", url: baseUrl + "/redirect" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.payload.title, "Test Site");
});

test("stops after too many redirects", async () => {
  const r = await callHandler({ referer: "https://localhost/x", url: baseUrl + "/loop-a" });
  assert.equal(r.statusCode, 502);
  assert.deepEqual(r.payload, {});
});

test("rejects invalid protocols", async () => {
  const r = await callHandler({ referer: "https://localhost/x", url: "ftp://example.com" });
  assert.equal(r.statusCode, 400);
  assert.deepEqual(r.payload, {});
});

test("rejects a non-string url parameter", async () => {
  const r = await callHandler({ referer: "https://localhost/x", url: undefined });
  assert.equal(r.statusCode, 400);
});

test("blocks private addresses by default", async () => {
  process.env.ALLOW_PRIVATE_HOSTS = "0";
  try {
    const r = await callHandler({ referer: "https://localhost/x", url: baseUrl + "/page" });
    assert.equal(r.statusCode, 403);
    assert.deepEqual(r.payload, {});
  } finally {
    process.env.ALLOW_PRIVATE_HOSTS = "1";
  }
});

test("does not treat domain names as literal private addresses", (t, done) => {
  process.env.ALLOW_PRIVATE_HOSTS = "0";
  const originalLookup = dns.promises.lookup;
  dns.promises.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  try {
    checkHostSafe("127.0.0.1", (err) => {
      assert.ok(err, "literal loopback should be blocked");
      assert.equal(err.statusCode, 403);
      checkHostSafe("example.com", (err2) => {
        assert.ifError(err2, "public domain should pass after DNS check");
        done();
      });
    });
  } finally {
    dns.promises.lookup = originalLookup;
    process.env.ALLOW_PRIVATE_HOSTS = "1";
  }
});

test("returns 502 when the upstream responds with an error status", async () => {
  const r = await callHandler({ referer: "https://localhost/x", url: baseUrl + "/status-404" });
  assert.equal(r.statusCode, 502);
});

test("enforces the response size limit", async () => {
  process.env.MAX_RESPONSE_BYTES = "1024";
  try {
    const r = await callHandler({ referer: "https://localhost/x", url: baseUrl + "/big" });
    assert.equal(r.statusCode, 502);
  } finally {
    delete process.env.MAX_RESPONSE_BYTES;
  }
});

test("times out slow upstreams", async () => {
  process.env.REQUEST_TIMEOUT_MS = "200";
  try {
    const r = await callHandler({ referer: "https://localhost/x", url: baseUrl + "/slow" });
    assert.equal(r.statusCode, 504);
  } finally {
    delete process.env.REQUEST_TIMEOUT_MS;
  }
});
