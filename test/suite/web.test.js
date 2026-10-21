// test/suite/web.test.js
// Covers the rebuilt web tools. Live HTTP is exercised in manual and real-API
// tests; this suite stays offline: input validation plus the pure MCP
// response parser and provider selection (exercised with fixtures).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { webSearch } from "../../src/tools/web/search.js";
import { webFetch, fetchUrl, assertPublicUrl } from "../../src/tools/web/fetch.js";
import { parseMcpResponse, selectProvider } from "../../src/tools/web/mcp.js";
import { toolExecute } from "../../src/tools/executor.js";
import http from "node:http";

describe("webSearch validation", () => {
  it("rejects bad parameters without network access", async () => {
    assert.equal((await webSearch()).success, false);
    assert.equal((await webSearch({})).success, false);
    assert.equal((await webSearch({ query: "  " })).success, false);
    assert.equal((await webSearch({ query: "x", numResults: 0 })).success, false);
    assert.equal((await webSearch({ query: "x", numResults: 21 })).success, false);
    assert.equal((await webSearch({ query: "x", numResults: 2.5 })).success, false);
    assert.equal((await webSearch({ query: "x", type: "ultra" })).success, false);
    assert.equal((await webSearch({ query: "x", livecrawl: "always" })).success, false);
    assert.equal((await webSearch({ query: "x", contextMaxCharacters: 0 })).success, false);
    assert.equal((await webSearch("query")).success, false);
  });
});

describe("webFetch validation", () => {
  it("rejects bad parameters without network access", async () => {
    assert.equal((await webFetch()).success, false);
    assert.equal((await webFetch({})).success, false);
    assert.equal((await webFetch({ url: "  " })).success, false);
    assert.equal((await webFetch({ url: "not a url" })).success, false);
    const ftp = await webFetch({ url: "ftp://example.com/x" });
    assert.equal(ftp.success, false);
    assert.match(ftp.error, /http/);
    assert.equal((await webFetch({ url: "https://example.com", format: "pdf" })).success, false);
    assert.equal((await webFetch({ url: "https://example.com", timeout: 0 })).success, false);
    assert.equal((await webFetch({ url: "https://example.com", timeout: 999_999 })).success, false);
    assert.equal((await webFetch("https://example.com")).success, false);
  });
});

describe("SSRF guard", () => {
  it("refuses private targets without network access", async () => {
    for (const url of [
      "http://127.0.0.1/",
      "http://localhost:3060/",
      "http://10.1.2.3/",
      "http://172.16.0.9/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://[fc00::1]/",
      "ftp://example.com/x",
      "not a url",
    ]) {
      await assert.rejects(assertPublicUrl(url), /Refusing|must start|must be a valid URL/);
    }
    const parsed = await assertPublicUrl("https://example.com:8443/a?b=c");
    assert.equal(parsed.hostname, "example.com");
  });

  it("follows safe redirects and blocks private hops", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/hop1") {
        res.writeHead(302, { location: "/hop2" });
        res.end();
        return;
      }
      if (req.url === "/hop2") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("arrived");
        return;
      }
      if (req.url === "/evil") {
        res.writeHead(302, { location: "http://169.254.169.254/" });
        res.end();
        return;
      }
      if (req.url === "/loop") {
        res.writeHead(302, { location: "/loop" });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = {};
    try {
      const good = await fetchUrl(`${base}/hop1`, { headers, timeoutMs: 5000, allowLoopback: true });
      assert.equal(good.url, `${base}/hop2`);
      assert.equal(good.response.status, 200);
      await assert.rejects(fetchUrl(`${base}/evil`, { headers, timeoutMs: 5000, allowLoopback: true }), /non-public/);
      await assert.rejects(
        fetchUrl(`${base}/loop`, { headers, timeoutMs: 5000, allowLoopback: true }),
        /Too many redirects/,
      );
      // And the public tool itself refuses loopback outright.
      const direct = await webFetch({ url: `${base}/hop2` });
      assert.equal(direct.success, false);
      assert.match(direct.error, /non-public/);
    } finally {
      server.close();
    }
  });
});

describe("MCP response parser", () => {
  it("reads direct JSON bodies", () => {
    const body = JSON.stringify({ result: { content: [{ type: "text", text: "hello" }] } });
    assert.equal(parseMcpResponse(body), "hello");
  });

  it("reads SSE event streams and skips empty content", () => {
    const body = [
      'event: message',
      'data: {"result":{"content":[{"type":"text","text":""}]}}',
      'data: {"result":{"content":[{"type":"text","text":"world"}]}}',
      "",
    ].join("\n");
    assert.equal(parseMcpResponse(body), "world");
  });

  it("returns undefined for unreadable bodies", () => {
    assert.equal(parseMcpResponse(""), undefined);
    assert.equal(parseMcpResponse("not json"), undefined);
    assert.equal(parseMcpResponse('{"result":{}}'), undefined);
    assert.equal(parseMcpResponse(null), undefined);
  });
});

describe("search provider selection", () => {
  it("honours the environment override", () => {
    const previous = process.env.NANO_WEBSEARCH_PROVIDER;
    try {
      process.env.NANO_WEBSEARCH_PROVIDER = "parallel";
      assert.equal(selectProvider("any-session"), "parallel");
      process.env.NANO_WEBSEARCH_PROVIDER = "exa";
      assert.equal(selectProvider("any-session"), "exa");
    } finally {
      if (previous === undefined) delete process.env.NANO_WEBSEARCH_PROVIDER;
      else process.env.NANO_WEBSEARCH_PROVIDER = previous;
    }
  });

  it("splits sessions deterministically without an override", () => {
    const previous = process.env.NANO_WEBSEARCH_PROVIDER;
    try {
      delete process.env.NANO_WEBSEARCH_PROVIDER;
      const first = selectProvider("session-abc");
      assert.ok(first === "exa" || first === "parallel");
      assert.equal(selectProvider("session-abc"), first);
      assert.equal(selectProvider(""), "exa");
      assert.equal(selectProvider(undefined), "exa");
    } finally {
      if (previous === undefined) delete process.env.NANO_WEBSEARCH_PROVIDER;
      else process.env.NANO_WEBSEARCH_PROVIDER = previous;
    }
  });
});

describe("web tools via toolExecute", () => {
  it("reports unknown tools and bad JSON as before", async () => {
    const unknown = await toolExecute({ name: "nope", arguments: {} });
    assert.equal(unknown.success, false);
    const bad = await toolExecute({ name: "webSearch", arguments: "{oops" });
    assert.equal(bad.success, false);
  });
});
