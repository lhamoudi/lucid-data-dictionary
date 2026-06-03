# lucid-data-dictionary

Generates a contact-attribute data dictionary from Lucidchart IVR flow diagrams. For each tracked document, it produces a Markdown table and a CSV listing every contact attribute being set across all pages, where it's set, and sample assignment expressions.

## How it works

The extractor fetches a document live from the Lucid API, then scans every shape for **parallelogram blocks** (`DataBlockNew` shape class) — the IVR design convention for "Set Contact Attribute" steps — plus any `ProcessBlock` whose text opens with `Set $`. It matches the `$attr = value` pattern within those blocks to identify attribute assignments.

### Extraction rules

- **Target shapes:** `DataBlockNew` (parallelogram) is the primary type. `ProcessBlock` shapes whose text begins with `Set` or `Set $` are also included.
- **Assignment pattern:** `$variableName = <anything>` — a `$`-prefixed identifier followed by `=`, excluding comparison operators (`==`, `!=`).
- **Text extraction:** HTML tags are stripped; multi-line blocks are split line-by-line so each assignment is captured independently.
- **Not captured:** Decision diamond conditions (e.g. `$var == true`), read-only attribute references in prompt keys or input blocks, and line/connector labels.

### Output per attribute

| Field | Description |
|---|---|
| `attribute` | Attribute name with `$` prefix |
| `document` | Source Lucid document title |
| `pages` | All pages where the attribute is set |
| `sample_assignment_1–3` | Up to three representative assignment expressions from the diagram |

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

### Required secret

Configure in **Settings → Secrets and variables → Actions**:

| Name | Type | Description |
|---|---|---|
| `LUCID_API_KEY` | Secret | Lucid REST API key (Team/Enterprise plan required) |

## Local usage

```bash
# Install dependencies
npm install

# Add your API key to a local .env file
echo "LUCID_API_KEY=your-api-key" > .env

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
```

## docs.json

`docs.json` is gitignored — copy the example and fill in your document IDs:

```bash
cp docs.json.example docs.json
```

The `--all` flag reads this file from the current working directory.
