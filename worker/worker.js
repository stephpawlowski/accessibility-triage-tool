/**
 * DUPLICATED LOGIC WARNING: this Worker re-implements the scanning logic
 * from ../poc/poc.js and the clustering logic from ../ai-layer/cluster.js.
 * Workers can't import from the rest of a Node repo, so this is a hand
 * ported copy, not a shared module. If either of those scripts change,
 * this file needs the same change made manually.
 *
 * Ported from the two validated local scripts:
 *   - poc/poc.js       -> the axe-core scan + bounding box logic (task 1)
 *   - ai-layer/cluster.js -> the Claude clustering/ticket logic (task 2)
 *
 * Differences from the local versions, and why:
 *   - puppeteer -> @cloudflare/puppeteer, launched against the Browser
 *     Rendering binding (env.MYBROWSER) instead of a local Chromium.
 *   - axe-core is fetched from a CDN at request time instead of read from
 *     node_modules, Workers can't read local files the way Node can.
 *   - Screenshot is requested as base64 directly (`encoding: "base64"`)
 *     rather than written to disk, then returned inline in the JSON
 *     response for the frontend to render.
 *   - Adds CORS handling, rate limiting via KV, and URL validation, none
 *     of which the local POC/CLI scripts needed.
 */

import puppeteer from "@cloudflare/puppeteer";

// Thrown deliberately, wherever the code already knows exactly what went
// wrong and how to explain it to a visitor. The top-level handler passes
// these messages straight through. Anything else that reaches the top level
// gets pattern-matched against known failure signatures instead, see
// classifyScanError below, since raw Puppeteer/CDP/fetch error text is not
// something a non-technical visitor should ever see directly.
class UserFacingError extends Error {}

const MODEL = "claude-sonnet-5";
const SEVERITY_WEIGHT = { critical: 4, serious: 3, moderate: 2, minor: 1 };
const AXE_CORE_URL =
  "https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js";
const RATE_LIMIT_PER_HOUR = 5; // conservative: free tier is 10 browser-minutes/day total, shared across all visitors
const VIEWPORT = { width: 1280, height: 900 };
const GOTO_TIMEOUT_MS = 35000;
// Time to let a page settle after DOMContentLoaded before scanning, gives
// client-rendered content a chance to finish painting.
const SETTLE_MS = 2000;

// Reused across requests within the same Worker isolate, avoids re-fetching
// axe-core's ~700KB source on every single scan.
let cachedAxeSource = null;

const TOOL_SCHEMA = {
  name: "return_triage",
  description:
    "Return the violating nodes grouped into clusters by shared root cause, with a drafted ticket per cluster.",
  input_schema: {
    type: "object",
    properties: {
      clusters: {
        type: "array",
        items: {
          type: "object",
          properties: {
            cluster_title: {
              type: "string",
              description:
                "Short, specific name for the shared root cause, e.g. 'Secondary text color (#7a7d7f) fails contrast against white'. Not the axe rule name.",
            },
            root_cause_explanation: {
              type: "string",
              description:
                "One or two sentences: what specifically ties these nodes together (same color token, same component, same missing pattern), in plain language.",
            },
            node_indices: {
              type: "array",
              items: { type: "integer" },
              description:
                "0-based indices into the provided node list that belong to this cluster. Every node must end up in exactly one cluster. Do not group nodes together just because they share an axe rule id if the actual cause differs (e.g. two different failing colors are two different clusters even if both are 'color-contrast').",
            },
            suggested_fix: {
              type: "string",
              description:
                "Concrete, specific fix. Reference the actual failing value (e.g. the hex color and what it should become) when the data provides one, not generic advice.",
            },
            caveat: {
              type: "string",
              description:
                "Optional. Only include this if one or more nodes in this cluster has a non-null decorativeSignal. Note plainly which signal(s) were found (e.g. aria-hidden=\"true\", role=\"presentation\"). The site's own developers already excluded that element from assistive tech and/or keyboard navigation, so it may be decorative (e.g. part of an illustrative graphic or animation) rather than a real interactive control, even though it still fails a visual check like color-contrast. Omit this field entirely when no node in the cluster has a decorativeSignal. Never use this as a reason to drop or downweight the node, only to flag it for human review.",
            },
            ticket: {
              type: "object",
              properties: {
                title: { type: "string" },
                description: { type: "string" },
                acceptance_criteria: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: ["title", "description", "acceptance_criteria"],
            },
          },
          required: [
            "cluster_title",
            "root_cause_explanation",
            "node_indices",
            "suggested_fix",
            "ticket",
          ],
        },
      },
    },
    required: ["clusters"],
  },
};

const SYSTEM_PROMPT = `You are an accessibility engineering lead triaging automated WCAG scan results for a product team, not writing a report for an accessibility specialist.

You will receive a flattened list of individual violating DOM nodes found by axe-core on a single page. Group them into clusters that share the same underlying root cause, meaning instances that a single code change would fix: the same reused component, the same CSS class, the same color token, the same missing pattern.

Do not cluster purely by axe rule id. Two nodes can fail the same rule for genuinely different reasons (e.g. two different text colors both failing color-contrast against different thresholds), and those are two different clusters, not one. Conversely, nodes with different exact selectors can still be the same real bug if they clearly share a color, a component, or a pattern.

Every node index must appear in exactly one cluster. Do not invent node indices that weren't provided. Be specific in fixes and tickets, reference actual values (colors, sizes) from the data rather than generic advice.

Each node includes a decorativeSignal field, precomputed against the element's full (untruncated) HTML. It lists things like aria-hidden="true", tabindex="-1", role="presentation"/"none", or inert when present, or is null when none apply. These mean the site's own developers already excluded that element from assistive technology and/or keyboard navigation on purpose, so it is likely decorative (part of an illustrative graphic, animation, or embedded mockup) rather than a real interactive control, even though it can still fail a purely visual check like color-contrast. When decorativeSignal is non-null for some or all nodes in a cluster, still cluster and report the node normally, but add a short caveat naming the specific signal(s) found, so a human can judge whether it is worth fixing. Never use this as a reason to drop, exclude, or downweight a node, only to flag it.`;

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);
    if (url.pathname !== "/scan" || request.method !== "POST") {
      return withCors(jsonResponse({ error: "Not found." }, 404));
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return withCors(jsonResponse({ error: "Invalid JSON body." }, 400));
    }

    const validationError = validateUrl(body.url);
    if (validationError) {
      return withCors(jsonResponse({ error: validationError }, 400));
    }

    // Rate limit is checked after basic validation, on purpose: a malformed
    // request or a typo'd URL never touches a real browser session, so it
    // shouldn't cost a visitor part of their hourly quota. Anything that
    // gets this far is about to attempt a real (costly) scan, success or
    // failure, so it counts.
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const rateLimitError = await checkRateLimit(ip, env);
    if (rateLimitError) {
      return withCors(jsonResponse({ error: rateLimitError }, 429));
    }

    try {
      const result = await runScan(body.url, env);
      return withCors(jsonResponse(result, 200));
    } catch (err) {
      // Full detail (including the original cause, if this is a wrapped
      // error) always goes to the server-side log. Only the classified
      // message goes back to the visitor.
      console.error("Scan failed:", err);
      if (err.cause) console.error("Caused by:", err.cause);
      return withCors(
        jsonResponse({ error: classifyScanError(err) }, 500)
      );
    }
  },
};

// --- Error classification ---------------------------------------------------
// Maps the many ways a scan can fail to an accurate, specific, non-technical
// message. Order matters, first match wins, most specific patterns first.

function classifyScanError(err) {
  if (err instanceof UserFacingError) return err.message;

  const msg = err.message || "";

  if (/unable to create new browser|too many requests/i.test(msg)) {
    return "This tool has hit its scanning capacity for right now (a shared limit across all visitors, not just you). Try again in a few minutes.";
  }
  if (/navigation timeout/i.test(msg)) {
    return "That page took too long to load. It may be slow, or stuck loading something in the background. Try again, or try a lighter page on the same site.";
  }
  if (/err_name_not_resolved/i.test(msg)) {
    return "Couldn't find that site. Double-check the URL is correct.";
  }
  if (/err_connection_refused|err_connection_reset|err_connection_closed/i.test(msg)) {
    return "Couldn't connect to that site. It may be down or refusing connections from outside browsers.";
  }
  if (/err_connection_timed_out/i.test(msg)) {
    return "Connecting to that site timed out. It may be slow or temporarily unreachable.";
  }
  if (/err_cert_|err_ssl_/i.test(msg)) {
    return "That site's HTTPS certificate couldn't be verified, so the scan was stopped for safety.";
  }
  if (/err_too_many_redirects/i.test(msg)) {
    return "That URL redirects in a loop and never reaches a real page.";
  }
  if (/net::err_/i.test(msg)) {
    return "Couldn't load that page (a network-level error on the target site's end, not this tool).";
  }
  if (/cannot take screenshot|screenshot.*(too large|exceeds|dimension)/i.test(msg)) {
    return "This page is too long to capture in a single screenshot. Try a lighter page, or a specific section rather than the full homepage.";
  }
  if (/couldn't load axe-core/i.test(msg)) {
    return "Couldn't load the scanning engine from its CDN just now. Try again in a moment.";
  }

  // Genuinely unrecognized, don't guess, but also don't leak raw
  // Puppeteer/CDP internals to a visitor.
  return "Something went wrong scanning that page. Try again, or try a different URL.";
}

// --- Rate limiting ---------------------------------------------------------

async function checkRateLimit(ip, env) {
  // Prefixed so this project's rate limit can't collide with another
  // project's keys if this KV namespace ends up shared/reused across Workers.
  const key = `a11y-triage:rate:${ip}`;
  const current = parseInt((await env.RATE_LIMIT_KV_2.get(key)) || "0", 10);
  if (current >= RATE_LIMIT_PER_HOUR) {
    return `Rate limit reached (${RATE_LIMIT_PER_HOUR}/hour per visitor). Try again later.`;
  }
  await env.RATE_LIMIT_KV_2.put(key, String(current + 1), {
    expirationTtl: 3600,
  });
  return null;
}

// --- Input validation (basic SSRF guardrails) -------------------------------
// This endpoint fetches whatever URL a visitor types, server-side. Block the
// obvious ways that could be pointed at internal/private infrastructure
// instead of a real public site. Not exhaustive, but blocks the easy cases.

function validateUrl(raw) {
  if (!raw || typeof raw !== "string") return "Missing url.";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "Not a valid URL.";
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return "Only http/https URLs are allowed.";
  }
  const hostname = parsed.hostname.toLowerCase();
  if (["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(hostname)) {
    return "That host isn't allowed.";
  }
  // Private IP ranges (RFC1918) and the link-local/cloud-metadata range.
  if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(hostname)) {
    return "That host isn't allowed.";
  }
  return null;
}

// --- Scan + cluster ----------------------------------------------------------

// Matches the various ways Puppeteer/CDP report a page or session
// disappearing out from under an in-flight command: a redirect that tears
// down the JS context, the renderer crashing, or the whole browser session
// closing. Not informative to a visitor on its own, see runScan below for
// how this gets classified into a clearer message.
const TARGET_LOST_ERROR = /target closed|execution context was destroyed|detached frame|session closed/i;

async function runScan(targetUrl, env) {
  const axeSource = await getAxeSource();

  // protocolTimeout raised from Puppeteer's default: Browser Rendering's
  // first connection (cold start) can take longer than the default
  // allows, this is a known rough edge, not specific to this Worker's
  // code.
  const browser = await puppeteer.launch(env.MYBROWSER, {
    protocolTimeout: 120000,
  });

  // Puppeteer fires the page's "error" event specifically when the
  // renderer process itself crashes (e.g. out of memory on a very heavy
  // page), distinct from a normal navigation or a deliberately closed tab.
  // If we see this fire, a later "target closed" style failure can be
  // reported as a real resource crash instead of a generic error. If it
  // never fires but the target still closes, that's more consistent with
  // something external ending the session (a site's bot detection, or the
  // browser platform reclaiming it), so it gets a different message.
  let rendererCrashed = false;

  try {
    const page = await browser.newPage();
    page.on("error", () => {
      rendererCrashed = true;
    });
    await page.setViewport(VIEWPORT);
    await navigateAndSettle(page, targetUrl);
    const { violations, screenshotBase64 } = await scanPage(page, axeSource);
    return await buildScanResult(targetUrl, violations, screenshotBase64, env);
  } catch (err) {
    if (TARGET_LOST_ERROR.test(err.message || "")) {
      if (rendererCrashed) {
        throw new UserFacingError(
          "This page is too resource-heavy to scan right now (the browser ran out of memory partway through). Try again, or try a lighter page on the same site.",
          { cause: err }
        );
      }
      throw new UserFacingError(
        "This site appears to block automated browser scanning, which some sites do deliberately (bot/anti-automation protection). Try a different URL.",
        { cause: err }
      );
    }
    throw err;
  } finally {
    await browser.close();
  }
}

// Signals that the site's own developers already excluded this element from
// assistive tech and/or keyboard navigation, meaning it's likely decorative
// (an illustrative graphic, animation, or mockup) rather than a real
// interactive control, even though it can still fail a purely visual check
// like color-contrast. Checked against the FULL node.html, not the truncated
// version below, so a long class list or many preceding attributes can't
// push the signal past a length cutoff and silently hide it from the model.
function detectDecorativeSignal(html) {
  if (!html) return null;
  const signals = [];
  if (/\baria-hidden\s*=\s*["']true["']/i.test(html)) signals.push('aria-hidden="true"');
  if (/\btabindex\s*=\s*["']-1["']/i.test(html)) signals.push('tabindex="-1"');
  if (/\brole\s*=\s*["'](?:presentation|none)["']/i.test(html)) signals.push('role="presentation"/"none"');
  if (/(?:^|\s)inert(?=\s|=|>|$)/i.test(html)) signals.push("inert");
  return signals.length ? signals.join(", ") : null;
}

async function buildScanResult(targetUrl, violations, screenshotBase64, env) {
  const flatNodes = [];
  for (const violation of violations) {
    for (const node of violation.nodes) {
      flatNodes.push({
        index: flatNodes.length,
        rule_id: violation.id,
        impact: violation.impact,
        help: violation.help,
        target: node.target,
        html: truncate(node.html, 300),
        decorativeSignal: detectDecorativeSignal(node.html),
        failureSummary: node.failureSummary,
        boundingBox: node.boundingBox,
      });
    }
  }

  const scannedAt = new Date().toISOString();

  if (flatNodes.length === 0) {
    return {
      url: targetUrl,
      scannedAt,
      screenshot: screenshotBase64,
      triage: { totalNodes: 0, totalClusters: 0, clusters: [] },
    };
  }

  const nodesForModel = flatNodes.map(({ boundingBox, ...rest }) => rest);
  const clusters = await clusterWithClaude(targetUrl, nodesForModel, flatNodes, env);

  return {
    url: targetUrl,
    scannedAt,
    screenshot: screenshotBase64,
    triage: {
      totalNodes: flatNodes.length,
      totalClusters: clusters.length,
      clusters,
    },
  };
}

async function navigateAndSettle(page, targetUrl) {
  // "load" (all initial resources finished) is more reliable than
  // "networkidle*" for arbitrary real-world sites: pages with any
  // persistent connection (analytics, chat widgets, live dashboards) never
  // go network-idle and would time out even after finishing their visible
  // load. The settle window afterward gives client-side redirects/hydration
  // a chance to happen before we start evaluating against the page.
  const response = await page.goto(targetUrl, {
    waitUntil: "load",
    timeout: GOTO_TIMEOUT_MS,
  });

  // page.goto doesn't throw on a 4xx/5xx response, the navigation itself
  // still "succeeds," it just lands on an error page. Surface that clearly
  // rather than silently scanning a 404/500 page and reporting on whatever
  // (probably minimal, generic) violations that page happens to have.
  if (response && !response.ok()) {
    throw new UserFacingError(
      `That page returned a ${response.status()} instead of loading normally. Double-check the URL.`
    );
  }

  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
}

async function scanPage(page, axeSource) {
  await page.evaluate(axeSource);
  const results = await page.evaluate(async () => {
    // eslint-disable-next-line no-undef
    return await axe.run(document, { resultTypes: ["violations"] });
  });
  const violations = results.violations;

  for (const violation of violations) {
    for (const node of violation.nodes) {
      const selector = flattenTarget(node.target);
      node.boundingBox = selector
        ? await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) return null;
            return {
              x: Math.round(r.x),
              y: Math.round(r.y),
              width: Math.round(r.width),
              height: Math.round(r.height),
            };
          }, selector)
        : null;
    }
  }

  const screenshotBase64 = await page.screenshot({
    fullPage: true,
    encoding: "base64",
  });

  return { violations, screenshotBase64 };
}

async function getAxeSource() {
  if (cachedAxeSource) return cachedAxeSource;
  const res = await fetch(AXE_CORE_URL);
  if (!res.ok) {
    throw new UserFacingError(
      "Couldn't load the scanning engine from its CDN just now. Try again in a moment.",
      { cause: new Error(`axe-core CDN fetch failed: ${res.status}`) }
    );
  }
  cachedAxeSource = await res.text();
  return cachedAxeSource;
}

async function clusterWithClaude(targetUrl, nodesForModel, flatNodes, env) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Page scanned: ${targetUrl}\n\nViolating nodes (0-indexed):\n${JSON.stringify(
            nodesForModel,
            null,
            2
          )}`,
        },
      ],
      tools: [TOOL_SCHEMA],
      tool_choice: { type: "tool", name: "return_triage" },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    const cause = new Error(`Claude API error ${response.status}: ${errText}`);
    if (response.status === 429) {
      throw new UserFacingError(
        "The AI service that drafts tickets is temporarily rate-limited. Try again in a minute.",
        { cause }
      );
    }
    if (response.status >= 500) {
      throw new UserFacingError(
        "The AI service that drafts tickets is temporarily unavailable. Try again shortly.",
        { cause }
      );
    }
    // 4xx other than 429 (auth, bad request, etc.) is a configuration
    // problem on this project's end, not something the visitor caused or
    // can act on.
    throw new UserFacingError(
      "Something's misconfigured generating the results for this scan. Try again, or check back later.",
      { cause }
    );
  }

  const data = await response.json();
  const toolUse = data.content.find((b) => b.type === "tool_use");
  if (!toolUse) {
    throw new UserFacingError(
      "Couldn't generate prioritized tickets for this scan's results. Try again.",
      { cause: new Error("Model didn't return the expected tool call.") }
    );
  }

  const { clusters } = toolUse.input;

  const enrichedClusters = clusters.map((cluster) => {
    const nodes = cluster.node_indices.map((i) => flatNodes[i]).filter(Boolean);
    const reach = nodes.length;
    const worstImpact = nodes.reduce((worst, n) => {
      const w = SEVERITY_WEIGHT[n.impact] || 0;
      return w > (SEVERITY_WEIGHT[worst] || 0) ? n.impact : worst;
    }, nodes[0]?.impact || "minor");
    const priority_score = (SEVERITY_WEIGHT[worstImpact] || 1) * reach;
    // Only boundingBox is ever used by the frontend (to draw the overlay
    // boxes on the screenshot). The rest of each flatNode (html, target,
    // failureSummary, help) is the scanned page's own raw markup/text, not
    // something this project generated, don't ship it to the browser just
    // because it's available server-side. Keeps the response minimal and
    // removes a latent stored-XSS surface for any future feature that might
    // render node data straight from the API response.
    const publicNodes = nodes.map((n) => ({ boundingBox: n.boundingBox }));
    return { ...cluster, reach, worst_impact: worstImpact, priority_score, nodes: publicNodes };
  });

  enrichedClusters.sort((a, b) => b.priority_score - a.priority_score);
  return enrichedClusters;
}

// --- Helpers -----------------------------------------------------------------

function flattenTarget(target) {
  if (!Array.isArray(target) || target.length !== 1) return null;
  if (typeof target[0] !== "string") return null;
  return target[0];
}

function truncate(str, n) {
  if (!str) return str;
  return str.length > n ? str.slice(0, n) + "..." : str;
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(response.body, { status: response.status, headers });
}
