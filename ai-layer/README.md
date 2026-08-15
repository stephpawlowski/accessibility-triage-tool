# Task 2: AI clustering / prioritization / ticket layer

Takes the raw axe-core output from the task 1 POC and produces the thing that's
actually new here: violations grouped by shared root cause, ranked by a
deterministic impact score, each with a drafted ticket.

## Run it

No `npm install` needed, this uses Node's built-in `fetch`, zero dependencies.

```
cd accessibility-triage-tool/ai-layer
export ANTHROPIC_API_KEY=sk-ant-...
node cluster.js ../poc/out/violations.json
```

(Point it at whatever `violations.json` you already have from running the
task 1 POC. You don't need to re-scan anything.)

## What to check in the output

Open `out/triage.json` and the console summary. The real test, using your own
site's actual scan data: axe-core found 9 separate `color-contrast`
violations on stephpawlowski.com, but they're not all the same bug. The
h2 headings ("About Me", "Experience") fail at one color (`#8ba4a9`, a
looser 3:1 threshold since they're large text), and the body copy, footer
text, and links fail at a different color (`#7a7d7f`, the stricter 4.5:1
threshold for regular text). That's two genuinely different root causes
sharing one axe rule id.

**Pass:** the tool splits these into at least 2 clusters, one for each color,
not one giant "color-contrast" cluster with all 9 nodes lumped together. That's
the actual thing a free scanner doesn't do, grouping by axe rule id is trivial,
grouping by *actual shared cause* is the useful part.

**Also check:** the `region` violation (the parallax div not being in a
landmark) should come back as its own separate single-node cluster, it
shares nothing with the color-contrast issues.

**Sanity check the validation block** in `triage.json`: `unassignedNodes` and
`duplicateAssignments` should both be empty. The script checks this itself
and prints a warning if the model missed or double-counted any node, don't
just trust a clean-looking summary, check that block.

**Priority order:** clusters are sorted by `priority_score`
(severity weight x number of nodes in the cluster), computed in code, not
by the model. The `color-contrast` clusters (serious x several nodes each)
should outrank the single `region` node (moderate x 1).

## Cost

Tiny. One call, ~10 nodes of input, a few hundred tokens of output. At
claude-sonnet-5 pricing ($2/M input, $10/M output, same as the other 3
projects), this run costs a fraction of a cent. The console prints the
actual token usage each run if you want to check.

## Known limitation, on purpose for v1

Clustering happens within a single page's scan results only. The pitch
("the same button reported 40 times across 40 pages, group it once") is a
multi-page idea, this version doesn't crawl multiple pages yet, that's a
possible v2 extension, not part of this task. Worth remembering when writing
the eventual journal entry, don't overclaim what v1 actually does.
