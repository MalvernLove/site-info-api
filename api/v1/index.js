const http = require("http");
const https = require("https");
const dns = require("dns");
const net = require("net");
const ipaddr = require("ipaddr.js");
const { JSDOM } = require("jsdom");

// Environment configuration
// HOSTS: comma-separated list of allowed referer hosts, e.g. "localhost, xaoxuu.com"
// ALLOW_EMPTY_REFERER=1: allow requests without a Referer header.
// ALLOW_PRIVATE_HOSTS=1: allow fetching private/loopback/link-local addresses.
//   Only enable this on a trusted, self-hosted deployment.
const HOSTS = parseHosts(process.env.HOSTS);

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MiB
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_MAX_CACHE_ENTRIES = 200;
const CDN_CACHE_MAX_AGE = 604800; // 7 days, only applied to successful responses

// cache: Map<url, { data, expiresAt }>
const cache = new Map();

class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function parseHosts(env) {
  if (!env) return ["localhost"];
  return env
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

function allowEmptyReferer() {
  return (
    process.env.ALLOW_EMPTY_REFERER === "1" || process.env.ALLOW_EMPTY_REFERER === "true"
  );
}

function isAllowedReferer(referer) {
  if (!referer) return allowEmptyReferer();
  let host = "";
  try {
    host = new URL(referer).hostname || "";
  } catch {
    return false;
  }
  return HOSTS.includes(host);
}

function privateAllowed() {
  return process.env.ALLOW_PRIVATE_HOSTS === "1" || process.env.ALLOW_PRIVATE_HOSTS === "true";
}

function isPrivateAddress(addr) {
  try {
    const parsed = ipaddr.parse(addr);
    if (parsed.kind() === "ipv6") {
      if (parsed.isIPv4MappedAddress()) {
        return isPrivateAddress(parsed.toIPv4Address().toString());
      }
      const r = parsed.range();
      return [
        "unspecified",
        "loopback",
        "linkLocal",
        "uniqueLocal",
        "multicast",
        "reserved",
        "ipv4Mapped",
        "rfc6145",
        "rfc6052",
        "6to4",
        "teredo",
      ].includes(r);
    }
    const r = parsed.range();
    return [
      "unspecified",
      "broadcast",
      "multicast",
      "linkLocal",
      "loopback",
      "carrierGradeNat",
      "private",
      "reserved",
    ].includes(r);
  } catch {
    // Fail closed on anything we cannot parse.
    return true;
  }
}

function isBlockedHostname(hostname) {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  );
}

function allowedPorts() {
  const raw = process.env.ALLOWED_PORTS;
  if (!raw) return ["80", "443"];
  if (raw.trim() === "*") return null; // any port
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

// Validates a user-supplied URL. Returns a URL object or null.
function validateUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  if (u.username || u.password) return null;
  const ports = allowedPorts();
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  if (ports && !ports.includes(port)) return null;
  return u;
}

// Resolves the hostname and rejects it when any address is private/internal.
function checkHostSafe(hostname, callback) {
  if (isBlockedHostname(hostname)) {
    return callback(new ApiError(403, "blocked hostname"));
  }
  if (privateAllowed()) return callback(null);
  const host = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isPrivateAddress(host)) {
    return callback(new ApiError(403, "blocked address"));
  }
  dns.promises
    .lookup(host, { all: true })
    .then((addresses) => {
      if (addresses.some((a) => isPrivateAddress(a.address))) {
        return callback(new ApiError(403, "blocked address"));
      }
      callback(null);
    })
    .catch((err) => callback(new ApiError(502, "dns lookup failed: " + err.message)));
}

function requestTimeoutMs() {
  const n = parseInt(process.env.REQUEST_TIMEOUT_MS, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_REQUEST_TIMEOUT_MS;
}

function maxRedirects() {
  const n = parseInt(process.env.MAX_REDIRECTS, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_REDIRECTS;
}

function maxResponseBytes() {
  const n = parseInt(process.env.MAX_RESPONSE_BYTES, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_RESPONSE_BYTES;
}

function cacheTtlMs() {
  const n = parseInt(process.env.CACHE_TTL_MS, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CACHE_TTL_MS;
}

function maxCacheEntries() {
  const n = parseInt(process.env.MAX_CACHE_ENTRIES, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_CACHE_ENTRIES;
}

function setCache(key, data) {
  if (cache.size >= maxCacheEntries()) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { data, expiresAt: Date.now() + cacheTtlMs() });
}

// Fetches a URL, following up to maxRedirects redirects with SSRF re-validation on every hop.
function main(url, redirectsLeft, deadline, callback) {
  const target = validateUrl(url);
  if (!target) return callback(new ApiError(400, "invalid url"));
  checkHostSafe(target.hostname, (err) => {
    if (err) return callback(err);

    let settled = false;
    const settle = (e, data) => {
      if (settled) return;
      settled = true;
      callback(e, data);
    };

    const remaining = deadline - Date.now();
    if (remaining <= 0) return settle(new ApiError(504, "timeout"));
    const timeout = Math.min(requestTimeoutMs(), remaining);
    const mod = target.protocol === "http:" ? http : https;
    const req = mod.get(
      target,
      {
        headers: {
          "User-Agent": "site-info-api/1.0 (+https://github.com/xaoxuu/site-info-api)",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        timeout,
      },
      (response) => {
        const status = response.statusCode || 0;
        const location = response.headers["location"];

        if ([301, 302, 303, 307, 308].includes(status) && location) {
          response.resume(); // drain and reuse the connection
          let next;
          try {
            next = new URL(location, target);
          } catch {
            return settle(new ApiError(502, "invalid redirect location"));
          }
          if (next.href === target.href) {
            return settle(new ApiError(502, "redirect loop"));
          }
          if (redirectsLeft <= 0) {
            return settle(new ApiError(502, "too many redirects"));
          }
          return main(next.href, redirectsLeft - 1, deadline, settle);
        }

        if (status >= 400) {
          response.resume();
          return settle(new ApiError(502, "upstream status " + status));
        }

        const chunks = [];
        let size = 0;
        let tooLarge = false;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxResponseBytes()) {
            tooLarge = true;
            req.destroy(); // stop the stream; the error is settled explicitly below
            settle(new ApiError(502, "response too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (tooLarge) return;
          const html = Buffer.concat(chunks).toString("utf8");
          getInfo(target.href, html, (data) => settle(null, data));
        });
        response.on("error", (e) =>
          settle(new ApiError(502, "upstream error: " + e.message))
        );
      }
    );
    req.on("timeout", () => req.destroy(new ApiError(504, "timeout")));
    req.on("error", (e) => {
      if (e instanceof ApiError) return settle(e);
      settle(new ApiError(502, "fetch error: " + e.message));
    });
  });
}

// Only return usable web URLs; invalid candidates must not stop fallback.
function resolveIconUrl(raw, base) {
  if (typeof raw !== "string" || !raw.trim() || raw.trim().startsWith("#")) return null;
  try {
    const url = new URL(raw.trim(), base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function getIcons(document, pageUrl) {
  const base = resolveIconUrl(document.baseURI, pageUrl) || pageUrl;
  const candidates = [];
  for (const el of document.querySelectorAll("link[rel][href]")) {
    const rel = el.getAttribute("rel").toLowerCase().split(/\s+/);
    const priority = rel.includes("apple-touch-icon") ? 0
      : rel.includes("apple-touch-icon-precomposed") ? 1
      : rel.includes("icon") ? 2
      : rel.includes("mask-icon") ? 3 : -1;
    if (!el.getAttribute("rel").toLowerCase().includes("icon")) continue;
    const src = resolveIconUrl(el.getAttribute("href"), base);
    if (!src) continue;
    const icon = { src };
    for (const key of ["sizes", "type", "media"]) {
      const value = el.getAttribute(key)?.trim();
      if (value) icon[key] = value;
    }
    candidates.push({ priority, icon, mask: rel.includes("mask-icon") });
  }
  // Keep document order for equal ranks and the final link fallback.
  const regular = candidates.filter(({ mask }) => !mask);
  // Mask icons are monochrome assets: use them only when no other icon exists.
  const usable = regular.length ? regular : candidates;
  const icons = usable.map(({ icon }) => icon);
  const fallback = usable.find(({ priority }) => priority >= 0)?.icon || icons[0];
  const data = {};
  if (icons.length) {
    const selectSize = (sizes) => {
      for (const size of sizes) {
        const match = icons.find((icon) =>
          (icon.sizes || "").toLowerCase().split(/\s+/).includes(size));
        if (match) return match.src;
      }
      return fallback.src;
    };
    const ico = icons.find((icon) =>
      new URL(icon.src).pathname.toLowerCase().endsWith("/favicon.ico"));
    data.favicon = ico?.src || selectSize(["32x32", "48x48", "16x16", "180x180", "192x192"]);
    data.appicon = selectSize(["192x192", "180x180", "512x512", "48x48", "32x32", "16x16"]);
    const preferred = candidates.filter(({ priority }) => priority >= 0)
      .sort((a, b) => a.priority - b.priority)[0];
    if (preferred) return { icon: preferred.icon.src, ...data };
  }

  const metas = [...document.querySelectorAll("meta[content]")];
  for (const name of ["og:image", "og:image:url", "twitter:image", "twitter:image:src", "msapplication-TileImage"]) {
    for (const el of metas) {
      const matches = [el.getAttribute("property"), el.getAttribute("name")]
        .some((value) => value?.trim().toLowerCase() === name.toLowerCase());
      if (!matches) continue;
      const icon = resolveIconUrl(el.getAttribute("content"), base);
      if (icon) return { icon, ...data };
    }
  }
  return data;
}

function getInfo(link, html, callback) {
  try {
    const data = {};
    let title, desc;
    const { document } = new JSDOM(html, { url: link }).window;

    // title
    let elTitle = document.querySelector("title");
    if (!elTitle) {
      elTitle = document.querySelector('head meta[property="og:title"]');
    }
    if (elTitle) {
      title = elTitle.text || elTitle.content;
    }
    if (title) {
      data.title = title;
    }

    // desc
    let elDesc = document.querySelector('head meta[property="og:description"]');
    if (!elDesc) {
      elDesc = document.querySelector('head meta[name="description"]');
    }
    if (elDesc) {
      desc = elDesc.content;
    }
    if (desc) {
      data.desc = desc;
    }

    Object.assign(data, getIcons(document, link));

    callback(data);
  } catch (error) {
    console.log("error >>", error);
    callback({});
  }
}

function sendSuccess(res, data) {
  res.setHeader("Vercel-CDN-Cache-Control", "max-age=" + CDN_CACHE_MAX_AGE);
  res.send(data);
}

function sendError(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vercel-CDN-Cache-Control", "no-store");
  res.send(payload);
}

function handler(req, res) {
  const referer = req.headers.referer || "";
  if (!isAllowedReferer(referer)) {
    console.error("referer invalid:", referer);
    return sendError(res, 403, {
      title: "请自部署该服务",
      desc: "https://github.com/xaoxuu/site-info-api/",
    });
  }
  console.log("referer ok:", referer);

  const q = req.query || {};
  const rawUrl = Array.isArray(q.url) ? q.url[0] : q.url;
  const target = validateUrl(rawUrl);
  if (!target) {
    console.error("url invalid:", rawUrl);
    return sendError(res, 400, {});
  }
  console.log("url:", target.href);

  const cacheKey = target.href;
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    console.log("use cache");
    return sendSuccess(res, hit.data);
  }
  if (hit) cache.delete(cacheKey);

  main(cacheKey, maxRedirects(), Date.now() + requestTimeoutMs(), (err, data) => {
    if (err) {
      console.error("error:", err.message);
      return sendError(res, err.statusCode || 502, {});
    }
    if (Object.keys(data).length > 0) {
      data.url = cacheKey;
      setCache(cacheKey, data);
    }
    sendSuccess(res, data);
  });
}

module.exports = handler;
module.exports.checkHostSafe = checkHostSafe;
