/**
 * Proof of concept: run axe-core against a live URL in a real headless
 * browser, and get back both the raw violations AND pixel bounding boxes
 * for each violating element, so we can draw overlay boxes on a screenshot
 * later.
 *
 * This is written against local `puppeteer`, which has (almost) the exact
 * same API as Cloudflare's Browser Rendering product via `@cloudflare/puppeteer`.
 * Once this works locally, porting it into a Worker is mostly:
 *   - swap `puppeteer.launch()` for `puppeteer.launch(env.MYBROWSER)`
 *   - swap the local axe-core file read for a bundled/fetched copy
 * The actual scan + bounding-box logic below stays the same.
 *
 * Usage:
 *   node poc.js https://example.com
 *
 * Output:
 *   ./out/violations.json   -- axe-core violations, each node annotated
 *                               with a `boundingBox` (or null if not found)
 *   ./out/screenshot.png    -- viewport screenshot matching those coordinates
 */

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const VIEWPORT = { width: 1280, height: 900 };

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error("Usage: node poc.js <url>");
    process.exit(1);
  }

  const outDir = path.join(__dirname, "out");
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Launching browser...`);
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);

    console.log(`Navigating to ${url}...`);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    console.log(`Injecting axe-core...`);
    const axeSource = fs.readFileSync(
      require.resolve("axe-core/axe.min.js"),
      "utf8"
    );
    await page.evaluate(axeSource);

    console.log(`Running axe.run()...`);
    const results = await page.evaluate(async () => {
      // eslint-disable-next-line no-undef
      return await axe.run(document, {
        resultTypes: ["violations"],
      });
    });

    console.log(
      `Found ${results.violations.length} violation types. Computing bounding boxes...`
    );

    // Annotate each violating node with a pixel bounding box, computed
    // against the same viewport we're about to screenshot.
    for (const violation of results.violations) {
      for (const node of violation.nodes) {
        const selector = flattenTarget(node.target);
        if (!selector) {
          node.boundingBox = null;
          continue;
        }
        try {
          node.boundingBox = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            // Skip elements with no visible box (display:none etc).
            if (r.width === 0 && r.height === 0) return null;
            return {
              x: Math.round(r.x),
              y: Math.round(r.y),
              width: Math.round(r.width),
              height: Math.round(r.height),
            };
          }, selector);
        } catch (err) {
          node.boundingBox = null;
        }
      }
    }

    console.log(`Taking screenshot...`);
    await page.screenshot({
      path: path.join(outDir, "screenshot.png"),
      // Full-page, not viewport-only. Bounding boxes were measured via
      // getBoundingClientRect() while scrollY was still 0 (we never scroll
      // the page), so those coordinates are already relative to the top of
      // the full document, not just the initial viewport. A viewport-only
      // screenshot only captures the first ~900px, so anything below the
      // fold (which, on a real page, is most of it) would have a bounding
      // box that lands outside the image entirely. Full-page keeps the two
      // coordinate spaces aligned.
      fullPage: true,
    });

    const summary = {
      url,
      scannedAt: new Date().toISOString(),
      viewport: VIEWPORT,
      violationCount: results.violations.length,
      nodeCount: results.violations.reduce((n, v) => n + v.nodes.length, 0),
      boundingBoxHitRate: boundingBoxHitRate(results.violations),
      violations: results.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        helpUrl: v.helpUrl,
        tags: v.tags,
        nodes: v.nodes.map((n) => ({
          target: n.target,
          html: n.html,
          failureSummary: n.failureSummary,
          boundingBox: n.boundingBox,
        })),
      })),
    };

    fs.writeFileSync(
      path.join(outDir, "violations.json"),
      JSON.stringify(summary, null, 2)
    );

    console.log("\n--- Summary ---");
    console.log(`URL: ${url}`);
    console.log(`Violation types: ${summary.violationCount}`);
    console.log(`Violating nodes: ${summary.nodeCount}`);
    console.log(
      `Bounding boxes successfully resolved: ${summary.boundingBoxHitRate}`
    );
    console.log(`\nWrote ${outDir}/violations.json`);
    console.log(`Wrote ${outDir}/screenshot.png`);
  } finally {
    await browser.close();
  }
}

function flattenTarget(target) {
  // target is normally like ["button.submit"]. It can also contain nested
  // arrays for elements inside iframes/shadow DOM, e.g. ["iframe", "button"].
  // For this POC we only handle the simple top-level case and report null
  // (no bounding box) for anything nested, so we can see how common that is.
  if (!Array.isArray(target) || target.length !== 1) return null;
  if (typeof target[0] !== "string") return null;
  return target[0];
}

function boundingBoxHitRate(violations) {
  let total = 0;
  let hit = 0;
  for (const v of violations) {
    for (const n of v.nodes) {
      total++;
      if (n.boundingBox) hit++;
    }
  }
  if (total === 0) return "n/a";
  return `${hit}/${total} (${Math.round((hit / total) * 100)}%)`;
}

main().catch((err) => {
  console.error("POC failed:", err);
  process.exit(1);
});
