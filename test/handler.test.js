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
      if (req.url.startsWith("/icon-case?")) {
        return res.end(new URL(req.url, "http://localhost").searchParams.get("html"));
      }
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

async function parseIcons(html) {
  const r = await callHandler({
    referer: "https://localhost/x",
    url: baseUrl + "/icon-case?html=" + encodeURIComponent(html),
  });
  assert.equal(r.statusCode, 200);
  return r.payload;
}

test("skips invalid candidates and retains small icons and declared metadata", async () => {
  const r = await parseIcons(`
    <link rel="apple-touch-icon" href=" ">
    <link rel="apple-touch-icon" href="data:image/png;base64,AA">
    <link rel="icon" href="javascript:alert(1)">
    <link rel="icon" href="http://[">
    <link rel="ICON shortcut" href="/small.png" sizes="16x16" type="image/png">
    <link rel="apple-touch-icon" href="/touch.png" sizes="180x180">
    <link rel="ICON shortcut" href="/small.png" sizes="16x16" type="image/png">
    <link rel="icon" href="/vector.svg" sizes="any" media="(prefers-color-scheme: dark)">
    <meta property="og:image" content="/preview.png">
  `);
  assert.equal(r.icon, baseUrl + "/touch.png");
  assert.equal(r.favicon, baseUrl + "/small.png");
  assert.equal(r.appicon, baseUrl + "/touch.png");
  assert.equal(r.icons, undefined);
});

test("resolves base URLs and supports legacy touch and mask icons", async () => {
  const r = await parseIcons(`<base href="/assets/">
    <link rel="mask-icon" href="mask.svg">
    <link rel="apple-touch-icon-precomposed" href="touch.png">`);
  assert.equal(r.icon, baseUrl + "/assets/touch.png");
  assert.equal(r.favicon, baseUrl + "/assets/touch.png");
  assert.equal(r.appicon, baseUrl + "/assets/touch.png");
});

test("tries subsequent metadata candidates and supports Twitter name attributes", async () => {
  const r = await parseIcons(`<link rel="icon" href="#">
    <meta property="og:image" content="">
    <meta property="og:image" content="ftp://example.com/image.png">
    <meta name="twitter:image" content="https://user:pass@example.com/image.png">
    <meta name="twitter:image" content="//example.com/social.png">`);
  assert.equal(r.icon, "http://example.com/social.png");
  assert.equal(r.icons, undefined);
});

test("does not mistake unrelated rel values for icons or invent a favicon", async () => {
  const r = await parseIcons(`<title>No icon</title>
    <link rel="stylesheet" href="/wrong.png">
    <link rel="icon" href="DATA:image/png;base64,AA">`);
  assert.equal(r.icon, undefined);
  assert.equal(r.icons, undefined);
});

for (const [field, ranking] of Object.entries({
  favicon: ["favicon.ico", "32x32", "48x48", "16x16", "180x180", "192x192"],
  appicon: ["192x192", "180x180", "512x512", "48x48", "32x32", "16x16"],
})) {
  test(`${field} follows every priority tier and falls back in document order`, async () => {
    for (let i = 0; i <= ranking.length; i++) {
      const links = ranking.slice(i).reverse().map((size) =>
        size === "favicon.ico"
          ? '<link rel="icon" href="/assets/favicon.ico?v=1">'
          : `<link rel="icon" sizes="${size}" href="/${size}.png">`).join("");
      const r = await parseIcons('<link rel="custom-icon" href="/first.svg">' + links);
      const expected = i === ranking.length ? "/first.svg"
        : ranking[i] === "favicon.ico" ? "/assets/favicon.ico?v=1" : `/${ranking[i]}.png`;
      assert.equal(r[field], baseUrl + expected);
      assert.equal(r.icons, undefined);
    }
  });
}

test("matches multiple sizes case-insensitively and keeps first candidate on ties", async () => {
  const r = await parseIcons(`<link rel="icon" sizes="16x16 32X32 192x192" href="/multi.ico">
    <link rel="icon" sizes="32x32 192x192" href="/later.png">`);
  assert.equal(r.favicon, baseUrl + "/multi.ico");
  assert.equal(r.appicon, baseUrl + "/multi.ico");
});

test("social images do not populate favicon or appicon", async () => {
  const r = await parseIcons('<meta property="og:image" content="/social.png">');
  assert.equal(r.icon, baseUrl + "/social.png");
  assert.equal(r.favicon, undefined);
  assert.equal(r.appicon, undefined);
  assert.equal(r.icons, undefined);
});

test("prefers ordinary icons over masks even when masks match filename and sizes", async () => {
  const r = await parseIcons(`<link rel="mask-icon" href="/favicon.ico" sizes="32x32 192x192">
    <link rel="custom-icon" href="/custom.png">
    <link rel="icon" href="/ordinary.svg" sizes="any">`);
  assert.equal(r.favicon, baseUrl + "/ordinary.svg");
  assert.equal(r.appicon, baseUrl + "/ordinary.svg");
});

test("uses a mask icon as a last resort", async () => {
  const r = await parseIcons('<link rel="mask-icon" href="/mask.svg">');
  assert.equal(r.favicon, baseUrl + "/mask.svg");
  assert.equal(r.appicon, baseUrl + "/mask.svg");
});
