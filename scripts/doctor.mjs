import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_OUTPUT_DIRECTORY = "exports";
const MINIMUM_NODE_MAJOR = 20;
const POPPLER_COMMANDS = ["pdfinfo", "pdffonts", "pdftotext", "pdftoppm"];

function parseNodeMajor(version) {
  return Number.parseInt(String(version || "").replace(/^v/, "").split(".")[0], 10);
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function commandExists(command) {
  try {
    const { execFile } = await import("node:child_process");
    await new Promise((resolve, reject) => {
      execFile("sh", ["-lc", `command -v ${command}`], (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    return true;
  } catch {
    return false;
  }
}

function getInstallHints() {
  if (process.platform === "darwin") {
    return {
      poppler: "brew install poppler",
      tesseract: "brew install tesseract",
    };
  }

  return {
    poppler: "sudo apt-get update && sudo apt-get install -y poppler-utils",
    tesseract: "sudo apt-get install -y tesseract-ocr",
  };
}

async function checkPlaywrightChromium() {
  try {
    const { chromium } = await import("playwright");
    const executablePath = chromium.executablePath();
    const ok = Boolean(executablePath) && (await pathExists(executablePath));
    return {
      ok,
      detail: ok ? executablePath : "Chromium is not installed. Run: npx playwright install chromium",
    };
  } catch (error) {
    return {
      ok: false,
      detail: `Playwright is not installed. Run: npm ci (${error?.message ?? error})`,
    };
  }
}

async function checkWritableExportsDirectory() {
  const outputDirectory = path.resolve(process.cwd(), DEFAULT_OUTPUT_DIRECTORY);
  try {
    await mkdir(outputDirectory, { recursive: true });
    await access(outputDirectory);
    return {
      ok: true,
      detail: outputDirectory,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `Unable to create or write to ${outputDirectory}: ${error?.message ?? error}`,
    };
  }
}

function printResult(kind, label, detail) {
  console.log(`${kind.padEnd(4)} ${label}: ${detail}`);
}

async function main() {
  const installHints = getInstallHints();
  const results = [];

  const nodeMajor = parseNodeMajor(process.version);
  results.push({
    required: true,
    label: "Node.js >= 20",
    ok: Number.isFinite(nodeMajor) && nodeMajor >= MINIMUM_NODE_MAJOR,
    detail: `Current: ${process.version}`,
  });

  results.push({
    required: true,
    label: "npm",
    ok: await commandExists("npm"),
    detail: "Required for install and scripted runs.",
  });

  results.push({
    required: true,
    label: "Playwright Chromium",
    ...(await checkPlaywrightChromium()),
  });

  results.push({
    required: true,
    label: "Writable exports directory",
    ...(await checkWritableExportsDirectory()),
  });

  const missingPoppler = [];
  for (const command of POPPLER_COMMANDS) {
    if (!(await commandExists(command))) {
      missingPoppler.push(command);
    }
  }
  results.push({
    required: false,
    label: "Poppler tools",
    ok: missingPoppler.length === 0,
    detail:
      missingPoppler.length === 0
        ? "pdfinfo, pdffonts, pdftotext, and pdftoppm are available."
        : `Missing ${missingPoppler.join(", ")}. Install with: ${installHints.poppler}`,
  });

  const hasTesseract = await commandExists("tesseract");
  results.push({
    required: false,
    label: "Tesseract OCR",
    ok: hasTesseract,
    detail: hasTesseract
      ? "Installed."
      : `Optional for sparse-page OCR. Install with: ${installHints.tesseract}`,
  });

  for (const result of results) {
    printResult(result.ok ? "PASS" : result.required ? "FAIL" : "WARN", result.label, result.detail);
  }

  const requiredFailures = results.filter((result) => result.required && !result.ok);
  if (requiredFailures.length > 0) {
    process.exitCode = 1;
    console.log("");
    console.log("Doctor summary: required dependencies are missing.");
    return;
  }

  console.log("");
  console.log("Doctor summary: required dependencies look good.");
}

await main();
