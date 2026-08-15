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

const MODEL = "claude-sonnet-5";
const SEVERITY_WEIGHT = { critical: 4, serious: 3, moderate: 2, minor: 1 };
const AXE_CORE_URL =
  "https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js";
const RATE_LIMIT_PER_HOUR = 5; // conservative: free tier is 10 browser-minutes/day total, shared across all visitors
const VIEWPORT = { width: 1280, height: 900 };
const GOTO_TIMEOUT_MS = 25000;

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

Every node index must appear in exactly one cluster. Do not invent node indices that weren't provided. Be specific in fixes and tickets, reference actual values (colors, sizes) from the data rather than generic advice.`;

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
      console.error("Scan failed:", err);
      return withCors(
        jsonResponse({ error: `Scan failed: ${err.message}` }, 500)
      );
    }
  },
};

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

async function runScan(targetUrl, env) {
  const axeSource = await getAxeSource();

  // protocolTimeout raised from Puppeteer's default: Browser Rendering's
  // first connection (cold start) can take longer than the default allows,
  // this is a known rough edge, not specific to this Worker's code.
  const browser = await puppeteer.launch(env.MYBROWSER, {
    protocolTimeout: 120000,
  });
  let violations;
  let screenshotBase64;
  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.goto(targetUrl, {
      waitUntil: "networkidle0",
      timeout: GOTO_TIMEOUT_MS,
    });

    await page.evaluate(axeSource);
    const results = await page.evaluate(async () => {
      // eslint-disable-next-line no-undef
      return await axe.run(document, { resultTypes: ["violations"] });
    });
    violations = results.violations;

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

    screenshotBase64 = await page.screenshot({
      fullPage: true,
      encoding: "base64",
    });
  } finally {
    await browser.close();
  }

  const flatNodes = [];
  for (const violation of violations) {
    for (const node of violation.nodes) {
      flatNodes.push({
        index: flatNodes.length,
        rule_id: violation.id,
        impact: violation.impact,
        help: violation.help,
        target: node.target,
        html: truncate(node.html, 200),
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

async function getAxeSource() {
  if (cachedAxeSource) return cachedAxeSource;
  const res = await fetch(AXE_CORE_URL);
  if (!res.ok) throw new Error("Couldn't load axe-core from CDN.");
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
      max_tokens: 4096,
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
    throw new Error(`Claude API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const toolUse = data.content.find((b) => b.type === "tool_use");
  if (!toolUse) throw new Error("Model didn't return the expected tool call.");

  const { clusters } = toolUse.input;

  const enrichedClusters = clusters.map((cluster) => {
    const nodes = cluster.node_indices.map((i) => flatNodes[i]).filter(Boolean);
    const reach = nodes.length;
    const worstImpact = nodes.reduce((worst, n) => {
      const w = SEVERITY_WEIGHT[n.impact] || 0;
      return w > (SEVERITY_WEIGHT[worst] || 0) ? n.impact : worst;
    }, nodes[0]?.impact || "minor");
    const priority_score = (SEVERITY_WEIGHT[worstImpact] || 1) * reach;
    return { ...cluster, reach, worst_impact: worstImpact, priority_score, nodes };
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
