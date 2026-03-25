# Gamma to PDF

Export Gamma documents to PDF from the command line, including private docs that require a signed-in Gamma account.

The project is built for practical local use:

- clone from GitHub
- run one setup command
- export a Gamma doc to PDF
- optionally generate a chat/LLM-friendly bundle with Markdown, JSON, page PNGs, and QA

## Why This Exists

Gamma docs do not always print cleanly through a naive browser PDF flow. This tool uses a browser-driven export pipeline plus post-processing so the output is more stable for:

- normal reading
- Acrobat / Preview compatibility
- attaching the PDF to chat tools
- downstream parsing by agents and LLMs

## Features

- accepts `https://gamma.app/docs/...` URLs
- works with private docs using a persistent local browser profile
- waits for real document render before export
- derives sensible filenames from the document title
- writes to `./exports/` by default so the repo root stays clean
- optional `--chat-ready` mode writes:
  - PDF
  - `document.md`
  - `document.json`
  - page PNGs
  - QA report
- Poppler-backed QA for parseability checks
- optional Tesseract-backed sparse-page OCR support

## Quick Start

```bash
git clone <repo-url>
cd gamma-to-pdf
npm run setup
npm run doctor
npm run export -- 'https://gamma.app/docs/your-doc-id?mode=doc' --chat-ready --qa
```

By default, outputs are written to:

```text
exports/
```

## Requirements

- Node.js 20+
- macOS or Linux

Recommended system tools:

- Poppler for richer QA: `pdfinfo`, `pdftotext`, `pdffonts`, `pdftoppm`
- Tesseract for sparse-page OCR fallback

### macOS

```bash
brew install poppler tesseract
```

### Ubuntu / Debian

```bash
sudo apt-get update
sudo apt-get install -y poppler-utils tesseract-ocr
```

## Setup

### Bootstrap everything

```bash
npm run setup
```

This command:

- installs JavaScript dependencies with `npm ci`
- installs Playwright Chromium
- checks for Poppler and Tesseract
- prints exact install hints if optional system tools are missing

### Validate the machine

```bash
npm run doctor
```

`doctor` checks:

- Node version
- npm availability
- Playwright Chromium
- writable `exports/` directory
- Poppler tools
- Tesseract

## Usage

### Basic export

```bash
npm run export -- 'https://gamma.app/docs/your-doc-id?mode=doc'
```

### Chat-ready export

```bash
npm run export -- 'https://gamma.app/docs/your-doc-id?mode=doc' --chat-ready --qa
```

### Save somewhere specific

```bash
npm run export -- 'https://gamma.app/docs/your-doc-id?mode=doc' -o ./my-output/
```

### Legacy alias

```bash
npm run export-pdf -- 'https://gamma.app/docs/your-doc-id?mode=doc'
```

## Private Gamma Docs

Private docs work through a persistent local browser profile at:

```text
~/.gamma-to-pdf/profile
```

On the first run:

1. the tool opens a browser
2. sign in to Gamma
3. complete any human verification page
4. let the export continue automatically

Later runs reuse that saved session.

## Output Modes

### Standard PDF

The default flow exports a cleaned PDF intended for normal reading and sharing.

### `--llm-bundle`

Adds a sibling `.llm/` directory containing:

- `manifest.json`
- one PNG per PDF page

### `--chat-ready`

Adds a sibling `.chat/` directory containing:

- `manifest.json`
- `document.md`
- `document.json`
- page PNGs
- `qa/report.json`

This mode is intended for “attach the PDF in chat and keep machine-friendly sidecars” workflows.

## Agent-Friendly Workflow

This repo is intentionally easy for agents and automation to use locally:

- one bootstrap command: `npm run setup`
- one machine check: `npm run doctor`
- one stable export command: `npm run export -- '<url>' [flags]`
- predictable output location: `./exports/`
- structured sidecars in `.chat/`

Current practical limitation:

- private docs may still require a human to complete Gamma login or anti-bot verification in the opened browser on a new machine

## Project Layout

```text
bin/
  gamma-to-pdf.mjs
src/
  cli.mjs
  core.mjs
scripts/
  setup.mjs
  doctor.mjs
```

## Development

Run tests:

```bash
npm test
```

Run the CLI help:

```bash
npm run export -- --help
```

The repo is structured to be CI-friendly, but no workflow file is committed by default.

## Troubleshooting

### Gamma asks for login or verification

Run without `--headless`, complete the prompt in the opened browser, and let the tool continue.

### Playwright browser missing

Run:

```bash
npx playwright install chromium
```

### Poppler missing

The export still works, but `--chat-ready --qa` loses some validation fidelity.

### Tesseract missing

The export still works, but sparse-page OCR fallback is disabled.
