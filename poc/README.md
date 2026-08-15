# POC: axe-core + bounding boxes against a live URL

This proves the one real technical risk in the accessibility triage tool before
anything else gets built: can we run a real axe-core scan against a live URL,
in a real headless browser, and reliably get back pixel bounding boxes for
each violation so they can be drawn as overlay boxes on a screenshot?

It's written against local `puppeteer` rather than Cloudflare's Browser
Rendering product because Claude's sandbox has no outbound access to the npm
registry to install packages, so this needs to run on your machine. The API
is nearly identical to `@cloudflare/puppeteer` (Cloudflare's Browser Rendering
binding), so a working result here carries over directly. See "Porting to a
Worker" below.

## Run it

```
cd accessibility-triage-tool/poc
npm install
node poc.js https://example.com
```

Try it against a real, slightly-messy site (not example.com, which is too
clean to be a useful test) to get a realistic read. Your own side-projects
page or an older personal site would work.

## What to check in the output

- `out/violations.json` — the axe-core violations, each node annotated with
  a `boundingBox` (`{x, y, width, height}`) or `null` if one couldn't be
  resolved.
- `out/screenshot.png` — a viewport screenshot (1280x900) that the bounding
  box coordinates are relative to. Open both side by side and manually check
  a few boxes actually land on the right element.
- The `boundingBoxHitRate` line in the console output. This is the real
  pass/fail signal for the POC: if most violating nodes resolve to a real
  bounding box, the visual overlay approach is viable as designed. If a
  meaningful chunk come back `null`, the code that flattens `node.target`
  down to a single selector needs to handle nested targets (elements inside
  iframes or shadow DOM), which the POC deliberately skips for now.

## Porting to a Worker (once this checks out)

- `puppeteer.launch({...})` becomes `puppeteer.launch(env.MYBROWSER)` using
  `@cloudflare/puppeteer`, with a Browser Rendering binding in `wrangler.toml`.
- The axe-core injection, `axe.run()` call, bounding-box loop, and screenshot
  call are all Worker-compatible as-is.
- Pricing confirmed (Cloudflare docs, now branded "Browser Run", formerly
  "Browser Rendering"): Workers Free plan includes 10 minutes of browser time
  per day and 3 concurrent browsers, at no cost. Workers Paid includes 10
  browser-hours per month and 10 concurrent browsers, then $0.09/hour and
  $2.00/concurrent browser past that. A single scan (page load + axe run +
  screenshot) will likely land somewhere around 10-30 seconds, so the free
  tier's 10 minutes/day supports roughly 20-60 scans a day, probably enough
  for a portfolio demo, but worth adding the same rate-limiting-via-KV pattern
  used on the other 3 projects so one bad actor can't burn through the daily
  allowance and break the demo for everyone else that day.
