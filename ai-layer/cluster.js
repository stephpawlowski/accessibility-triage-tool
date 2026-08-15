/**
 * Task 2: AI clustering / prioritization / ticket-drafting layer.
 *
 * Takes the raw axe-core violations JSON produced by ../poc/poc.js and
 * turns it into the thing a free scanner doesn't give you: violations
 * grouped by shared root cause, ranked by real-world impact, each with a
 * ready-to-file ticket.
 *
 * Design choices, and why:
 *
 * - Claude does the CLUSTERING and the TICKET WRITING (both genuinely need
 *   judgment: "are these two violations actually the same underlying bug"
 *   is a semantic question a simple string match on CSS selectors would
 *   get wrong, Squarespace's auto-generated block IDs are a good example).
 *
 * - Claude does NOT invent the priority ranking. The priority score is
 *   computed deterministically in code from axe-core's own severity rating
 *   and the size of each cluster. This matches the same reasoning that
 *   picked axe-core over pure AI vision in task 1: don't let the model
 *   guess at something that can be computed and defended instead.
 *
 * - Clusters reference violating nodes by INDEX into a flattened list,
 *   not by re-typing selectors. This keeps the model from having to
 *   reproduce long exact strings (a common source of drift/hallucination)
 *   and keeps the request/response smaller.
 *
 * Zero npm dependencies on purpose, uses Node's built-in fetch, so there's
 * nothing to `npm install` for this step.
 *
 * Usage:
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   node cluster.js ../poc/out/violations.json
 *
 * Output:
 *   ./out/triage.json
 */

const fs = require("fs");
const path = require("path");

const MODEL = "claude-sonnet-5";
const SEVERITY_WEIGHT = { critical: 4, serious: 3, moderate: 2, minor: 1 };

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

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: node cluster.js <path-to-violations.json>");
    process.exit(1);
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Set ANTHROPIC_API_KEY first.");
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(inputPath, "utf8"));

  // Flatten: one entry per violating node. `flatNodes` carries everything,
  // including boundingBox, since the frontend needs that later to draw
  // overlays. `nodesForModel` is a trimmed view (no boundingBox, no point
  // spending tokens on numbers Claude doesn't need to reason about).
  const flatNodes = [];
  for (const violation of raw.violations) {
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
  const nodesForModel = flatNodes.map(({ boundingBox, ...rest }) => rest);

  console.log(`Sending ${flatNodes.length} violating nodes to ${MODEL}...`);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Page scanned: ${raw.url}\n\nViolating nodes (0-indexed):\n${JSON.stringify(
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
    throw new Error(`API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const usage = data.usage;
  const toolUse = data.content.find((b) => b.type === "tool_use");
  if (!toolUse) {
    throw new Error("Model didn't return the expected tool call.");
  }

  const { clusters } = toolUse.input;

  // --- Validate: every index appears exactly once. Don't just trust the model. ---
  const seen = new Map();
  for (const cluster of clusters) {
    for (const idx of cluster.node_indices) {
      seen.set(idx, (seen.get(idx) || 0) + 1);
    }
  }
  const missing = flatNodes
    .map((n) => n.index)
    .filter((i) => !seen.has(i));
  const duplicated = [...seen.entries()].filter(([, count]) => count > 1);

  if (missing.length > 0) {
    console.warn(
      `WARNING: ${missing.length} node(s) not assigned to any cluster: ${missing.join(", ")}`
    );
  }
  if (duplicated.length > 0) {
    console.warn(
      `WARNING: ${duplicated.length} node(s) assigned to more than one cluster: ${duplicated
        .map(([i, c]) => `${i} (x${c})`)
        .join(", ")}`
    );
  }

  // --- Deterministic priority score: severity x reach. Not model-generated. ---
  const enrichedClusters = clusters.map((cluster) => {
    const nodes = cluster.node_indices
      .map((i) => flatNodes[i])
      .filter(Boolean);
    const reach = nodes.length;
    const worstImpact = nodes.reduce((worst, n) => {
      const w = SEVERITY_WEIGHT[n.impact] || 0;
      return w > (SEVERITY_WEIGHT[worst] || 0) ? n.impact : worst;
    }, nodes[0]?.impact || "minor");
    const priority_score = (SEVERITY_WEIGHT[worstImpact] || 1) * reach;

    return {
      ...cluster,
      reach,
      worst_impact: worstImpact,
      priority_score,
      nodes, // full original node data, for the frontend to draw overlays from later
    };
  });

  enrichedClusters.sort((a, b) => b.priority_score - a.priority_score);

  const outDir = path.join(__dirname, "out");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "triage.json");
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        url: raw.url,
        scannedAt: raw.scannedAt,
        totalNodes: flatNodes.length,
        totalClusters: enrichedClusters.length,
        validation: {
          unassignedNodes: missing,
          duplicateAssignments: duplicated.map(([i, c]) => ({ index: i, count: c })),
        },
        usage,
        clusters: enrichedClusters,
      },
      null,
      2
    )
  );

  console.log(`\n--- Summary ---`);
  console.log(`${flatNodes.length} violating nodes -> ${enrichedClusters.length} clusters`);
  for (const c of enrichedClusters) {
    console.log(
      `  [${c.priority_score}] ${c.cluster_title} (${c.reach} node${c.reach === 1 ? "" : "s"}, ${c.worst_impact})`
    );
  }
  console.log(
    `\nTokens: ${usage.input_tokens} in / ${usage.output_tokens} out`
  );
  console.log(`Wrote ${outPath}`);
}

function truncate(str, n) {
  if (!str) return str;
  return str.length > n ? str.slice(0, n) + "..." : str;
}

main().catch((err) => {
  console.error("cluster.js failed:", err);
  process.exit(1);
});
