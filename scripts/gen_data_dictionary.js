#!/usr/bin/env node

require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const Anthropic = require("@anthropic-ai/sdk");

const LUCID_API_BASE = "https://api.lucid.co";
const ENRICH_BATCH_SIZE = 20;
const ENRICH_MODEL = "claude-haiku-4-5-20251001";

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function printHelp() {
  console.log(`Generate a contact-attribute data dictionary from a Lucid document.

Usage:
  node scripts/gen_data_dictionary.js <doc-id>
  node scripts/gen_data_dictionary.js --all
  node scripts/gen_data_dictionary.js <doc-id> --file /path/to/document.json
  node scripts/gen_data_dictionary.js <doc-id> --out-dir /path/to/output
  node scripts/gen_data_dictionary.js <doc-id> --enrich

Flags:
  --enrich    Use Claude API to generate plain-English descriptions and categories
              for each attribute. Requires ANTHROPIC_API_KEY.
`);
}

async function fetchDocument(docId, apiKey) {
  const url = `${LUCID_API_BASE}/documents/${docId}/contents`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Lucid-Api-Version": "1",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    fail(`Lucid API returned ${response.status} for doc '${docId}': ${body}`);
  }

  return response.json();
}

async function loadDoc(docId, filePath, apiKey) {
  let data;

  if (filePath) {
    if (!fs.existsSync(filePath)) {
      fail(`File not found: ${filePath}`);
    }
    console.error(`  Loading from file: ${filePath}`);
    data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } else {
    if (!apiKey) {
      fail("LUCID_API_KEY environment variable is not set");
    }
    console.error(`  Fetching from Lucid API: ${docId}`);
    data = await fetchDocument(docId, apiKey);
  }

  for (const page of data.pages || []) {
    if (typeof page.items === "string") {
      page.items = JSON.parse(page.items);
    }
  }

  return data;
}

function cleanHtml(text) {
  const withoutTags = text.replace(/<[^>]+>/g, " ");
  return withoutTags
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&#39;", "'")
    .replace(/\s+/g, " ")
    .trim();
}

function shapeText(shape) {
  return (shape.textAreas || [])
    .map((textArea) => cleanHtml(textArea.text || ""))
    .filter((line) => line.trim())
    .join("\n");
}

function isSetBlock(shapeClass, text) {
  if (shapeClass === "DataBlockNew") {
    return true;
  }

  return /^(set\s)|\bset\s+\$/i.test(text);
}

const SET_RE = /\$([A-Za-z_][A-Za-z0-9_.]*)\s*(?<!=)=(?!=)/g;

function extractSets(text) {
  const results = [];

  for (const line of text.split("\n")) {
    const matches = line.matchAll(SET_RE);
    for (const match of matches) {
      results.push({ attr: match[1], line: line.trim() });
    }
  }

  return results;
}

function extractAttributes(doc) {
  const attrMap = {};

  for (const page of doc.pages || []) {
    const pageTitle = page.title || "Unknown";
    for (const shape of page.items?.shapes || []) {
      const text = shapeText(shape);
      if (!text || !isSetBlock(shape.class || "", text)) {
        continue;
      }

      for (const entry of extractSets(text)) {
        if (!attrMap[entry.attr]) {
          attrMap[entry.attr] = [];
        }
        attrMap[entry.attr].push({ page: pageTitle, line: entry.line });
      }
    }
  }

  return attrMap;
}

function uniquePages(entries) {
  const seen = new Set();
  const pages = [];

  for (const entry of entries) {
    if (!seen.has(entry.page)) {
      seen.add(entry.page);
      pages.push(entry.page);
    }
  }

  return pages;
}

function sampleLines(entries, n = 3) {
  const seen = new Set();
  const lines = [];

  for (const entry of entries) {
    const line = entry.line.slice(0, 150);
    if (!seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
    if (lines.length >= n) {
      break;
    }
  }

  return lines;
}

const ENRICH_SYSTEM = `You are analyzing contact attributes from Amazon Connect IVR flow diagrams built in Lucidchart. Each attribute is a contact attribute set during call flow execution using the $attr = value convention.

For each attribute you receive, return a JSON object with:
- "attr": the attribute name as given (with $ prefix)
- "description": one concise sentence describing what this attribute represents or tracks in the call flow
- "category": one of:
    "business"   — meaningful business/caller-journey data (auth status, call reason, queue selection, customer identity, survey responses, etc.)
    "module-io"  — used to pass data into or receive results from a reusable module (result codes like _Result, module input parameters, cross-module handoffs)
    "transient"  — temporary state, counters, flags, or loop variables that maintain flow control but have no lasting business meaning
- "note": a short data-quality observation if warranted (e.g. possible typo, naming inconsistency with a similar attribute, unclear purpose) — or null

Return only a JSON array of these objects, no other text.`;

async function enrichBatch(client, attrs, attrMap) {
  const payload = attrs.map((attr) => ({
    attr: `$${attr}`,
    assignments: sampleLines(attrMap[attr], 6),
    pages: uniquePages(attrMap[attr]),
  }));

  const response = await client.messages.create({
    model: ENRICH_MODEL,
    max_tokens: 2048,
    system: [
      {
        type: "text",
        text: ENRICH_SYSTEM,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: JSON.stringify(payload, null, 2),
      },
    ],
  });

  const text = response.content[0].text.trim();
  // Strip markdown code fences if present
  const json = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  return JSON.parse(json);
}

async function enrichAttributes(attrMap, anthropicKey) {
  if (!anthropicKey) {
    fail("ANTHROPIC_API_KEY environment variable is not set (required for --enrich)");
  }

  const client = new Anthropic({ apiKey: anthropicKey });
  const attrs = Object.keys(attrMap).sort((a, b) => a.localeCompare(b));
  const enriched = {};

  for (let i = 0; i < attrs.length; i += ENRICH_BATCH_SIZE) {
    const batch = attrs.slice(i, i + ENRICH_BATCH_SIZE);
    console.error(`  Enriching attributes ${i + 1}–${Math.min(i + ENRICH_BATCH_SIZE, attrs.length)} of ${attrs.length}...`);
    const results = await enrichBatch(client, batch, attrMap);
    for (const result of results) {
      const key = result.attr.replace(/^\$/, "");
      enriched[key] = result;
    }
  }

  return enriched;
}

function renderMarkdown(doc, attrMap, enrichment) {
  const docTitle = doc.title || "Unknown";
  const docId = doc.id || "";
  const attrs = Object.keys(attrMap).sort((a, b) => a.localeCompare(b));

  let summaryRows;
  let tableHeader;

  if (enrichment) {
    tableHeader = ["| Attribute | Category | Description | Set On Page(s) |", "|---|---|---|---|"];
    summaryRows = attrs.map((attr) => {
      const pages = uniquePages(attrMap[attr]).join(", ");
      const info = enrichment[attr] || {};
      const desc = info.description || "";
      const cat = info.category || "";
      const note = info.note ? ` ⚠️ ${info.note}` : "";
      return `| \`$${attr}\` | ${cat} | ${desc}${note} | ${pages} |`;
    });
  } else {
    tableHeader = ["| Attribute | Set On Page(s) | Sample Assignment(s) |", "|---|---|---|"];
    summaryRows = attrs.map((attr) => {
      const entries = attrMap[attr];
      const pages = uniquePages(entries).join(", ");
      const samples = sampleLines(entries)
        .map((line) => `\`${line}\``)
        .join("<br>");
      return `| \`$${attr}\` | ${pages} | ${samples} |`;
    });
  }

  const detailSections = attrs.map((attr) => {
    const entries = attrMap[attr];
    const pages = uniquePages(entries).join(", ");
    const lines = sampleLines(entries, 6).map((line) => `- \`${line}\``).join("\n");
    const info = enrichment?.[attr];

    const enrichLines = info
      ? [
          `**Description:** ${info.description}`,
          `**Category:** ${info.category}`,
          ...(info.note ? [`**Note:** ${info.note}`] : []),
          "",
        ]
      : [];

    return [
      `### \`$${attr}\``,
      "",
      `**Set on:** ${pages}`,
      "",
      ...enrichLines,
      "**Assignments:**",
      "",
      lines,
      "",
    ].join("\n");
  });

  return [
    `# Contact Attribute Data Dictionary - ${docTitle}`,
    "",
    `Document: \`${docId}\`  `,
    `Pages: ${(doc.pages || []).length}  `,
    `Attributes found: ${attrs.length}`,
    "",
    "Attributes are identified from parallelogram (`DataBlockNew`) blocks using the `$attr = value` convention.",
    "",
    "---",
    "",
    ...tableHeader,
    ...summaryRows,
    "",
    "---",
    "",
    "## Full Detail",
    "",
    ...detailSections,
  ].join("\n");
}

function csvEscape(value) {
  const stringValue = String(value ?? "");
  if (/[,"\n]/.test(stringValue)) {
    return `"${stringValue.replaceAll('"', '""')}"`;
  }
  return stringValue;
}

function renderCsv(doc, attrMap, enrichment) {
  const attrs = Object.keys(attrMap).sort((a, b) => a.localeCompare(b));
  const docTitle = doc.title || "";

  let header;
  let rowFn;

  if (enrichment) {
    header = ["attribute", "document", "category", "description", "note", "pages"].join(",");
    rowFn = (attr) => {
      const info = enrichment[attr] || {};
      return [
        `$${attr}`,
        docTitle,
        info.category || "",
        info.description || "",
        info.note || "",
        uniquePages(attrMap[attr]).join(" | "),
      ]
        .map(csvEscape)
        .join(",");
    };
  } else {
    header = ["attribute", "document", "pages", "sample_assignment_1", "sample_assignment_2", "sample_assignment_3"].join(",");
    rowFn = (attr) => {
      const samples = sampleLines(attrMap[attr], 3);
      return [
        `$${attr}`,
        docTitle,
        uniquePages(attrMap[attr]).join(" | "),
        samples[0] || "",
        samples[1] || "",
        samples[2] || "",
      ]
        .map(csvEscape)
        .join(",");
    };
  }

  return `${[header, ...attrs.map(rowFn)].join("\n")}\n`;
}

function safeFilename(title) {
  return title.replace(/[^\w-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

function writeOutputs(doc, attrMap, outDir, enrichment) {
  fs.mkdirSync(outDir, { recursive: true });
  const baseName = `${safeFilename(doc.title || "document")}-data-dictionary`;
  const mdPath = path.join(outDir, `${baseName}.md`);
  const csvPath = path.join(outDir, `${baseName}.csv`);

  fs.writeFileSync(mdPath, renderMarkdown(doc, attrMap, enrichment));
  fs.writeFileSync(csvPath, renderCsv(doc, attrMap, enrichment));

  console.error(`  Written: ${mdPath}`);
  console.error(`  Written: ${csvPath}`);
  console.error(`  Attributes: ${Object.keys(attrMap).length}`);
}

function parseArgs(argv) {
  const args = {
    all: false,
    enrich: false,
    docId: null,
    file: null,
    outDir: "docs",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];

    if (current === "--all") {
      args.all = true;
      continue;
    }

    if (current === "--enrich") {
      args.enrich = true;
      continue;
    }

    if (current === "--help" || current === "-h") {
      args.help = true;
      continue;
    }

    if (current === "--file") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        fail("Missing value for --file");
      }
      args.file = value;
      i += 1;
      continue;
    }

    if (current === "--out-dir") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        fail("Missing value for --out-dir");
      }
      args.outDir = value;
      i += 1;
      continue;
    }

    if (current.startsWith("--")) {
      fail(`Unknown option: ${current}`);
    }

    if (!args.docId) {
      args.docId = current;
      continue;
    }

    fail(`Unexpected argument: ${current}`);
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const lucidKey = process.env.LUCID_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (args.all) {
    const docsPath = path.resolve(process.cwd(), "docs.json");
    if (!fs.existsSync(docsPath)) {
      fail("docs.json not found in the current directory");
    }

    const docs = JSON.parse(fs.readFileSync(docsPath, "utf8"));
    for (const entry of docs) {
      const docId = entry.id;
      console.error(`\n[${entry.title || docId}]`);
      const doc = await loadDoc(docId, null, lucidKey);
      const attrMap = extractAttributes(doc);
      const enrichment = args.enrich ? await enrichAttributes(attrMap, anthropicKey) : null;
      writeOutputs(doc, attrMap, args.outDir, enrichment);
    }
    return;
  }

  if (!args.docId) {
    fail("doc_id is required unless --all is specified");
  }

  const doc = await loadDoc(args.docId, args.file, lucidKey);
  const attrMap = extractAttributes(doc);
  const enrichment = args.enrich ? await enrichAttributes(attrMap, anthropicKey) : null;
  writeOutputs(doc, attrMap, args.outDir, enrichment);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
