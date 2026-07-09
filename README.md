# lucid-data-dictionary

> **This is a template repository.** To use it, create a new private repo from this template (or fork/clone it), add your own `docs.json` (copy from `docs.json.example`), and configure the `LUCID_API_KEY` secret.

Generates a contact-attribute data dictionary from Lucidchart IVR flow diagrams. For each tracked document, it produces a Markdown table, a CSV, and an Excel (.xlsx) file listing every contact attribute being set across all pages. Optionally enriches each attribute with a plain-English description and category (business / module-io / transient) using the Claude API.

## How it works

The extractor fetches a document live from the Lucid API, then scans every shape for **parallelogram blocks** (`DataBlockNew` shape class) — the IVR design convention for "Set Contact Attribute" steps — plus any `ProcessBlock` whose text opens with `Set $`. It matches the `$attr = value` pattern within those blocks to identify attribute assignments.

### Extraction rules

- **Target shapes:** `DataBlockNew` (parallelogram) is the primary type. `ProcessBlock` shapes whose text begins with `Set` or `Set $` are also included.
- **Assignment pattern:** `$variableName = <anything>` — a `$`-prefixed identifier followed by `=`, excluding comparison operators (`==`, `!=`).
- **Text extraction:** HTML tags are stripped; multi-line blocks are split line-by-line so each assignment is captured independently.
- **Not captured:** Decision diamond conditions (e.g. `$var == true`), read-only attribute references in prompt keys or input blocks, and line/connector labels.

### Output per attribute

Without `--enrich`:

| Field | Description |
|---|---|
| `attribute` | Attribute name with `$` prefix |
| `document` | Source Lucid document title |
| `pages` | All pages where the attribute is set |
| `sample_assignment_1–3` | Up to three representative assignment expressions from the diagram |

With `--enrich` (Claude API):

| Field | Description |
|---|---|
| `attribute` | Attribute name with `$` prefix |
| `document` | Source Lucid document title |
| `category` | `business` / `module-io` / `transient` |
| `description` | Plain-English description of what the attribute represents |
| `note` | Data quality flag (e.g. possible typo, naming inconsistency) — blank if none |
| `pages` | All pages where the attribute is set |

## Repo structure

```
.github/
  workflows/
    generate.yml          # Manual workflow — accepts a doc ID or "all"
scripts/
  gen_data_dictionary.js
docs.json                 # List of documents to process with --all
docs/                     # Generated output (gitignored — download from Actions artifacts)
```

## GitHub Action

Trigger **Generate Data Dictionary** from the Actions tab. Provide a `doc-id` input:

| Input | Description |
|---|---|
| `<UUID>` | Generate for a single document |
| `all` | Generate for every document listed in `docs.json` |

The outputs are uploaded as a downloadable artifact named `data-dictionary`.

### Workflow inputs

| Input | Description |
|---|---|
| `doc-id` | Lucid document UUID, or `all` to process every doc in `docs.json` |
| `enrich` | Boolean — enable Claude-powered descriptions (default: false) |

### Required secrets

Configure in **Settings → Secrets and variables → Actions**:

| Name | Required | Description |
|---|---|---|
| `LUCID_API_KEY` | Always | Lucid REST API key (Team/Enterprise plan required) |
| `ANTHROPIC_API_KEY` | Only with `enrich` | Anthropic API key for Claude enrichment |

## Local usage

```bash
# Install dependencies
npm install

# Copy and fill in your API keys
cp .env.example .env
# Set LUCID_API_KEY (required) and ANTHROPIC_API_KEY (required for --enrich)

# Show CLI help
npm run generate -- --help

# Single doc by UUID
npm run generate -- <doc-id>

# Single doc by UUID (direct node command)
node scripts/gen_data_dictionary.js <doc-id>

# All docs in docs.json
npm run generate -- --all

# All docs in docs.json (direct node command)
node scripts/gen_data_dictionary.js --all

# Read from a local file instead of calling the API
npm run generate -- <doc-id> --file /path/to/document.json

# Read from a local file instead of calling the API (direct node command)
node scripts/gen_data_dictionary.js <doc-id> --file /path/to/document.json

# Custom output directory
npm run generate -- <doc-id> --out-dir /path/to/output

# Custom output directory (direct node command)
node scripts/gen_data_dictionary.js <doc-id> --out-dir /path/to/output

# Enrich with Claude-generated descriptions and categories
npm run generate -- <doc-id> --enrich
node scripts/gen_data_dictionary.js --all --enrich

# Process up to N documents concurrently with --all (default 4)
node scripts/gen_data_dictionary.js --all --concurrency 8

# Exclude attributes already defined in another doc (e.g. a shared template)
node scripts/gen_data_dictionary.js <doc-id> --exclude-baseline <template-doc-id>

# Write outputs into a subfolder of --out-dir
node scripts/gen_data_dictionary.js <doc-id> --subfolder "Pod 1 - Boutique Wave 1"
```

## docs.json

`docs.json` is gitignored — copy the example and fill in your document IDs:

```bash
cp docs.json.example docs.json
```

The `--all` flag reads this file from the current working directory.

### Baseline exclusion

BU-specific Lucid docs sometimes include copies of a shared template's pages, which duplicates
that template's attributes across every BU dictionary. Mark the template doc with `"baseline":
true` in `docs.json` and its attributes are automatically excluded from every other document's
dictionary (in both single-doc and `--all` runs):

```json
{ "id": "<template-doc-uuid>", "title": "Template Framework", "baseline": true }
```

For a one-off exclusion without editing `docs.json`, pass `--exclude-baseline <doc-id>`
(repeatable). Use `--no-baseline-exclude` to disable the automatic `docs.json` behavior.

Baseline exclusion matches attribute names exactly, so a BU doc's `$QueueID` won't be excluded
against the baseline's `$queueID` — they're kept as distinct attributes rather than silently
merged, since case drift can also indicate genuinely different attributes. A `--all` run instead
writes any such case-only matches to `<out-dir>/case-mismatches.md` for manual review.

### Output subfolders

Set a `"folder"` field on a `docs.json` entry to write that document's outputs into
`<out-dir>/<folder>/` instead of directly into `<out-dir>/`. This is meant to mirror the Lucid
folder a document lives in — specifically the main folder directly under your Lucid "Designs"
folder, not any subfolder beneath it:

```json
{ "id": "<lucid-doc-uuid>", "title": "Document Name", "folder": "Pod 1 - Boutique Wave 1" }
```

Entries without a `"folder"` field are written directly into `<out-dir>/`, same as before. For a
single-doc run, pass `--subfolder <name>` instead of editing `docs.json`.
