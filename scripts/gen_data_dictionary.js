#!/usr/bin/env node

require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");

const LUCID_API_BASE = "https://api.lucid.co";

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

function renderMarkdown(doc, attrMap) {
  const docTitle = doc.title || "Unknown";
  const docId = doc.id || "";
  const attrs = Object.keys(attrMap).sort((a, b) => a.localeCompare(b));

  const summaryRows = attrs.map((attr) => {
    const entries = attrMap[attr];
    const pages = uniquePages(entries).join(", ");
    const samples = sampleLines(entries)
      .map((line) => `\`${line}\``)
      .join("<br>");
    return `| \`$${attr}\` | ${pages} | ${samples} |`;
  });

  const detailSections = attrs.map((attr) => {
    const entries = attrMap[attr];
    const pages = uniquePages(entries).join(", ");
    const lines = sampleLines(entries, 6).map((line) => `- \`${line}\``).join("\n");

    return [
      `### \`$${attr}\``,
      "",
      `**Set on:** ${pages}`,
      "",
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
    "| Attribute | Set On Page(s) | Sample Assignment(s) |",
    "|---|---|---|",
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

function renderCsv(doc, attrMap) {
  const attrs = Object.keys(attrMap).sort((a, b) => a.localeCompare(b));
  const lines = [
    [
      "attribute",
      "document",
      "pages",
      "sample_assignment_1",
      "sample_assignment_2",
      "sample_assignment_3",
    ].join(","),
  ];

  const docTitle = doc.title || "";

  for (const attr of attrs) {
    const entries = attrMap[attr];
    const pages = uniquePages(entries).join(" | ");
    const samples = sampleLines(entries, 3);

    lines.push(
      [
        `$${attr}`,
        docTitle,
        pages,
        samples[0] || "",
        samples[1] || "",
        samples[2] || "",
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  return `${lines.join("\n")}\n`;
}

function safeFilename(title) {
  return title.replace(/[^\w-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

function writeOutputs(doc, attrMap, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const baseName = `${safeFilename(doc.title || "document")}-data-dictionary`;
  const mdPath = path.join(outDir, `${baseName}.md`);
  const csvPath = path.join(outDir, `${baseName}.csv`);

  fs.writeFileSync(mdPath, renderMarkdown(doc, attrMap));
  fs.writeFileSync(csvPath, renderCsv(doc, attrMap));

  console.error(`  Written: ${mdPath}`);
  console.error(`  Written: ${csvPath}`);
  console.error(`  Attributes: ${Object.keys(attrMap).length}`);
}

function parseArgs(argv) {
  const args = {
    all: false,
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

  const apiKey = process.env.LUCID_API_KEY;

  if (args.all) {
    const docsPath = path.resolve(process.cwd(), "docs.json");
    if (!fs.existsSync(docsPath)) {
      fail("docs.json not found in the current directory");
    }

    const docs = JSON.parse(fs.readFileSync(docsPath, "utf8"));
    for (const entry of docs) {
      const docId = entry.id;
      console.error(`\n[${entry.title || docId}]`);
      const doc = await loadDoc(docId, null, apiKey);
      writeOutputs(doc, extractAttributes(doc), args.outDir);
    }
    return;
  }

  if (!args.docId) {
    fail("doc_id is required unless --all is specified");
  }

  const doc = await loadDoc(args.docId, args.file, apiKey);
  writeOutputs(doc, extractAttributes(doc), args.outDir);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
