// src/tools/web/fetch.js
//
// Direct URL fetcher (page content to text/markdown/HTML).
//
// Unlike nano's old Serper-based scraper (API key + credits per call), this
// fetches pages directly: no key, no quota. HTML becomes markdown (turndown)
// or plain text (htmlparser2, scripts/styles skipped); images become stored
// attachments exactly like read-tool images (see read/media.js).

import { Parser } from "htmlparser2";
import TurndownService from "turndown";
import dns from "node:dns/promises";
import net from "node:net";
import { IMAGE_MIMES, formatBytes, saveAttachment } from "#src/tools/shared/attachments.js";

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30 * 1000;
const MAX_TIMEOUT_MS = 120 * 1000;

const FORMATS = ["text", "markdown", "html"];

export const webFetchTool = {
  type: "function",
  name: "webFetch",
  description:
    "Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default. " +
    "Use this when the user provides a specific URL, or a URL came from webSearch. " +
    "Do not use webFetch to discover URLs (use webSearch), or when you already have the information. " +
    "Only fetch URLs relevant to the current task; do not fetch pages unnecessarily. " +
    "Large responses are capped at 5MB.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      url: {
        type: "string",
        description: "The HTTP or HTTPS URL to fetch content from.",
      },
      format: {
        type: "string",
        enum: FORMATS,
        description: "The format to return the content in (default: markdown).",
      },
      timeout: {
        type: "number",
        description: "Optional timeout in seconds (default 30, max 120).",
      },
    },
    required: ["url"],
  },
};

function fail(error) {
  return { success: false, error };
}

function acceptHeaderFor(format) {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
    default:
      return "*/*";
  }
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// SSRF guard. The model fetches attacker-influenced URLs, so private targets
// must be refused: loopback, RFC 1918 LANs, link-local (including the cloud
// instance-metadata address 169.254.169.254), and unique-local/multicast.
// Hostnames are DNS-resolved and every returned address is checked.
// Known limitation: DNS is re-resolved at connect time (TOCTOU). A hostile
// DNS that flips answers mid-request can bypass this, which only a custom
// socket layer would close — documented, accepted risk for this agent.
// ---------------------------------------------------------------------------
const MAX_REDIRECTS = 5;

function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function inCidr(ipInt, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (base & mask);
}

function isPrivateIPv4(ip) {
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) unwraps to the same checks.
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const value = ipv4ToInt(mapped ? mapped[1] : ip);
  if (value === null) return false;
  return (
    inCidr(value, ipv4ToInt("127.0.0.0"), 8) || // loopback
    inCidr(value, ipv4ToInt("10.0.0.0"), 8) ||
    inCidr(value, ipv4ToInt("172.16.0.0"), 12) ||
    inCidr(value, ipv4ToInt("192.168.0.0"), 16) ||
    inCidr(value, ipv4ToInt("169.254.0.0"), 16) || // link-local + cloud metadata
    inCidr(value, ipv4ToInt("224.0.0.0"), 4) || // multicast
    value === 0xffffffff // broadcast
  );
}

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local
  if (lower.startsWith("ff")) return true; // multicast
  return false;
}

function isPrivateIP(ip) {
  if (typeof ip !== "string" || ip === "") return false;
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip) || isPrivateIPv4(ip);
  return false;
}

/**
 * Refuse non-public targets. Set allowLoopback only in tests against local
 * servers — never from tool parameters. Loopback stays permitted there, but
 * every other private range (LAN, link-local, cloud metadata) is still
 * blocked, so redirect-escape tests remain meaningful.
 */
export async function assertPublicUrl(rawUrl, { allowLoopback = false } = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Parameter 'url' must be a valid URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Parameter 'url' must start with http:// or https://.");
  }
  // URL.hostname keeps IPv6 brackets ("[::1]"); strip them once so every
  // check below sees a plain address.
  const host = parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (allowLoopback) {
    const loopback =
      host === "localhost" ||
      host === "localhost." ||
      (net.isIPv4(host) && inCidr(ipv4ToInt(host), ipv4ToInt("127.0.0.0"), 8)) ||
      host === "::1";
    if (loopback) return parsed;
  }
  if (host === "localhost" || host === "localhost.") {
    // Never depend on DNS for this: localhost is loopback by definition.
    throw new Error("Refusing to fetch non-public address: localhost.");
  }
  if (isPrivateIP(host)) {
    throw new Error(`Refusing to fetch non-public address: ${host}.`);
  }
  // Hostnames can hide private addresses (DNS rebinding, intranet names).
  let addresses = [];
  try {
    const [v4, v6] = await Promise.all([
      dns.resolve4(host).catch(() => []),
      dns.resolve6(host).catch(() => []),
    ]);
    addresses = [...v4, ...v6];
  } catch {
    throw new Error(`Cannot resolve host: ${host}.`);
  }
  const blocked = addresses.find((address) => isPrivateIP(address));
  if (blocked) {
    throw new Error(`Refusing to fetch: ${host} resolves to non-public address ${blocked}.`);
  }
  return parsed;
}

// Plain-text extraction: drops scripts, styles, and embeds entirely.
function extractTextFromHTML(html) {
  let text = "";
  let skipDepth = 0;
  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) {
        skipDepth++;
      }
    },
    ontext(input) {
      if (skipDepth === 0) text += input;
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth--;
    },
  });
  parser.write(html);
  parser.end();
  return text.trim();
}

function convertHTMLToMarkdown(html) {
  const turndown = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });
  turndown.remove(["script", "style", "meta", "link"]);
  return turndown.turndown(html);
}

async function fetchWithTimeout(url, headers, timeoutMs, signal) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  try {
    // Manual redirects: every hop is re-validated by the SSRF guard, so a
    // benign URL cannot bounce into the intranet mid-request.
    return await fetch(url, { headers, signal: combined, redirect: "manual" });
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") {
      throw new Error("Request was aborted.");
    }
    if (error?.name === "TimeoutError") {
      const label = timeoutMs < 1000 ? `${timeoutMs} ms` : `${Math.round(timeoutMs / 1000)} seconds`;
      throw new Error(`Request timed out after ${label}.`);
    }
    throw new Error(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Fetch one URL, following redirects manually so every hop passes the SSRF
 * guard. Exported for unit tests (local servers need allowPrivate).
 */
export async function fetchUrl(url, { headers, timeoutMs, signal, allowLoopback = false } = {}) {
  if (typeof url !== "string" || url === "") {
    throw new Error("Parameter 'url' must be a non-empty string.");
  }
  let current = url;
  await assertPublicUrl(current, { allowLoopback });
  let response = await fetchWithTimeout(current, headers, timeoutMs, signal);
  let hops = 0;
  while (isRedirect(response.status) && hops < MAX_REDIRECTS) {
    const location = response.headers.get("location");
    if (!location) break;
    await response.arrayBuffer().catch(() => {});
    current = new URL(location, current).toString();
    await assertPublicUrl(current, { allowLoopback });
    response = await fetchWithTimeout(current, headers, timeoutMs, signal);
    hops++;
  }
  if (isRedirect(response.status)) {
    throw new Error(`Too many redirects (over ${MAX_REDIRECTS}) starting from ${url}.`);
  }
  return { response, url: current };
}

export async function webFetch(params = {}, context = {}) {
  try {
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      return fail("Parameters must be an object with 'url' and optional 'format' and 'timeout'.");
    }
    const { url, format = "markdown", timeout = 30 } = params;
    if (typeof url !== "string" || url.trim() === "") {
      return fail("Parameter 'url' must be a non-empty string.");
    }
    if (!FORMATS.includes(format)) {
      return fail(`Parameter 'format' must be one of: ${FORMATS.join(", ")}.`);
    }
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 || timeout > 120) {
      return fail("Parameter 'timeout' must be a number of seconds between 1 and 120.");
    }
    const timeoutMs = Math.min(timeout * 1000, MAX_TIMEOUT_MS);

    const headers = {
      "User-Agent": BROWSER_UA,
      Accept: acceptHeaderFor(format),
      "Accept-Language": "en-US,en;q=0.9",
    };

    let fetched;
    try {
      fetched = await fetchUrl(url, { headers, timeoutMs, signal: context.signal });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    let { response, url: current } = fetched;
    if (!response.ok) {
      // Cloudflare sometimes challenges non-browser TLS fingerprints with a
      // 403; retry once with an honest bot UA.
      const mitigated = response.headers.get("cf-mitigated");
      if (response.status === 403 && mitigated === "challenge") {
        response = await fetchWithTimeout(current, { ...headers, "User-Agent": "nano-agent/1.0" }, timeoutMs, context.signal);
      }
      if (!response.ok) {
        return fail(`Fetch failed with HTTP ${response.status} for ${current}.`);
      }
    }

    const declared = response.headers.get("content-length");
    if (declared && Number.parseInt(declared, 10) > MAX_RESPONSE_SIZE) {
      return fail("Response too large (exceeds 5MB limit).");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_RESPONSE_SIZE) {
      return fail("Response too large (exceeds 5MB limit).");
    }
    if (bytes.length === 0) {
      return { success: true, output: "(empty response)", format };
    }

    const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();

    if (IMAGE_MIMES.has(contentType)) {
      try {
        const attachment = await saveAttachment(bytes, contentType);
        return {
          success: true,
          output: `Image fetched successfully (${formatBytes(bytes.length)}, ${contentType}).`,
          attachments: [attachment],
          format,
        };
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    }

    const content = new TextDecoder().decode(bytes);
    if (format === "html") {
      return { success: true, output: content, format };
    }
    if (contentType.includes("text/html")) {
      const output = format === "text" ? extractTextFromHTML(content) : convertHTMLToMarkdown(content);
      return { success: true, output: output.trim() === "" ? "(page contains no readable text)" : output, format };
    }
    return { success: true, output: content, format };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
