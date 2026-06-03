#!/usr/bin/env python3
"""
Generate a contact-attribute data dictionary (Markdown + CSV) from a Lucid document.

Fetches live from the Lucid API by default. Can also read from a local JSON file.

Usage:
    # Fetch live from Lucid (requires LUCID_API_KEY env var)
    python scripts/gen_data_dictionary.py <doc-id>

    # All docs listed in docs.json in this repo (requires LUCID_API_KEY)
    python scripts/gen_data_dictionary.py --all

    # Read from a local file instead of calling the API
    python scripts/gen_data_dictionary.py <doc-id> --file /path/to/document.json

    # Override output directory (default: docs/)
    python scripts/gen_data_dictionary.py <doc-id> --out-dir /path/to/output
"""

import argparse
import csv
import io
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path


LUCID_API_BASE = "https://api.lucid.co"


# ---------------------------------------------------------------------------
# Lucid API
# ---------------------------------------------------------------------------

def fetch_document(doc_id: str, api_key: str) -> dict:
    url = f"{LUCID_API_BASE}/documents/{doc_id}/contents"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {api_key}",
        "Lucid-Api-Version": "1",
    })
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        sys.exit(f"ERROR: Lucid API returned {e.code} for doc '{doc_id}': {body}")


def load_doc(doc_id: str, file_path: str | None, api_key: str | None) -> dict:
    if file_path:
        path = Path(file_path)
        if not path.exists():
            sys.exit(f"ERROR: File not found: {path}")
        print(f"  Loading from file: {path}", file=sys.stderr)
        data = json.loads(path.read_text())
    else:
        if not api_key:
            sys.exit("ERROR: LUCID_API_KEY environment variable is not set")
        print(f"  Fetching from Lucid API: {doc_id}", file=sys.stderr)
        data = fetch_document(doc_id, api_key)

    # Normalize: items may be a JSON string in some older file formats
    for page in data.get("pages", []):
        if isinstance(page.get("items"), str):
            page["items"] = json.loads(page["items"])
    return data


# ---------------------------------------------------------------------------
# HTML / text helpers
# ---------------------------------------------------------------------------

def clean_html(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text)
    text = (
        text.replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&nbsp;", " ")
            .replace("&#39;", "'")
    )
    return re.sub(r"\s+", " ", text).strip()


def shape_text(shape: dict) -> str:
    return "\n".join(
        clean_html(ta.get("text", "") or "")
        for ta in shape.get("textAreas", [])
        if (ta.get("text", "") or "").strip()
    )


def is_set_block(shape_class: str, text: str) -> bool:
    if shape_class == "DataBlockNew":
        return True
    if re.match(r"(?i)^set\s|\bset\s+\$", text):
        return True
    return False


# Matches `$varName =` but not `==` or `!=`
_SET_RE = re.compile(r"\$([A-Za-z_][A-Za-z0-9_.]*)\s*(?<!=)=(?!=)")


def extract_sets(text: str) -> list:
    results = []
    for line in text.split("\n"):
        for m in _SET_RE.finditer(line):
            results.append((m.group(1), line.strip()))
    return results


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------

def extract_attributes(doc: dict) -> dict:
    """Returns {attr: [{page, line}, ...]} for every contact-attribute assignment."""
    from collections import defaultdict
    attr_map = defaultdict(list)
    for page in doc.get("pages", []):
        page_title = page.get("title", "Unknown")
        for shape in page.get("items", {}).get("shapes", []):
            text = shape_text(shape)
            if not text or not is_set_block(shape.get("class", ""), text):
                continue
            for attr, line in extract_sets(text):
                attr_map[attr].append({"page": page_title, "line": line})
    return attr_map


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def unique_pages(entries: list) -> list:
    seen = set()
    out = []
    for e in entries:
        if e["page"] not in seen:
            seen.add(e["page"])
            out.append(e["page"])
    return out


def sample_lines(entries: list, n: int = 3) -> list:
    seen = set()
    out = []
    for e in entries:
        line = e["line"][:150]
        if line not in seen:
            seen.add(line)
            out.append(line)
        if len(out) >= n:
            break
    return out


def render_markdown(doc: dict, attr_map: dict) -> str:
    doc_title = doc.get("title", "Unknown")
    doc_id = doc.get("id", "")
    attrs = sorted(attr_map.keys(), key=str.lower)

    summary_rows = []
    for attr in attrs:
        entries = attr_map[attr]
        pages = ", ".join(unique_pages(entries))
        samples = "<br>".join(f"`{ln}`" for ln in sample_lines(entries))
        summary_rows.append(f"| `${attr}` | {pages} | {samples} |")

    detail_sections = []
    for attr in attrs:
        entries = attr_map[attr]
        pages = ", ".join(unique_pages(entries))
        lines = "\n".join(f"- `{ln}`" for ln in sample_lines(entries, n=6))
        detail_sections.append(
            f"### `${attr}`\n\n**Set on:** {pages}\n\n**Assignments:**\n\n{lines}\n"
        )

    return "\n".join([
        f"# Contact Attribute Data Dictionary — {doc_title}",
        "",
        f"Document: `{doc_id}`  ",
        f"Pages: {len(doc.get('pages', []))}  ",
        f"Attributes found: {len(attr_map)}",
        "",
        "Attributes are identified from parallelogram (`DataBlockNew`) blocks using the `$attr = value` convention.",
        "",
        "---",
        "",
        "| Attribute | Set On Page(s) | Sample Assignment(s) |",
        "|---|---|---|",
        *summary_rows,
        "",
        "---",
        "",
        "## Full Detail",
        "",
        *detail_sections,
    ])


def render_csv(doc: dict, attr_map: dict) -> str:
    attrs = sorted(attr_map.keys(), key=str.lower)
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(["attribute", "document", "pages", "sample_assignment_1", "sample_assignment_2", "sample_assignment_3"])
    doc_title = doc.get("title", "")
    for attr in attrs:
        entries = attr_map[attr]
        pages = " | ".join(unique_pages(entries))
        samples = sample_lines(entries, n=3)
        writer.writerow([
            f"${attr}",
            doc_title,
            pages,
            samples[0] if len(samples) > 0 else "",
            samples[1] if len(samples) > 1 else "",
            samples[2] if len(samples) > 2 else "",
        ])
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def safe_filename(title: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^\w-]", "-", title)).strip("-")


def write_outputs(doc: dict, attr_map: dict, out_dir: Path):
    out_dir.mkdir(parents=True, exist_ok=True)
    base = out_dir / f"{safe_filename(doc.get('title', 'document'))}-data-dictionary"
    base.with_suffix(".md").write_text(render_markdown(doc, attr_map))
    base.with_suffix(".csv").write_text(render_csv(doc, attr_map))
    print(f"  Written: {base}.md", file=sys.stderr)
    print(f"  Written: {base}.csv", file=sys.stderr)
    print(f"  Attributes: {len(attr_map)}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Generate a contact-attribute data dictionary from a Lucid document."
    )
    parser.add_argument("doc_id", nargs="?", help="Lucid document UUID")
    parser.add_argument("--all", action="store_true", help="Process all docs listed in docs.json")
    parser.add_argument("--file", metavar="PATH", help="Read from a local JSON file instead of the Lucid API")
    parser.add_argument("--out-dir", metavar="PATH", default="docs", help="Output directory (default: docs/)")
    args = parser.parse_args()

    api_key = os.environ.get("LUCID_API_KEY")
    out_dir = Path(args.out_dir)

    if args.all:
        docs_json = Path("docs.json")
        if not docs_json.exists():
            sys.exit("ERROR: docs.json not found in the current directory")
        docs = json.loads(docs_json.read_text())
        for entry in docs:
            doc_id = entry["id"]
            print(f"\n[{entry.get('title', doc_id)}]", file=sys.stderr)
            doc = load_doc(doc_id, None, api_key)
            write_outputs(doc, extract_attributes(doc), out_dir)
        return

    if not args.doc_id:
        parser.error("doc_id is required unless --all is specified")

    doc = load_doc(args.doc_id, args.file, api_key)
    write_outputs(doc, extract_attributes(doc), out_dir)


if __name__ == "__main__":
    main()
