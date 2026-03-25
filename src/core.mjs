import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { promisify } from "node:util";

import { createCanvas, loadImage } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { chromium } from "playwright";

export const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_VIEWPORT = { width: 1440, height: 1024 };
export const DEFAULT_PROFILE_DIR = path.join(os.homedir(), ".gamma-to-pdf", "profile");
export const DEFAULT_OUTPUT_DIRECTORY = "exports";
const DEFAULT_PRINTABLE_PAGE_WIDTH_PX = 816;
const DEFAULT_PRINTABLE_PAGE_HEIGHT_PX = 1056;
const LETTER_PAGE_WIDTH_PT = 612;
const LETTER_PAGE_HEIGHT_PT = 792;
const LANDSCAPE_PAGE_WIDTH_PT = LETTER_PAGE_HEIGHT_PT;
const LANDSCAPE_PAGE_HEIGHT_PT = LETTER_PAGE_WIDTH_PT;
const DEFAULT_LLM_IMAGE_SCALE = 2;
const DEFAULT_PDF_RENDER_MODE = "hybrid";
const CHAT_READY_BUNDLE_SUFFIX = ".chat";
const LLM_BUNDLE_SUFFIX = ".llm";
const PDF_RENDER_MODES = new Set(["hybrid", "text", "raster-all"]);
const LARGE_TEXT_ITEM_HEIGHT_THRESHOLD = 16;
const SHORT_LARGE_TEXT_LENGTH_THRESHOLD = 40;
const READY_TEXT_MIN_LENGTH = 80;
const OUTPUT_NAME_LIMIT = 120;
const CHAT_READY_QA_WARNING_THRESHOLD = 0.98;
const POPPLER_EXEC_MAX_BUFFER = 32 * 1024 * 1024;
const POPPLER_QA_RENDER_DPI = 36;
const POPPLER_QA_SAMPLE_STEP = 4;
const POPPLER_VISUAL_SPARSE_DENSITY_THRESHOLD = 0.12;
const POPPLER_VISUAL_SPARSE_COLUMN_COVERAGE_THRESHOLD = 0.12;
const POPPLER_PARSER_SPARSE_TEXT_LENGTH = 24;
const OCR_PAGE_TEXT_LENGTH_THRESHOLD = 48;
const PDF_TEXT_DUPLICATION_RATIO_WARNING_THRESHOLD = 1.35;
const POPPLER_COMMANDS = new Set(["pdfinfo", "pdffonts", "pdftotext", "pdftoppm"]);

const execFile = promisify(execFileCallback);

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export function normalizePdfRenderMode(value) {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  if (PDF_RENDER_MODES.has(normalized)) {
    return normalized;
  }

  throw new CliError(
    `Expected --pdf-render-mode to be one of: ${Array.from(PDF_RENDER_MODES).join(", ")}.`,
    2,
  );
}

export function parseArgs(argv) {
  const args = {
    output: null,
    profileDir: DEFAULT_PROFILE_DIR,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    headless: false,
    llmBundle: false,
    chatReady: false,
    qa: false,
    strictChatReady: false,
    qaFixtures: null,
    pdfRenderMode: DEFAULT_PDF_RENDER_MODE,
    help: false,
    explicitPdfRenderMode: false,
  };

  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "-h" || token === "--help") {
      args.help = true;
      continue;
    }

    if (token === "--headless") {
      args.headless = true;
      continue;
    }

    if (token === "--llm-bundle") {
      args.llmBundle = true;
      continue;
    }

    if (token === "--chat-ready") {
      args.chatReady = true;
      continue;
    }

    if (token === "--qa") {
      args.qa = true;
      continue;
    }

    if (token === "--strict-chat-ready") {
      args.strictChatReady = true;
      continue;
    }

    if (token === "--pdf-render-mode") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new CliError("Missing value for --pdf-render-mode.", 2);
      }
      args.pdfRenderMode = normalizePdfRenderMode(value);
      args.explicitPdfRenderMode = true;
      index += 1;
      continue;
    }

    if (token === "-o" || token === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new CliError("Missing value for --output.", 2);
      }
      args.output = value;
      index += 1;
      continue;
    }

    if (token === "--profile-dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new CliError("Missing value for --profile-dir.", 2);
      }
      args.profileDir = value;
      index += 1;
      continue;
    }

    if (token === "--timeout-ms") {
      const value = argv[index + 1];
      const parsed = Number.parseInt(value, 10);
      if (!value || Number.isNaN(parsed) || parsed <= 0) {
        throw new CliError("Expected a positive integer for --timeout-ms.", 2);
      }
      args.timeoutMs = parsed;
      index += 1;
      continue;
    }

    if (token === "--qa-fixtures") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new CliError("Missing value for --qa-fixtures.", 2);
      }
      args.qaFixtures = value;
      index += 1;
      continue;
    }

    if (token.startsWith("-")) {
      throw new CliError(`Unknown flag: ${token}`, 2);
    }

    positionals.push(token);
  }

  if (positionals.length > 1) {
    throw new CliError("Expected a single Gamma document URL.", 2);
  }

  args.inputUrl = positionals[0] ?? null;

  if (args.chatReady && args.llmBundle) {
    throw new CliError("Use either --chat-ready or --llm-bundle, not both.", 2);
  }

  if (args.chatReady && args.explicitPdfRenderMode) {
    throw new CliError("--chat-ready manages its own PDF render path; omit --pdf-render-mode.", 2);
  }

  if (args.strictChatReady && !args.chatReady) {
    throw new CliError("--strict-chat-ready requires --chat-ready.", 2);
  }

  if (args.qa && !args.chatReady) {
    throw new CliError("--qa currently requires --chat-ready.", 2);
  }

  if (args.qaFixtures && !args.chatReady) {
    throw new CliError("--qa-fixtures currently requires --chat-ready.", 2);
  }

  if (args.qaFixtures && !args.qa) {
    throw new CliError("--qa-fixtures requires --qa.", 2);
  }

  return args;
}

export function normalizeGammaUrl(input) {
  let parsed;

  try {
    parsed = new URL(input);
  } catch (error) {
    throw new CliError("Expected a valid URL.", 2);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "gamma.app" && hostname !== "www.gamma.app") {
    throw new CliError("Expected a gamma.app document URL.", 2);
  }

  if (!parsed.pathname.startsWith("/docs/")) {
    throw new CliError("Expected a Gamma document URL in the /docs/ path.", 2);
  }

  parsed.searchParams.set("mode", "doc");
  return parsed.toString();
}

export function deriveFallbackTitle(urlString) {
  const parsed = new URL(urlString);
  const slug = decodeURIComponent(parsed.pathname.replace(/^\/docs\//, ""));
  const simplified = slug.replace(/-([A-Za-z0-9]{8,})$/, "");
  const dashed = simplified || slug || "gamma-document";
  return dashed.replace(/-/g, " ");
}

export function stripGammaTitleSuffix(title) {
  return (title || "").replace(/\s+-\s+Gamma\s*$/i, "").trim();
}

export function normalizeComparableText(value) {
  return (value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function sanitizePdfTextContent(value) {
  return (value || "")
    .normalize("NFKD")
    .replace(/[\u00a0\u2000-\u200d\u2060\ufeff]/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u2022/g, "*")
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function sanitizeFilename(title) {
  const trimmed = stripGammaTitleSuffix(title).replace(/\s+/g, " ").trim();

  const safe = (trimmed || "gamma-document")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\.+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, OUTPUT_NAME_LIMIT);

  return safe || "gamma-document";
}

export function buildBundleDirectoryPath(pdfPath) {
  return buildSiblingBundleDirectoryPath(pdfPath, LLM_BUNDLE_SUFFIX);
}

export function buildChatReadyBundleDirectoryPath(pdfPath) {
  return buildSiblingBundleDirectoryPath(pdfPath, CHAT_READY_BUNDLE_SUFFIX);
}

function buildSiblingBundleDirectoryPath(pdfPath, suffix) {
  const resolvedPdfPath = path.resolve(pdfPath);
  const baseName = path.basename(resolvedPdfPath, path.extname(resolvedPdfPath));
  return path.join(path.dirname(resolvedPdfPath), `${baseName}${suffix}`);
}

function toPosixPath(value) {
  return value.split(path.sep).join(path.posix.sep);
}

export function detectPageOrientation(widthPx, heightPx) {
  return widthPx > heightPx ? "landscape" : "portrait";
}

export function mapPageNumberProportionally(pageNumber, sourcePageCount, targetPageCount) {
  const normalizedPageNumber = Number.parseInt(pageNumber, 10);
  const normalizedSourcePageCount = Math.max(1, Number.parseInt(sourcePageCount, 10) || 1);
  const normalizedTargetPageCount = Math.max(1, Number.parseInt(targetPageCount, 10) || 1);

  if (!Number.isFinite(normalizedPageNumber) || normalizedPageNumber <= 1) {
    return 1;
  }

  if (normalizedSourcePageCount === normalizedTargetPageCount) {
    return Math.min(normalizedPageNumber, normalizedTargetPageCount);
  }

  return Math.min(
    normalizedTargetPageCount,
    Math.max(
      1,
      Math.floor(((normalizedPageNumber - 1) * normalizedTargetPageCount) / normalizedSourcePageCount) + 1,
    ),
  );
}

export function buildBundleManifest({
  bundleDir,
  pdfPath,
  sourceUrl,
  title,
  generatedAt = new Date().toISOString(),
  pageCount,
  pages,
}) {
  return {
    sourceUrl,
    title: stripGammaTitleSuffix(title),
    generatedAt,
    pdfFile: toPosixPath(path.relative(bundleDir, pdfPath)),
    pageCount,
    paperSize: "letter",
    imageScale: DEFAULT_LLM_IMAGE_SCALE,
    pages: pages.map((page) => ({
      pageNumber: page.pageNumber,
      imageFile: toPosixPath(page.imageFile),
      widthPx: page.widthPx,
      heightPx: page.heightPx,
      orientation: page.orientation || detectPageOrientation(page.widthPx, page.heightPx),
    })),
  };
}

export function isLikelyRasterizationCandidate(candidate) {
  const shortLargeItemCount = candidate.shortLargeItemCount ?? 0;
  const digitLargeItemCount = candidate.digitLargeItemCount ?? 0;
  const averageShortLargeWidth = candidate.averageShortLargeWidth ?? 0;
  const verticalSpread = candidate.verticalSpread ?? 0;
  const leftAlignedLargeItemCount = candidate.leftAlignedLargeItemCount ?? 0;
  const rightAlignedLargeItemCount = candidate.rightAlignedLargeItemCount ?? 0;
  const balancedSides = leftAlignedLargeItemCount >= 6 && rightAlignedLargeItemCount >= 6;

  const digitHeavyInfographic =
    shortLargeItemCount >= 18 &&
    digitLargeItemCount >= 4 &&
    verticalSpread >= 220 &&
    balancedSides;

  const wideDistributedLabels =
    shortLargeItemCount >= 24 &&
    averageShortLargeWidth >= 70 &&
    verticalSpread >= 240 &&
    balancedSides;

  return digitHeavyInfographic || wideDistributedLabels;
}

export function isLikelyDomRasterizationCandidate(candidate) {
  const digitMarkerCount = candidate.digitMarkerCount ?? 0;
  const headingBlockCount = candidate.headingBlockCount ?? 0;
  const visualCount = candidate.visualCount ?? 0;
  const leftHeadingCount = candidate.leftHeadingCount ?? 0;
  const rightHeadingCount = candidate.rightHeadingCount ?? 0;
  const topHeadingCount = candidate.topHeadingCount ?? 0;
  const bottomHeadingCount = candidate.bottomHeadingCount ?? 0;
  const balancedSides = leftHeadingCount >= 2 && rightHeadingCount >= 2;
  const distributedHeadings = topHeadingCount >= 2 && bottomHeadingCount >= 2;

  return (
    visualCount >= 1 &&
    balancedSides &&
    ((digitMarkerCount >= 4 && headingBlockCount >= 6) ||
      (headingBlockCount >= 8 && distributedHeadings))
  );
}

export function isLikelyHeroRasterCandidate(candidate) {
  const gradientSignalCount = candidate.gradientSignalCount ?? 0;
  const fontSize = candidate.fontSize ?? 0;
  const width = candidate.width ?? 0;
  const textLength = candidate.textLength ?? 0;
  const top = candidate.top ?? Number.POSITIVE_INFINITY;
  const headingLike = Boolean(candidate.headingLike);

  return (
    headingLike &&
    gradientSignalCount >= 1 &&
    fontSize >= 42 &&
    width >= 320 &&
    textLength >= 12 &&
    textLength <= 240 &&
    top <= DEFAULT_PRINTABLE_PAGE_HEIGHT_PX * 0.45
  );
}

export function isLikelyLandscapeSpreadCandidate(candidate) {
  const width = candidate.width ?? 0;
  const height = candidate.height ?? 0;
  const textLength = candidate.textLength ?? 0;
  const visualCount = candidate.visualCount ?? 0;
  const absoluteLikeCount = candidate.absoluteLikeCount ?? 0;
  const shortHeadingCount = candidate.shortHeadingCount ?? 0;
  const digitMarkerCount = candidate.digitMarkerCount ?? 0;
  const distributedLabelCount = candidate.distributedLabelCount ?? 0;
  const lowTextDensity = candidate.lowTextDensity ?? false;

  return (
    width >= DEFAULT_PRINTABLE_PAGE_WIDTH_PX * 0.6 &&
    height >= 260 &&
    height <= DEFAULT_PRINTABLE_PAGE_HEIGHT_PX * 1.35 &&
    textLength <= 420 &&
    lowTextDensity &&
    (visualCount >= 1 || absoluteLikeCount >= 4) &&
    (digitMarkerCount >= 2 || shortHeadingCount >= 4 || distributedLabelCount >= 4)
  );
}

export function shouldForceBreakBeforeSection(
  candidate,
  printablePageHeightPx = DEFAULT_PRINTABLE_PAGE_HEIGHT_PX,
) {
  const offsetWithinPage = candidate.offsetWithinPage ?? 0;
  const remainingSpace = printablePageHeightPx - offsetWithinPage;
  const desiredSpace = Math.min(
    Math.max((candidate.height ?? 0) + 36, 220),
    printablePageHeightPx * 0.55,
  );
  const startsNearTop = offsetWithinPage <= 40;

  return !startsNearTop && remainingSpace < desiredSpace;
}

export function isLikelyChromeElement(candidate, { pageTitle = "" } = {}) {
  const normalizedText = normalizeComparableText(candidate.text);
  const normalizedTitle = normalizeComparableText(stripGammaTitleSuffix(pageTitle));
  const topBand = candidate.top <= Math.max(candidate.viewportHeight * 0.18, 150);
  const headerSized = candidate.height <= 140 && candidate.width >= candidate.viewportWidth * 0.2;
  const compact = candidate.width <= 96 && candidate.height <= 96;
  const rightBadgeZone = candidate.right >= candidate.viewportWidth * 0.72;

  if (candidate.isFixedLike && topBand && headerSized) {
    return true;
  }

  if (
    topBand &&
    headerSized &&
    normalizedTitle &&
    (normalizedText === normalizedTitle || normalizedText.startsWith(`${normalizedTitle} `))
  ) {
    return true;
  }

  if (topBand && rightBadgeZone && compact && /^[A-Z]{1,3}$/.test((candidate.text || "").trim())) {
    return true;
  }

  if (
    candidate.isFixedLike &&
    rightBadgeZone &&
    candidate.height <= 120 &&
    candidate.width <= 240 &&
    candidate.interactiveScore > 0
  ) {
    return true;
  }

  return false;
}

export function isKeepTogetherCandidate(
  candidate,
  printablePageHeightPx = DEFAULT_PRINTABLE_PAGE_HEIGHT_PX,
) {
  const maxKeepTogetherHeight = printablePageHeightPx * 0.82;

  if (candidate.isRoot || candidate.isFixedLike || candidate.isScrollable) {
    return false;
  }

  if (candidate.width < 280 || candidate.height < 72) {
    return false;
  }

  if (candidate.height > maxKeepTogetherHeight) {
    return false;
  }

  if (candidate.hasVisualContainer && candidate.height >= 72) {
    return true;
  }

  if (candidate.hasMedia && candidate.height >= 120) {
    return true;
  }

  if (candidate.hasHeading && candidate.hasDenseText && candidate.height >= 140) {
    return true;
  }

  if (candidate.hasList && candidate.hasDenseText && candidate.height >= 160) {
    return true;
  }

  return false;
}

export function classifyPageState({ url, title, bodyText, contentScore }) {
  const haystack = `${title}\n${bodyText}\n${url}`.toLowerCase();

  if (
    /just a moment|verify you are human|cloudflare|checking your browser|attention required/.test(
      haystack,
    )
  ) {
    return "challenge";
  }

  if (
    /sign in|log in|continue with google|continue with email|magic link|workspace login|gamma login/.test(
      haystack,
    )
  ) {
    return "login";
  }

  if (
    /ask the creator for access|request access|private gamma|private doc|does not have access|you need access|you don't have access|not shared with you|permission/.test(
      haystack,
    )
  ) {
    return "access-denied";
  }

  if (/not found|404|page not found|doesn't exist|does not exist/.test(haystack)) {
    return "not-found";
  }

  if (contentScore >= READY_TEXT_MIN_LENGTH) {
    return "ready";
  }

  return "loading";
}

export function isDirectExecution(scriptPath) {
  if (!process.argv[1]) {
    return false;
  }

  return pathToFileURL(process.argv[1]).href === pathToFileURL(scriptPath).href;
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function getChromeExecutablePath() {
  const candidates = [
    process.env.GAMMA_TO_PDF_CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/snap/bin/chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function baseLaunchOptions(headless) {
  return {
    acceptDownloads: true,
    headless,
    ignoreHTTPSErrors: true,
    viewport: DEFAULT_VIEWPORT,
    args: [
      "--disable-dev-shm-usage",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
    ],
  };
}

async function launchContext(profileDir, headless) {
  const executablePath = getChromeExecutablePath();
  const attempts = [];

  if (executablePath) {
    attempts.push({
      name: `Chrome executable at ${executablePath}`,
      options: {
        ...baseLaunchOptions(headless),
        executablePath,
      },
    });
  }

  attempts.push({
    name: "Playwright chrome channel",
    options: {
      ...baseLaunchOptions(headless),
      channel: "chrome",
    },
  });

  attempts.push({
    name: "Playwright bundled chromium",
    options: baseLaunchOptions(headless),
  });

  let lastError;
  for (const attempt of attempts) {
    try {
      return await chromium.launchPersistentContext(profileDir, attempt.options);
    } catch (error) {
      lastError = error;
    }
  }

  throw new CliError(
    `Unable to launch Chrome/Chromium. Install Google Chrome or run "npx playwright install chromium".\n${lastError?.message ?? ""}`,
    1,
  );
}

async function collectSignals(page) {
  return page.evaluate(() => {
    const bodyText = document.body?.innerText?.replace(/\s+/g, " ").trim() ?? "";
    const taggedRoot = document.querySelector("[data-gamma-to-pdf-scroll-root='true']");
    const scrollRoot =
      taggedRoot instanceof HTMLElement
        ? taggedRoot
        : document.scrollingElement || document.documentElement;
    const images = Array.from(document.images ?? []);
    const pendingImages = images.filter((image) => !image.complete).length;
    const contentScore =
      bodyText.length +
      Math.min(images.length * 30, 300) +
      Math.min(scrollRoot?.scrollHeight ?? 0, 5000) / 10;

    return {
      url: window.location.href,
      title: document.title ?? "",
      bodyText: bodyText.slice(0, 4000),
      pendingImages,
      scrollHeight: scrollRoot?.scrollHeight ?? 0,
      contentScore,
    };
  });
}

async function detectScrollableLayout(page) {
  return page.evaluate(() => {
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const root = document.scrollingElement || document.documentElement;

    const clearAttribute = (name) => {
      document.querySelectorAll(`[${name}]`).forEach((node) => node.removeAttribute(name));
    };

    clearAttribute("data-gamma-to-pdf-scroll-root");
    clearAttribute("data-gamma-to-pdf-expand");
    clearAttribute("data-gamma-to-pdf-hide");

    const candidates = [root, ...document.querySelectorAll("body *")];
    let bestElement = root;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const node of candidates) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }

      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const visible =
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0";

      if (!visible) {
        continue;
      }

      const scrollDelta = node.scrollHeight - node.clientHeight;
      const likelyScrollable =
        scrollDelta > 200 || style.overflowY === "auto" || style.overflowY === "scroll";

      if (likelyScrollable && node.clientHeight <= viewportHeight * 1.6) {
        node.setAttribute("data-gamma-to-pdf-expand", "true");
      }

      if (
        (style.position === "fixed" || style.position === "sticky") &&
        rect.height <= viewportHeight * 0.25 &&
        rect.width >= viewportWidth * 0.3
      ) {
        node.setAttribute("data-gamma-to-pdf-hide", "true");
      }

      if (!likelyScrollable) {
        continue;
      }

      const score =
        scrollDelta +
        Math.min(rect.width, viewportWidth) +
        Math.min(node.clientHeight, viewportHeight) -
        (style.position === "fixed" || style.position === "sticky" ? 1000 : 0);

      if (score > bestScore) {
        bestScore = score;
        bestElement = node;
      }
    }

    if (bestElement instanceof HTMLElement) {
      bestElement.setAttribute("data-gamma-to-pdf-scroll-root", "true");
    }

    return {
      tagName: bestElement?.tagName ?? "HTML",
      className:
        bestElement instanceof HTMLElement
          ? typeof bestElement.className === "string"
            ? bestElement.className
            : ""
          : "",
      scrollHeight: bestElement?.scrollHeight ?? root.scrollHeight ?? 0,
      clientHeight: bestElement?.clientHeight ?? root.clientHeight ?? 0,
    };
  });
}

async function applyPrintLayoutHints(page, pageTitle) {
  return page.evaluate(
    ({ pageTitle, printablePageHeightPx }) => {
      const normalizeComparableText = (value) =>
        (value || "").replace(/\s+/g, " ").trim().toLowerCase();

      const stripGammaTitleSuffix = (value) =>
        (value || "").replace(/\s+-\s+Gamma\s*$/i, "").trim();

      const isLikelyChromeElement = (candidate, { pageTitle = "" } = {}) => {
        const normalizedText = normalizeComparableText(candidate.text);
        const normalizedTitle = normalizeComparableText(stripGammaTitleSuffix(pageTitle));
        const topBand = candidate.top <= Math.max(candidate.viewportHeight * 0.18, 150);
        const headerSized =
          candidate.height <= 140 && candidate.width >= candidate.viewportWidth * 0.2;
        const compact = candidate.width <= 96 && candidate.height <= 96;
        const rightBadgeZone = candidate.right >= candidate.viewportWidth * 0.72;

        if (candidate.isFixedLike && topBand && headerSized) {
          return true;
        }

        if (
          topBand &&
          headerSized &&
          normalizedTitle &&
          (normalizedText === normalizedTitle || normalizedText.startsWith(`${normalizedTitle} `))
        ) {
          return true;
        }

        if (
          topBand &&
          rightBadgeZone &&
          compact &&
          /^[A-Z]{1,3}$/.test((candidate.text || "").trim())
        ) {
          return true;
        }

        if (
          candidate.isFixedLike &&
          rightBadgeZone &&
          candidate.height <= 120 &&
          candidate.width <= 240 &&
          candidate.interactiveScore > 0
        ) {
          return true;
        }

        return false;
      };

      const isKeepTogetherCandidate = (candidate, printablePageHeightPx = 1056) => {
        const maxKeepTogetherHeight = printablePageHeightPx * 0.82;

        if (candidate.isRoot || candidate.isFixedLike || candidate.isScrollable) {
          return false;
        }

        if (candidate.width < 280 || candidate.height < 72) {
          return false;
        }

        if (candidate.height > maxKeepTogetherHeight) {
          return false;
        }

        if (candidate.hasVisualContainer && candidate.height >= 72) {
          return true;
        }

        if (candidate.hasMedia && candidate.height >= 120) {
          return true;
        }

        if (candidate.hasHeading && candidate.hasDenseText && candidate.height >= 140) {
          return true;
        }

        if (candidate.hasList && candidate.hasDenseText && candidate.height >= 160) {
          return true;
        }

        return false;
      };

      const clearAttribute = (name) => {
        document.querySelectorAll(`[${name}]`).forEach((node) => node.removeAttribute(name));
      };

      clearAttribute("data-gamma-to-pdf-hide");
      clearAttribute("data-gamma-to-pdf-keep-together");
      clearAttribute("data-gamma-to-pdf-allow-split");
      clearAttribute("data-gamma-to-pdf-heading");
      clearAttribute("data-gamma-to-pdf-primary-content");
      clearAttribute("data-gamma-to-pdf-force-break-before");

      const defaultRoot = document.scrollingElement || document.documentElement;
      const taggedRoot = document.querySelector("[data-gamma-to-pdf-scroll-root='true']");
      const scrollRoot = taggedRoot instanceof HTMLElement ? taggedRoot : defaultRoot;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const elements = Array.from(document.querySelectorAll("body *")).filter(
        (node) => node instanceof HTMLElement,
      );

      const isVisible = (node) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0"
        );
      };

      const hasTaggedAncestor = (node, attributeName) =>
        Boolean(node.parentElement?.closest(`[${attributeName}]`));

      const collectSummary = (node) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        const text = (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 240);
        const backgroundColor = style.backgroundColor || "";
        const borderWidth =
          Number.parseFloat(style.borderTopWidth) +
          Number.parseFloat(style.borderRightWidth) +
          Number.parseFloat(style.borderBottomWidth) +
          Number.parseFloat(style.borderLeftWidth);
        const borderRadius = Number.parseFloat(style.borderTopLeftRadius) || 0;
        const fontSize = Number.parseFloat(style.fontSize) || 0;
        const numericFontWeight = Number.parseInt(style.fontWeight, 10);
        const fontWeight = Number.isNaN(numericFontWeight) ? 400 : numericFontWeight;
        const interactiveScore = node.querySelectorAll(
          'button, a[href], input, textarea, select, [role="button"]',
        ).length;
        const mediaCount = node.querySelectorAll("img, svg, canvas, video, picture, figure").length;
        const listCount = node.querySelectorAll("ul, ol, li").length;
        const paragraphCount = node.querySelectorAll("p, blockquote").length;
        const headingCount = node.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading']").length;
        const hasLargeTypeHeading =
          fontSize >= 24 || (fontSize >= 20 && fontWeight >= 600 && text.length <= 180);
        const headingLike = headingCount > 0 || hasLargeTypeHeading;
        const isScrollable =
          node.scrollHeight > node.clientHeight + 200 ||
          style.overflowY === "auto" ||
          style.overflowY === "scroll";
        const hasVisualContainer =
          (backgroundColor &&
            backgroundColor !== "rgba(0, 0, 0, 0)" &&
            backgroundColor !== "transparent") ||
          borderWidth > 0 ||
          borderRadius > 0 ||
          style.boxShadow !== "none";

        return {
          node,
          text,
          width: rect.width,
          height: rect.height,
          top: rect.top,
          bottom: rect.bottom,
          right: rect.right,
          viewportWidth,
          viewportHeight,
          interactiveScore,
          isFixedLike: style.position === "fixed" || style.position === "sticky",
          isScrollable,
          isRoot:
            node === document.body ||
            node === document.documentElement ||
            node === defaultRoot ||
            node === scrollRoot,
          hasVisualContainer,
          hasMedia: mediaCount > 0,
          hasList: listCount > 0,
          hasHeading: headingLike,
          hasDenseText: text.length >= 140 || paragraphCount > 0 || listCount > 1,
        };
      };

      const visibleElements = elements.filter(isVisible);
      const summaries = visibleElements.map(collectSummary);

      for (const summary of summaries) {
        if (isLikelyChromeElement(summary, { pageTitle })) {
          summary.node.setAttribute("data-gamma-to-pdf-hide", "true");
        }
      }

      const firstSubstantialBlock = summaries
        .filter(
          (summary) =>
            !summary.node.hasAttribute("data-gamma-to-pdf-hide") &&
            !summary.isFixedLike &&
            summary.width >= viewportWidth * 0.45 &&
            summary.height >= 220 &&
            summary.top >= -20 &&
            summary.top <= viewportHeight * 1.5,
        )
        .sort((left, right) => left.top - right.top || right.height - left.height)[0];

      if (firstSubstantialBlock) {
        firstSubstantialBlock.node.setAttribute("data-gamma-to-pdf-primary-content", "true");
        const anchorTop = firstSubstantialBlock.top;

        for (const summary of summaries) {
          if (summary.node === firstSubstantialBlock.node) {
            continue;
          }

          const insidePrimary = firstSubstantialBlock.node.contains(summary.node);
          const beforePrimary =
            summary.bottom <= anchorTop + 12 &&
            summary.top <= Math.max(anchorTop, viewportHeight * 0.25);

          if (!insidePrimary && beforePrimary && summary.height <= 160) {
            summary.node.setAttribute("data-gamma-to-pdf-hide", "true");
          }
        }

        let sibling = firstSubstantialBlock.node.previousElementSibling;
        while (sibling) {
          if (sibling instanceof HTMLElement && isVisible(sibling)) {
            sibling.setAttribute("data-gamma-to-pdf-hide", "true");
          }
          sibling = sibling.previousElementSibling;
        }
      }

      for (const summary of summaries) {
        if (
          summary.node.hasAttribute("data-gamma-to-pdf-hide") ||
          hasTaggedAncestor(summary.node, "data-gamma-to-pdf-hide")
        ) {
          continue;
        }

        if (
          summary.hasHeading &&
          summary.height <= 180 &&
          summary.width >= 240 &&
          summary.text.length <= 220
        ) {
          summary.node.setAttribute("data-gamma-to-pdf-heading", "true");
        }

        if (
          hasTaggedAncestor(summary.node, "data-gamma-to-pdf-keep-together") ||
          summary.node.hasAttribute("data-gamma-to-pdf-heading")
        ) {
          continue;
        }

        if (isKeepTogetherCandidate(summary, printablePageHeightPx)) {
          summary.node.setAttribute("data-gamma-to-pdf-keep-together", "true");
        } else if (
          summary.height > printablePageHeightPx * 0.82 &&
          summary.width >= 280 &&
          !summary.isRoot
        ) {
          summary.node.setAttribute("data-gamma-to-pdf-allow-split", "true");
        }
      }

      const toAbsoluteTop = (node) => {
        const rect = node.getBoundingClientRect();
        return rect.top + window.scrollY;
      };

      for (const summary of summaries) {
        if (
          summary.node.hasAttribute("data-gamma-to-pdf-hide") ||
          hasTaggedAncestor(summary.node, "data-gamma-to-pdf-hide")
        ) {
          continue;
        }

        const isSectionStartCandidate =
          summary.node.hasAttribute("data-gamma-to-pdf-heading") ||
          (summary.node.hasAttribute("data-gamma-to-pdf-keep-together") && summary.hasHeading);

        if (!isSectionStartCandidate) {
          continue;
        }

        const absoluteTop = toAbsoluteTop(summary.node);
        const offsetWithinPage = absoluteTop % printablePageHeightPx;
        const remainingSpace = printablePageHeightPx - offsetWithinPage;
        const desiredSpace = Math.min(
          Math.max(summary.height + 36, 220),
          printablePageHeightPx * 0.55,
        );
        const startsNearTop = offsetWithinPage <= 40;

        if (!startsNearTop && remainingSpace < desiredSpace) {
          summary.node.setAttribute("data-gamma-to-pdf-force-break-before", "true");
        }
      }

      return {
        hidden: document.querySelectorAll("[data-gamma-to-pdf-hide='true']").length,
        keepTogether: document.querySelectorAll("[data-gamma-to-pdf-keep-together='true']").length,
        headings: document.querySelectorAll("[data-gamma-to-pdf-heading='true']").length,
        forcedBreaks: document.querySelectorAll("[data-gamma-to-pdf-force-break-before='true']").length,
      };
    },
    { pageTitle, printablePageHeightPx: DEFAULT_PRINTABLE_PAGE_HEIGHT_PX },
  );
}

async function getActiveScrollMetrics(page) {
  return page.evaluate(() => {
    const taggedRoot = document.querySelector("[data-gamma-to-pdf-scroll-root='true']");
    const defaultRoot = document.scrollingElement || document.documentElement;
    const target =
      taggedRoot instanceof HTMLElement ? taggedRoot : defaultRoot;
    const usesWindow =
      target === document.body || target === document.documentElement || target === defaultRoot;

    return {
      top: usesWindow ? defaultRoot.scrollTop : target.scrollTop,
      height: target.scrollHeight,
      viewportHeight: usesWindow ? window.innerHeight : target.clientHeight,
      usesWindow,
    };
  });
}

async function setActiveScrollTop(page, value) {
  await page.evaluate((nextTop) => {
    const taggedRoot = document.querySelector("[data-gamma-to-pdf-scroll-root='true']");
    const defaultRoot = document.scrollingElement || document.documentElement;
    const target =
      taggedRoot instanceof HTMLElement ? taggedRoot : defaultRoot;
    const usesWindow =
      target === document.body || target === document.documentElement || target === defaultRoot;

    if (usesWindow) {
      window.scrollTo(0, nextTop);
      return;
    }

    target.scrollTop = nextTop;
  }, value);
}

async function waitForFonts(page) {
  await page.evaluate(async () => {
    if (document.fonts?.ready) {
      await document.fonts.ready;
    }
  });
}

async function waitForImages(page, deadline) {
  while (Date.now() < deadline) {
    const pendingImages = await page.evaluate(
      () => Array.from(document.images ?? []).filter((image) => !image.complete).length,
    );
    if (pendingImages === 0) {
      return;
    }
    await page.waitForTimeout(300);
  }
}

async function waitForStableHeight(page, deadline) {
  let lastHeight = -1;
  let stableChecks = 0;

  while (Date.now() < deadline) {
    const { height } = await getActiveScrollMetrics(page);

    if (height === lastHeight) {
      stableChecks += 1;
    } else {
      stableChecks = 0;
      lastHeight = height;
    }

    if (stableChecks >= 2) {
      return;
    }

    await page.waitForTimeout(350);
  }
}

async function autoScrollDocument(page, deadline) {
  await detectScrollableLayout(page);
  let stableBottomChecks = 0;

  while (Date.now() < deadline) {
    const metrics = await getActiveScrollMetrics(page);

    const maxTop = Math.max(metrics.height - metrics.viewportHeight, 0);
    const nextTop = Math.min(
      metrics.top + Math.max(Math.floor(metrics.viewportHeight * 0.85), 450),
      maxTop,
    );

    await setActiveScrollTop(page, nextTop);

    await page.waitForTimeout(250);

    const { height: newHeight } = await getActiveScrollMetrics(page);

    const atBottom = nextTop >= Math.max(newHeight - metrics.viewportHeight - 5, 0);
    if (atBottom && newHeight === metrics.height) {
      stableBottomChecks += 1;
    } else {
      stableBottomChecks = 0;
    }

    if (stableBottomChecks >= 2) {
      break;
    }
  }

  await setActiveScrollTop(page, 0);
}

async function waitForGammaDocument(page, normalizedUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastObservedState = null;

  await page.goto(normalizedUrl, {
    timeout: Math.min(timeoutMs, 60_000),
    waitUntil: "domcontentloaded",
  });

  while (Date.now() < deadline) {
    const signals = await collectSignals(page);
    const state = classifyPageState(signals);

    if (state !== lastObservedState) {
      if (state === "challenge") {
        console.error("Gamma is asking for human verification. Complete it in the browser window.");
      } else if (state === "login") {
        console.error("Gamma requires login. Sign in in the browser window to continue.");
      }
      lastObservedState = state;
    }

    if (state === "access-denied") {
      throw new CliError("The signed-in Gamma account does not have access to this document.", 3);
    }

    if (state === "not-found") {
      throw new CliError("Gamma could not find this document.", 3);
    }

    if (state === "ready") {
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await waitForFonts(page);
      await waitForImages(page, deadline);
      await autoScrollDocument(page, deadline);
      await waitForLoadStateSafe(page);
      await waitForFonts(page);
      await waitForImages(page, deadline);
      await waitForStableHeight(page, deadline);
      return await collectSignals(page);
    }

    await page.waitForTimeout(1000);
  }

  throw new CliError("Timed out waiting for Gamma login, verification, or document render.", 4);
}

async function waitForLoadStateSafe(page) {
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
}

async function injectPrintStyles(page) {
  await page.addStyleTag({
    content: `
      @page { margin: 0; size: Letter; }
      html {
        height: auto !important;
        overflow: visible !important;
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
      body {
        margin: 0 !important;
        height: auto !important;
        overflow: visible !important;
      }
      p, li, blockquote {
        orphans: 3;
        widows: 3;
      }
      [data-gamma-to-pdf-scroll-root="true"],
      [data-gamma-to-pdf-expand="true"] {
        height: auto !important;
        max-height: none !important;
        overflow: visible !important;
        overflow-y: visible !important;
      }
      [data-gamma-to-pdf-hide="true"] {
        display: none !important;
      }
      [data-gamma-to-pdf-primary-content="true"] {
        margin-top: 0 !important;
      }
      [data-gamma-to-pdf-heading="true"] {
        break-after: avoid-page !important;
        page-break-after: avoid !important;
      }
      [data-gamma-to-pdf-keep-together="true"] {
        break-inside: avoid-page !important;
        page-break-inside: avoid !important;
      }
      [data-gamma-to-pdf-allow-split="true"] {
        break-inside: auto !important;
        page-break-inside: auto !important;
      }
      [data-gamma-to-pdf-force-break-before="true"] {
        break-before: page !important;
        page-break-before: always !important;
      }
      [data-gamma-to-pdf-rasterized-section="true"] {
        break-inside: avoid-page !important;
        page-break-inside: avoid !important;
      }
    `,
  });
}

async function planRenderOverrides(page) {
  return page.evaluate(({ printablePageWidthPx, printablePageHeightPx }) => {
    const normalizeText = (value) => (value || "").replace(/\s+/g, " ").trim();
    const clearAttribute = (name) => {
      document.querySelectorAll(`[${name}]`).forEach((node) => node.removeAttribute(name));
    };
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }

      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0"
      );
    };
    const isTransparentColor = (value) =>
      /transparent|rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/i.test(String(value || ""));
    const isLikelyHeroRasterCandidate = (candidate) => {
      const gradientSignalCount = candidate.gradientSignalCount ?? 0;
      const fontSize = candidate.fontSize ?? 0;
      const width = candidate.width ?? 0;
      const textLength = candidate.textLength ?? 0;
      const top = candidate.top ?? Number.POSITIVE_INFINITY;
      const headingLike = Boolean(candidate.headingLike);

      return (
        headingLike &&
        gradientSignalCount >= 1 &&
        fontSize >= 42 &&
        width >= 320 &&
        textLength >= 12 &&
        textLength <= 240 &&
        top <= printablePageHeightPx * 0.45
      );
    };
    const isLikelyLandscapeSpreadCandidate = (candidate) => {
      const width = candidate.width ?? 0;
      const height = candidate.height ?? 0;
      const textLength = candidate.textLength ?? 0;
      const visualCount = candidate.visualCount ?? 0;
      const absoluteLikeCount = candidate.absoluteLikeCount ?? 0;
      const shortHeadingCount = candidate.shortHeadingCount ?? 0;
      const digitMarkerCount = candidate.digitMarkerCount ?? 0;
      const distributedLabelCount = candidate.distributedLabelCount ?? 0;
      const lowTextDensity = candidate.lowTextDensity ?? false;

      return (
        width >= printablePageWidthPx * 0.6 &&
        height >= 260 &&
        height <= printablePageHeightPx * 1.35 &&
        textLength <= 420 &&
        lowTextDensity &&
        (visualCount >= 1 || absoluteLikeCount >= 4) &&
        (digitMarkerCount >= 2 || shortHeadingCount >= 4 || distributedLabelCount >= 4)
      );
    };

    clearAttribute("data-gamma-to-pdf-hero-raster-id");
    clearAttribute("data-gamma-to-pdf-landscape-spread-id");

    const primaryRoot =
      document.querySelector("[data-gamma-to-pdf-primary-content='true']") ||
      document.querySelector("[data-gamma-to-pdf-scroll-root='true']") ||
      document.body;

    if (!(primaryRoot instanceof HTMLElement)) {
      return { heroRasters: [], landscapeSpreads: [] };
    }

    const rootRect = primaryRoot.getBoundingClientRect();
    const acceptedHeroNodes = [];
    const acceptedSpreadNodes = [];
    const heroRasters = [];
    const landscapeSpreads = [];

    const hasAcceptedAncestor = (node, acceptedNodes) =>
      acceptedNodes.some((accepted) => accepted === node || accepted.contains(node));

    for (const node of Array.from(primaryRoot.querySelectorAll("*"))) {
      if (!(node instanceof HTMLElement) || !isVisible(node)) {
        continue;
      }

      if (node.closest("[data-gamma-to-pdf-hide='true']")) {
        continue;
      }

      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const text = normalizeText(node.innerText || node.textContent || "");
      const fontSize = Number.parseFloat(style.fontSize) || 0;
      const fontWeight = Number.parseInt(style.fontWeight, 10) || 400;
      const headingLike =
        /^h[1-6]$/i.test(node.tagName) ||
        node.getAttribute("role") === "heading" ||
        node.hasAttribute("data-gamma-to-pdf-heading") ||
        (fontSize >= 42 && fontWeight >= 600);
      const gradientSignalCount = [
        style.backgroundImage && style.backgroundImage !== "none",
        String(style.backgroundClip || "").includes("text"),
        String(style.webkitBackgroundClip || "").includes("text"),
        isTransparentColor(style.webkitTextFillColor),
        isTransparentColor(style.color),
      ].filter(Boolean).length;

      if (
        !hasAcceptedAncestor(node, acceptedHeroNodes) &&
        isLikelyHeroRasterCandidate({
          gradientSignalCount,
          fontSize,
          width: rect.width,
          textLength: text.length,
          top: rect.top + window.scrollY,
          headingLike,
        })
      ) {
        const heroId = `hero-${String(heroRasters.length + 1).padStart(3, "0")}`;
        node.setAttribute("data-gamma-to-pdf-hero-raster-id", heroId);
        node.setAttribute("data-gamma-to-pdf-keep-together", "true");
        acceptedHeroNodes.push(node);
        heroRasters.push({
          id: heroId,
          text,
        });
      }
    }

    for (const node of Array.from(primaryRoot.querySelectorAll("*"))) {
      if (!(node instanceof HTMLElement) || !isVisible(node)) {
        continue;
      }

      if (
        node.closest("[data-gamma-to-pdf-hide='true']") ||
        node.closest("[data-gamma-to-pdf-hero-raster-id]") ||
        hasAcceptedAncestor(node, acceptedSpreadNodes)
      ) {
        continue;
      }

      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const text = normalizeText(node.innerText || node.textContent || "");

      if (
        style.position === "fixed" ||
        style.position === "sticky" ||
        rect.width < Math.max(rootRect.width * 0.55, 460) ||
        rect.height < 260 ||
        rect.height > printablePageHeightPx * 1.35 ||
        text.length > 420
      ) {
        continue;
      }

      let visualCount = 0;
      let absoluteLikeCount = 0;
      let shortHeadingCount = 0;
      let digitMarkerCount = 0;
      const labelPositions = [];

      for (const descendant of Array.from(node.querySelectorAll("*"))) {
        if (!(descendant instanceof HTMLElement) || !isVisible(descendant)) {
          continue;
        }

        const descendantStyle = getComputedStyle(descendant);
        const descendantRect = descendant.getBoundingClientRect();
        const descendantText = normalizeText(descendant.innerText || descendant.textContent || "");
        if (!descendantText && descendant.childElementCount > 0) {
          continue;
        }

        if (/^(IMG|SVG|CANVAS|FIGURE|PICTURE)$/i.test(descendant.tagName)) {
          visualCount += 1;
        }

        if (
          descendantStyle.position === "absolute" ||
          descendantStyle.position === "sticky" ||
          descendantStyle.transform !== "none"
        ) {
          absoluteLikeCount += 1;
        }

        const descendantFontSize = Number.parseFloat(descendantStyle.fontSize) || 0;
        const descendantFontWeight = Number.parseInt(descendantStyle.fontWeight, 10) || 400;
        if (
          descendantText.length >= 1 &&
          descendantText.length <= 80 &&
          descendantRect.width <= rect.width * 0.85 &&
          descendantRect.height <= 220 &&
          (descendantFontSize >= 16 || descendantFontWeight >= 600)
        ) {
          shortHeadingCount += 1;
          labelPositions.push({
            x: descendantRect.left - rect.left + descendantRect.width / 2,
            y: descendantRect.top - rect.top + descendantRect.height / 2,
          });
        }

        if (/^\d{1,2}$/.test(descendantText) && descendantFontSize >= 16) {
          digitMarkerCount += 1;
        }
      }

      const leftLabelCount = labelPositions.filter((item) => item.x <= rect.width * 0.35).length;
      const rightLabelCount = labelPositions.filter((item) => item.x >= rect.width * 0.65).length;
      const distributedLabelCount =
        (leftLabelCount >= 2 ? 2 : 0) +
        (rightLabelCount >= 2 ? 2 : 0) +
        (labelPositions.filter((item) => item.y <= rect.height * 0.35).length >= 2 ? 1 : 0) +
        (labelPositions.filter((item) => item.y >= rect.height * 0.65).length >= 2 ? 1 : 0);
      const lowTextDensity = text.length <= 220 || text.length / Math.max(rect.width * rect.height, 1) < 0.00045;

      if (
        !isLikelyLandscapeSpreadCandidate({
          width: rect.width,
          height: rect.height,
          textLength: text.length,
          visualCount,
          absoluteLikeCount,
          shortHeadingCount,
          digitMarkerCount,
          distributedLabelCount,
          lowTextDensity,
        })
      ) {
        continue;
      }

      const spreadId = `spread-${String(landscapeSpreads.length + 1).padStart(3, "0")}`;
      const markerText = `__GAMMA_TO_PDF_LANDSCAPE_SPREAD_${spreadId.toUpperCase()}__`;
      node.setAttribute("data-gamma-to-pdf-landscape-spread-id", spreadId);
      node.setAttribute("data-gamma-to-pdf-keep-together", "true");
      acceptedSpreadNodes.push(node);
      landscapeSpreads.push({
        id: spreadId,
        markerText,
        text,
      });
    }

    return {
      heroRasters,
      landscapeSpreads,
    };
  }, {
    printablePageWidthPx: DEFAULT_PRINTABLE_PAGE_WIDTH_PX,
    printablePageHeightPx: DEFAULT_PRINTABLE_PAGE_HEIGHT_PX,
  });
}

async function replaceNodeWithImage(page, attributeName, id, imageBuffer, { maxWidth = "100%" } = {}) {
  const dataUrl = `data:image/png;base64,${imageBuffer.toString("base64")}`;
  return page.evaluate(
    ({ attributeName, id, dataUrl, maxWidth }) => {
      const node = document.querySelector(`[${attributeName}="${id}"]`);
      if (!(node instanceof HTMLElement)) {
        return false;
      }

      const rect = node.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));

      node.replaceChildren();
      node.style.padding = "0";
      node.style.border = "0";
      node.style.background = "transparent";
      node.style.boxShadow = "none";
      node.style.minHeight = `${height}px`;
      node.style.height = `${height}px`;
      node.style.maxHeight = "none";
      node.style.overflow = "visible";
      node.setAttribute("data-gamma-to-pdf-rasterized-section", "true");
      node.setAttribute("data-gamma-to-pdf-keep-together", "true");

      const image = document.createElement("img");
      image.src = dataUrl;
      image.alt = "";
      image.style.display = "block";
      image.style.width = `${width}px`;
      image.style.height = `${height}px`;
      image.style.maxWidth = maxWidth;
      image.style.margin = "0";
      image.style.objectFit = "contain";
      image.setAttribute("data-gamma-to-pdf-rasterized-section", "true");
      node.appendChild(image);
      return true;
    },
    { attributeName, id, dataUrl, maxWidth },
  );
}

async function applyHeroRasterOverrides(page, heroRasters) {
  const rasterizedHeroIds = [];

  for (const hero of heroRasters) {
    const locator = page.locator(`[data-gamma-to-pdf-hero-raster-id="${hero.id}"]`).first();
    try {
      await locator.scrollIntoViewIfNeeded().catch(() => {});
      const imageBuffer = await locator.screenshot({
        type: "png",
        animations: "disabled",
      });
      const replaced = await replaceNodeWithImage(
        page,
        "data-gamma-to-pdf-hero-raster-id",
        hero.id,
        imageBuffer,
      );
      if (replaced) {
        rasterizedHeroIds.push(hero.id);
      }
    } catch (error) {
      console.error(`Skipped hero rasterization for ${hero.id}: ${error?.message ?? error}`);
    }
  }

  return rasterizedHeroIds;
}

async function replaceLandscapeSpreadWithPlaceholder(page, spreadId, markerText) {
  return page.evaluate(
    ({ spreadId, markerText, printablePageHeightPx }) => {
      const node = document.querySelector(`[data-gamma-to-pdf-landscape-spread-id="${spreadId}"]`);
      if (!(node instanceof HTMLElement)) {
        return false;
      }

      node.replaceChildren();
      node.style.minHeight = `${printablePageHeightPx}px`;
      node.style.height = `${printablePageHeightPx}px`;
      node.style.maxHeight = `${printablePageHeightPx}px`;
      node.style.breakBefore = "page";
      node.style.breakAfter = "page";
      node.style.pageBreakBefore = "always";
      node.style.pageBreakAfter = "always";
      node.style.display = "flex";
      node.style.alignItems = "center";
      node.style.justifyContent = "center";
      node.style.padding = "0";
      node.style.margin = "0";
      node.style.background = "white";
      node.style.overflow = "hidden";
      node.setAttribute("data-gamma-to-pdf-rasterized-section", "true");
      node.setAttribute("data-gamma-to-pdf-force-break-before", "true");

      const marker = document.createElement("div");
      marker.textContent = markerText;
      marker.style.fontFamily = "monospace";
      marker.style.fontSize = "14px";
      marker.style.color = "#111";
      marker.style.padding = "24px";
      marker.style.wordBreak = "break-all";
      node.appendChild(marker);
      return true;
    },
    { spreadId, markerText, printablePageHeightPx: DEFAULT_PRINTABLE_PAGE_HEIGHT_PX },
  );
}

async function applyLandscapeSpreadOverrides(page, landscapeSpreads) {
  const appliedSpreads = [];

  for (const spread of landscapeSpreads) {
    const locator = page.locator(`[data-gamma-to-pdf-landscape-spread-id="${spread.id}"]`).first();
    try {
      await locator.scrollIntoViewIfNeeded().catch(() => {});
      const imageBuffer = await locator.screenshot({
        type: "png",
        animations: "disabled",
      });
      const replaced = await replaceLandscapeSpreadWithPlaceholder(page, spread.id, spread.markerText);
      if (replaced) {
        appliedSpreads.push({
          ...spread,
          imageBuffer,
        });
      }
    } catch (error) {
      console.error(`Skipped landscape spread promotion for ${spread.id}: ${error?.message ?? error}`);
    }
  }

  return appliedSpreads;
}

async function findDomSectionsToRasterize(page, pdfRenderMode) {
  return page.evaluate(({ pdfRenderMode }) => {
    const normalizeText = (value) => (value || "").replace(/\s+/g, " ").trim();
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }

      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0"
      );
    };

    const clearAttribute = (name) => {
      document.querySelectorAll(`[${name}]`).forEach((node) => node.removeAttribute(name));
    };

      const isLikelyDomRasterizationCandidate = (candidate) => {
        const balancedSides = candidate.leftHeadingCount >= 2 && candidate.rightHeadingCount >= 2;
        const distributedHeadings = candidate.topHeadingCount >= 2 && candidate.bottomHeadingCount >= 2;

        return (
        candidate.visualCount >= 1 &&
        balancedSides &&
        ((candidate.digitMarkerCount >= 4 && candidate.headingBlockCount >= 6) ||
          (candidate.headingBlockCount >= 8 && distributedHeadings))
      );
    };

    clearAttribute("data-gamma-to-pdf-dom-section-id");
    clearAttribute("data-gamma-to-pdf-dom-rasterize");

    const primaryRoot =
      document.querySelector("[data-gamma-to-pdf-primary-content='true']") ||
      document.querySelector("[data-gamma-to-pdf-scroll-root='true']") ||
      document.body;

    if (!(primaryRoot instanceof HTMLElement)) {
      return [];
    }

    const rootRect = primaryRoot.getBoundingClientRect();
    const rootWidth = rootRect.width || window.innerWidth;
    const candidates = [];

    for (const node of Array.from(primaryRoot.querySelectorAll("*"))) {
      if (!(node instanceof HTMLElement) || !isVisible(node)) {
        continue;
      }

      if (node.closest("[data-gamma-to-pdf-hide='true']")) {
        continue;
      }

      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const textLength = normalizeText(node.innerText || node.textContent || "").length;

      if (
        node === primaryRoot ||
        style.position === "fixed" ||
        style.position === "sticky" ||
        rect.width < Math.max(rootWidth * 0.55, 420) ||
        rect.height < 260 ||
        rect.height > 1500 ||
        textLength > 1600 ||
        (textLength < 80 && node.querySelectorAll("svg, canvas, figure, picture, img").length === 0)
      ) {
        continue;
      }

      const visualCount = node.querySelectorAll("svg, canvas, figure, picture, img").length;
      const headingBlocks = [];
      const digitMarkers = [];

      for (const descendant of Array.from(node.querySelectorAll("*"))) {
        if (!(descendant instanceof HTMLElement) || !isVisible(descendant)) {
          continue;
        }

        const descendantStyle = getComputedStyle(descendant);
        const descendantRect = descendant.getBoundingClientRect();
        const descendantText = normalizeText(descendant.innerText || descendant.textContent || "");

        if (descendantText && /^\d{1,2}$/.test(descendantText)) {
          const fontSize = Number.parseFloat(descendantStyle.fontSize) || 0;
          if (fontSize >= 16 && descendantRect.height <= 96) {
            digitMarkers.push(descendantRect);
          }
        }

        if (
          descendantText.length >= 3 &&
          descendantText.length <= 120 &&
          descendantRect.width <= rect.width * 0.8 &&
          descendantRect.height <= 240 &&
          descendant.childElementCount <= 1
        ) {
          const fontSize = Number.parseFloat(descendantStyle.fontSize) || 0;
          const fontWeight = Number.parseInt(descendantStyle.fontWeight, 10) || 400;
          if (fontSize >= 18 || fontWeight >= 600) {
            headingBlocks.push(descendantRect);
          }
        }
      }

      const toSectionCoordinates = (descendantRect) => ({
        centerX: descendantRect.left - rect.left + descendantRect.width / 2,
        centerY: descendantRect.top - rect.top + descendantRect.height / 2,
      });

      const headingPositions = headingBlocks.map(toSectionCoordinates);
      const digitPositions = digitMarkers.map(toSectionCoordinates);
      const leftHeadingCount = headingPositions.filter((item) => item.centerX <= rect.width * 0.4).length;
      const rightHeadingCount = headingPositions.filter((item) => item.centerX >= rect.width * 0.6).length;
      const topHeadingCount = headingPositions.filter((item) => item.centerY <= rect.height * 0.35).length;
      const bottomHeadingCount = headingPositions.filter((item) => item.centerY >= rect.height * 0.65).length;

      const metrics = {
        visualCount,
        digitMarkerCount: digitPositions.length,
        headingBlockCount: headingBlocks.length,
        leftHeadingCount,
        rightHeadingCount,
        topHeadingCount,
        bottomHeadingCount,
      };

      if (pdfRenderMode !== "raster-all" && !isLikelyDomRasterizationCandidate(metrics)) {
        continue;
      }

      candidates.push({
        node,
        area: rect.width * rect.height,
        digitMarkerCount: metrics.digitMarkerCount,
        headingBlockCount: metrics.headingBlockCount,
      });
    }

    candidates.sort(
      (left, right) =>
        right.digitMarkerCount - left.digitMarkerCount ||
        left.area - right.area ||
        left.headingBlockCount - right.headingBlockCount,
    );

    const acceptedNodes = [];
    const acceptedIds = [];
    for (const candidate of candidates) {
      if (acceptedNodes.some((accepted) => accepted.contains(candidate.node))) {
        continue;
      }

      acceptedNodes.push(candidate.node);
      const sectionId = `section-${String(acceptedNodes.length).padStart(3, "0")}`;
      candidate.node.setAttribute("data-gamma-to-pdf-dom-section-id", sectionId);
      candidate.node.setAttribute("data-gamma-to-pdf-dom-rasterize", "true");
      candidate.node.setAttribute("data-gamma-to-pdf-keep-together", "true");
      acceptedIds.push(sectionId);
    }

    return acceptedIds;
  }, { pdfRenderMode });
}

async function replaceDomSectionWithImage(page, sectionId, imageBuffer) {
  const dataUrl = `data:image/png;base64,${imageBuffer.toString("base64")}`;
  return page.evaluate(
    ({ sectionId, dataUrl }) => {
      const node = document.querySelector(`[data-gamma-to-pdf-dom-section-id="${sectionId}"]`);
      if (!(node instanceof HTMLElement)) {
        return false;
      }

      const rect = node.getBoundingClientRect();
      const width = Math.ceil(rect.width);
      const height = Math.ceil(rect.height);

      node.replaceChildren();
      node.style.padding = "0";
      node.style.border = "0";
      node.style.background = "transparent";
      node.style.boxShadow = "none";
      node.style.minHeight = `${height}px`;
      node.style.height = `${height}px`;
      node.style.maxHeight = "none";
      node.style.overflow = "visible";
      node.setAttribute("data-gamma-to-pdf-rasterized-section", "true");
      node.setAttribute("data-gamma-to-pdf-keep-together", "true");

      const image = document.createElement("img");
      image.src = dataUrl;
      image.alt = "";
      image.style.display = "block";
      image.style.width = `${width}px`;
      image.style.height = `${height}px`;
      image.style.maxWidth = "100%";
      image.style.margin = "0";
      image.style.objectFit = "contain";
      image.setAttribute("data-gamma-to-pdf-rasterized-section", "true");
      node.appendChild(image);
      return true;
    },
    { sectionId, dataUrl },
  );
}

async function rasterizeDomSections(page, pdfRenderMode) {
  const sectionIds = await findDomSectionsToRasterize(page, pdfRenderMode);
  const rasterizedIds = [];

  for (const sectionId of sectionIds) {
    const locator = page.locator(`[data-gamma-to-pdf-dom-section-id="${sectionId}"]`).first();
    try {
      await locator.scrollIntoViewIfNeeded().catch(() => {});
      const imageBuffer = await locator.screenshot({
        type: "png",
        animations: "disabled",
      });
      const replaced = await replaceDomSectionWithImage(page, sectionId, imageBuffer);
      if (replaced) {
        rasterizedIds.push(sectionId);
      }
    } catch (error) {
      console.error(`Skipped live DOM rasterization for ${sectionId}: ${error?.message ?? error}`);
    }
  }

  return rasterizedIds;
}

async function preparePageForBasePrint(page, deadline) {
  await detectScrollableLayout(page);
  await applyPrintLayoutHints(page, await page.title().catch(() => ""));
  await page.emulateMedia({ media: "screen" });
  await injectPrintStyles(page);
  await page.waitForTimeout(300);
  await detectScrollableLayout(page);
  await applyPrintLayoutHints(page, await page.title().catch(() => ""));
  await setActiveScrollTop(page, 0);
  await waitForFonts(page);
  await waitForImages(page, deadline);
  await waitForStableHeight(page, deadline);
}

async function preparePageForPdf(page, deadline, pdfRenderMode = DEFAULT_PDF_RENDER_MODE) {
  await preparePageForBasePrint(page, deadline);
  const renderPlan = await planRenderOverrides(page);
  const rasterizedHeroIds = await applyHeroRasterOverrides(page, renderPlan.heroRasters);
  const landscapeSpreads = await applyLandscapeSpreadOverrides(page, renderPlan.landscapeSpreads);

  if (pdfRenderMode !== "text") {
    await rasterizeDomSections(page, pdfRenderMode);
  }

  await setActiveScrollTop(page, 0);
  await waitForImages(page, deadline);
  await waitForStableHeight(page, deadline);

  return {
    rasterizedHeroIds,
    landscapeSpreads,
  };
}

function clipBlockIntoPages(rect, printablePageHeightPx = DEFAULT_PRINTABLE_PAGE_HEIGHT_PX) {
  const absoluteTop = rect.top;
  const absoluteBottom = rect.top + rect.height;
  const startPage = Math.max(0, Math.floor(absoluteTop / printablePageHeightPx));
  const endPage = Math.max(0, Math.floor(Math.max(absoluteBottom - 1, absoluteTop) / printablePageHeightPx));
  const bboxes = [];

  for (let pageIndex = startPage; pageIndex <= endPage; pageIndex += 1) {
    const pageTop = pageIndex * printablePageHeightPx;
    const top = Math.max(absoluteTop, pageTop);
    const bottom = Math.min(absoluteBottom, pageTop + printablePageHeightPx);
    const height = bottom - top;

    if (height <= 1) {
      continue;
    }

    bboxes.push({
      pageNumber: pageIndex + 1,
      x: rect.left,
      y: top - pageTop,
      width: rect.width,
      height,
    });
  }

  return bboxes;
}

function createSinglePageBbox(rect, printablePageHeightPx = DEFAULT_PRINTABLE_PAGE_HEIGHT_PX) {
  const pageIndex = Math.max(0, Math.floor(rect.top / printablePageHeightPx));
  return [
    {
      pageNumber: pageIndex + 1,
      x: rect.left,
      y: rect.top - pageIndex * printablePageHeightPx,
      width: rect.width,
      height: rect.height,
    },
  ];
}

export function paginateDocumentBlocks(
  rawBlocks,
  printablePageHeightPx = DEFAULT_PRINTABLE_PAGE_HEIGHT_PX,
) {
  const blocks = [];
  let addedPrintHeight = 0;

  for (const [index, block] of rawBlocks.entries()) {
    const rect = {
      left: block.rect.left,
      top: block.rect.top + addedPrintHeight,
      width: block.rect.width,
      height: block.rect.height,
    };
    const blockHeight = Math.max(1, rect.height);

    if (block.forceBreakBefore) {
      const offsetWithinPage = rect.top % printablePageHeightPx;
      if (offsetWithinPage > 1) {
        const insertedGap = printablePageHeightPx - offsetWithinPage;
        addedPrintHeight += insertedGap;
        rect.top += insertedGap;
      }
    }

    const fitsSinglePage = blockHeight <= printablePageHeightPx - 1;
    if (block.keepTogether && !block.allowSplit && fitsSinglePage) {
      const offsetWithinPage = rect.top % printablePageHeightPx;
      if (offsetWithinPage > 1 && offsetWithinPage + blockHeight > printablePageHeightPx) {
        const insertedGap = printablePageHeightPx - offsetWithinPage;
        addedPrintHeight += insertedGap;
        rect.top += insertedGap;
      }
    }

    const bboxes =
      block.keepTogether && !block.allowSplit && fitsSinglePage
        ? createSinglePageBbox(rect, printablePageHeightPx)
        : clipBlockIntoPages(rect, printablePageHeightPx);

    blocks.push({
      id: `block-${String(index + 1).padStart(4, "0")}`,
      type: block.type,
      text: block.text,
      level: block.level,
      sourceKind: block.sourceKind,
      order: index + 1,
      pageNumbers: [...new Set(bboxes.map((bbox) => bbox.pageNumber))],
      bboxes,
      sectionId: null,
      parentId: null,
      keepTogether: Boolean(block.keepTogether),
      allowSplit: Boolean(block.allowSplit),
      forceBreakBefore: Boolean(block.forceBreakBefore),
      heroRasterId: block.heroRasterId || null,
      landscapeSpreadId: block.landscapeSpreadId || null,
      rect,
    });
  }

  return blocks;
}

function buildSectionsFromBlocks(blocks) {
  const sections = [];
  let currentSection = {
    id: "section-000",
    title: "Document",
    level: 1,
    pageNumbers: [],
    blockIds: [],
  };
  sections.push(currentSection);

  for (const block of blocks) {
    if (block.type === "heading") {
      currentSection = {
        id: `section-${String(sections.length).padStart(3, "0")}`,
        title: block.text || `Section ${sections.length}`,
        level: Math.max(1, Math.min(6, block.level || 2)),
        pageNumbers: [...block.pageNumbers],
        blockIds: [block.id],
      };
      sections.push(currentSection);
      block.sectionId = currentSection.id;
      continue;
    }

    block.sectionId = currentSection.id;
    currentSection.blockIds.push(block.id);
    currentSection.pageNumbers.push(...block.pageNumbers);
  }

  for (const section of sections) {
    section.pageNumbers = [...new Set(section.pageNumbers)].sort((left, right) => left - right);
  }

  return sections.filter((section) => section.blockIds.length > 0 || section.id === "section-000");
}

function rebuildSectionsForDocumentModel(documentModel) {
  documentModel.sections = buildSectionsFromBlocks(documentModel.blocks);
  return documentModel;
}

export function remapDocumentModelToFinalPages(
  documentModel,
  {
    finalPageCount,
    landscapePageNumberById = new Map(),
    pageMetadata = [],
  } = {},
) {
  const resolvedFinalPageCount = Math.max(1, finalPageCount || documentModel.pageCount || 1);
  const originalPageCount = Math.max(1, documentModel.pageCount || 1);

  for (const block of documentModel.blocks) {
    const mappedLandscapePageNumber = block.landscapeSpreadId
      ? landscapePageNumberById.get(block.landscapeSpreadId)
      : null;

    if (mappedLandscapePageNumber) {
      block.pageNumbers = [mappedLandscapePageNumber];
      block.bboxes = (block.bboxes || []).map((bbox) => ({
        ...bbox,
        pageNumber: mappedLandscapePageNumber,
      }));
      continue;
    }

    block.pageNumbers = [...new Set(
      (block.pageNumbers || []).map((pageNumber) =>
        mapPageNumberProportionally(pageNumber, originalPageCount, resolvedFinalPageCount),
      ),
    )].sort((left, right) => left - right);
    block.bboxes = (block.bboxes || []).map((bbox) => ({
      ...bbox,
      pageNumber: mapPageNumberProportionally(
        bbox.pageNumber,
        originalPageCount,
        resolvedFinalPageCount,
      ),
    }));
  }

  documentModel.pageCount = resolvedFinalPageCount;
  documentModel.pages = (pageMetadata || []).map((page) => ({
    pageNumber: page.pageNumber,
    widthPx: page.widthPx,
    heightPx: page.heightPx,
    orientation: page.orientation || detectPageOrientation(page.widthPx, page.heightPx),
  }));
  return rebuildSectionsForDocumentModel(documentModel);
}

export function buildChatReadyMarkdown(documentModel) {
  const lines = [];

  for (const block of documentModel.blocks) {
    if (!block.text && block.type !== "figure") {
      continue;
    }

    if (block.type === "heading") {
      const level = Math.max(1, Math.min(6, block.level || 2));
      lines.push(`${"#".repeat(level)} ${block.text}`);
      lines.push("");
      continue;
    }

    if (block.type === "list_item") {
      lines.push(`- ${block.text}`);
      continue;
    }

    if (block.type === "quote") {
      lines.push(`> ${block.text}`);
      lines.push("");
      continue;
    }

    if (block.type === "callout") {
      lines.push(`> [!NOTE] ${block.text}`);
      lines.push("");
      continue;
    }

    if (block.type === "figure") {
      const pageLabel = block.pageNumbers?.[0] ? `page ${block.pageNumbers[0]}` : "figure";
      lines.push(`![Figure on ${pageLabel}]()`);
      lines.push("");
      continue;
    }

    lines.push(block.text);
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

export function summarizeTextOverlap(referenceText, candidateText) {
  const tokenize = (value) =>
    (value || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 3);

  const referenceTokens = [...new Set(tokenize(referenceText))];
  const candidateTokenSet = new Set(tokenize(candidateText));
  const matchedTokenCount = referenceTokens.filter((token) => candidateTokenSet.has(token)).length;

  return {
    referenceTokenCount: referenceTokens.length,
    candidateTokenCount: candidateTokenSet.size,
    matchedTokenCount,
    recall: referenceTokens.length === 0 ? 1 : matchedTokenCount / referenceTokens.length,
  };
}

async function extractChatReadyDocumentModel(page, { sourceUrl, title }) {
  const extracted = await page.evaluate(
    ({ printablePageHeightPx }) => {
      const normalizeText = (value) => (value || "").replace(/\s+/g, " ").trim();
      const isVisible = (node) => {
        if (!(node instanceof HTMLElement)) {
          return false;
        }

        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0"
        );
      };

      const primaryRoot =
        document.querySelector("[data-gamma-to-pdf-primary-content='true']") ||
        document.querySelector("[data-gamma-to-pdf-scroll-root='true']") ||
        document.body;

      if (!(primaryRoot instanceof HTMLElement)) {
        return { blocks: [] };
      }

      const acceptedNodes = [];
      const blocks = [];

      const hasAcceptedAncestor = (node) => acceptedNodes.some((accepted) => accepted.contains(node));
      const hasPrintHint = (node, attributeName) =>
        node.hasAttribute(attributeName) || Boolean(node.closest(`[${attributeName}]`));
      const getHeroRasterId = (node) =>
        node.closest("[data-gamma-to-pdf-hero-raster-id]")?.getAttribute(
          "data-gamma-to-pdf-hero-raster-id",
        ) || null;
      const getLandscapeSpreadId = (node) =>
        node.closest("[data-gamma-to-pdf-landscape-spread-id]")?.getAttribute(
          "data-gamma-to-pdf-landscape-spread-id",
        ) || null;

      const classifyBlock = (node) => {
        const tagName = node.tagName.toLowerCase();
        const style = getComputedStyle(node);
        const text = normalizeText(node.innerText || node.textContent || "");
        const visualCount = node.querySelectorAll("svg, canvas, figure, picture, img").length;
        const semanticDescendantCount = node.querySelectorAll(
          "h1, h2, h3, h4, h5, h6, [role='heading'], p, li, blockquote, figure",
        ).length;
        const childElementCount = node.childElementCount;
        const isDecorated =
          (style.backgroundColor !== "rgba(0, 0, 0, 0)" &&
            style.backgroundColor !== "transparent") ||
          style.boxShadow !== "none" ||
          Number.parseFloat(style.borderTopWidth) > 0 ||
          Number.parseFloat(style.borderLeftWidth) > 0 ||
          Number.parseFloat(style.borderTopLeftRadius) > 0;
        const fontSize = Number.parseFloat(style.fontSize) || 0;
        const fontWeight = Number.parseInt(style.fontWeight, 10) || 400;
        const looksLeafLike = childElementCount <= 2 && semanticDescendantCount <= 1;

        if (
          semanticDescendantCount >= 3 &&
          !/^h[1-6]$/.test(tagName) &&
          tagName !== "p" &&
          tagName !== "li" &&
          tagName !== "blockquote"
        ) {
          return null;
        }

        if (
          /^h[1-6]$/.test(tagName) ||
          node.getAttribute("role") === "heading" ||
          node.hasAttribute("data-gamma-to-pdf-heading") ||
          (fontSize >= 24 && fontWeight >= 600 && text.length <= 200 && looksLeafLike)
        ) {
          const level = /^h[1-6]$/.test(tagName) ? Number.parseInt(tagName.slice(1), 10) : fontSize >= 36 ? 1 : 2;
          return { type: "heading", level, text, sourceKind: "semantic-tag" };
        }

        if (tagName === "blockquote") {
          return { type: "quote", level: null, text, sourceKind: "semantic-tag" };
        }

        if (tagName === "li") {
          return { type: "list_item", level: null, text, sourceKind: "semantic-tag" };
        }

        if (tagName === "p") {
          return { type: "paragraph", level: null, text, sourceKind: "semantic-tag" };
        }

        if ((tagName === "figure" || visualCount > 0) && text.length <= 30 && childElementCount <= 6) {
          return { type: "figure", level: null, text, sourceKind: "visual" };
        }

        if (
          isDecorated &&
          text.length >= 40 &&
          text.length <= 1400 &&
          semanticDescendantCount <= 6 &&
          childElementCount <= 8
        ) {
          return { type: "callout", level: null, text, sourceKind: "styled-container" };
        }

        if (
          text.length >= 20 &&
          text.length <= 800 &&
          fontSize >= 14 &&
          fontWeight >= 400 &&
          looksLeafLike
        ) {
          return { type: "paragraph", level: null, text, sourceKind: "styled-text" };
        }

        return null;
      };

      for (const node of Array.from(primaryRoot.querySelectorAll("*"))) {
        if (!(node instanceof HTMLElement) || !isVisible(node)) {
          continue;
        }

        if (node.closest("[data-gamma-to-pdf-hide='true']") || hasAcceptedAncestor(node)) {
          continue;
        }

        const classification = classifyBlock(node);
        if (!classification) {
          continue;
        }

        const rect = node.getBoundingClientRect();
        const absoluteRect = {
          left: rect.left,
          top: rect.top + window.scrollY,
          width: rect.width,
          height: rect.height,
        };

        blocks.push({
          type: classification.type,
          text: classification.text,
          level: classification.level,
          sourceKind: classification.sourceKind,
          rect: absoluteRect,
          keepTogether: hasPrintHint(node, "data-gamma-to-pdf-keep-together"),
          allowSplit: hasPrintHint(node, "data-gamma-to-pdf-allow-split"),
          forceBreakBefore: hasPrintHint(node, "data-gamma-to-pdf-force-break-before"),
          heroRasterId: getHeroRasterId(node),
          landscapeSpreadId: getLandscapeSpreadId(node),
        });
        acceptedNodes.push(node);
      }

      return { blocks };
    },
    { printablePageHeightPx: DEFAULT_PRINTABLE_PAGE_HEIGHT_PX },
  );

  const blocks = paginateDocumentBlocks(extracted.blocks, DEFAULT_PRINTABLE_PAGE_HEIGHT_PX);

  const sections = buildSectionsFromBlocks(blocks);
  const pageCount = Math.max(
    1,
    ...blocks.flatMap((block) => block.pageNumbers),
  );

  return {
    sourceUrl,
    title: stripGammaTitleSuffix(title),
    generatedAt: new Date().toISOString(),
    pageSize: {
      widthPx: DEFAULT_PRINTABLE_PAGE_WIDTH_PX,
      heightPx: DEFAULT_PRINTABLE_PAGE_HEIGHT_PX,
    },
    pageCount,
    sections,
    blocks,
  };
}

async function preparePageForChatReady(page, deadline, { sourceUrl, title }) {
  await preparePageForBasePrint(page, deadline);
  const renderPlan = await planRenderOverrides(page);
  const documentModel = await extractChatReadyDocumentModel(page, { sourceUrl, title });

  return {
    documentModel,
    renderPlan,
  };
}

function createTemporaryBundleDirectoryPath(finalBundleDir) {
  return `${finalBundleDir}.tmp-${process.pid}-${Date.now()}`;
}

function createTemporaryPdfPath(finalPdfPath) {
  return `${finalPdfPath}.tmp-${process.pid}-${Date.now()}.pdf`;
}

async function createCanvasPngBuffer(canvas) {
  if (typeof canvas.toBuffer === "function") {
    return canvas.toBuffer("image/png");
  }

  if (typeof canvas.encode === "function") {
    return Buffer.from(await canvas.encode("png"));
  }

  throw new CliError("Unable to encode PNG pages for the LLM bundle.", 1);
}

function summarizePdfPageRasterMetrics(items, pageWidth) {
  const significantItems = items
    .map((item) => ({
      str: String(item.str || "").replace(/\s+/g, " ").trim(),
      width: Number(item.width || 0),
      height: Number(item.height || 0),
      x: Number(item.transform?.[4] || 0),
      y: Number(item.transform?.[5] || 0),
    }))
    .filter((item) => item.str && /[A-Za-z0-9]/.test(item.str));

  const shortLargeItems = significantItems.filter(
    (item) =>
      item.height >= LARGE_TEXT_ITEM_HEIGHT_THRESHOLD &&
      item.str.length <= SHORT_LARGE_TEXT_LENGTH_THRESHOLD,
  );

  const xPositions = shortLargeItems.map((item) => item.x);
  const yPositions = shortLargeItems.map((item) => item.y);
  const averageShortLargeWidth =
    shortLargeItems.reduce((sum, item) => sum + item.width, 0) /
    Math.max(shortLargeItems.length, 1);

  return {
    shortLargeItemCount: shortLargeItems.length,
    digitLargeItemCount: shortLargeItems.filter((item) => /^\d{1,2}$/.test(item.str)).length,
    averageShortLargeWidth,
    verticalSpread: yPositions.length > 1 ? Math.max(...yPositions) - Math.min(...yPositions) : 0,
    horizontalSpread: xPositions.length > 1 ? Math.max(...xPositions) - Math.min(...xPositions) : 0,
    leftAlignedLargeItemCount: shortLargeItems.filter((item) => item.x < pageWidth * 0.35).length,
    rightAlignedLargeItemCount: shortLargeItems.filter((item) => item.x > pageWidth * 0.55).length,
  };
}

async function analyzePdfPageForRasterization(pdfPage) {
  const viewport = pdfPage.getViewport({ scale: 1 });
  const textContent = await pdfPage.getTextContent();
  return summarizePdfPageRasterMetrics(textContent.items, viewport.width);
}

async function renderPdfPageToPng(pdfPage, scale = DEFAULT_LLM_IMAGE_SCALE) {
  const viewport = pdfPage.getViewport({ scale });
  const widthPx = Math.ceil(viewport.width);
  const heightPx = Math.ceil(viewport.height);
  const canvas = createCanvas(widthPx, heightPx);
  const canvasContext = canvas.getContext("2d");

  await pdfPage.render({
    canvasContext,
    viewport,
  }).promise;

  return {
    buffer: await createCanvasPngBuffer(canvas),
    widthPx,
    heightPx,
  };
}

async function renderPdfPagesToImages(pdfPath, pagesDirectory) {
  const pdfBytes = await fsp.readFile(pdfPath);
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBytes),
    disableWorker: true,
    useSystemFonts: true,
  });

  try {
    const pdfDocument = await loadingTask.promise;
    const pages = [];

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const pdfPage = await pdfDocument.getPage(pageNumber);
      const { buffer, widthPx, heightPx } = await renderPdfPageToPng(pdfPage);
      const fileName = `page-${String(pageNumber).padStart(3, "0")}.png`;
      const imagePath = path.join(pagesDirectory, fileName);
      await fsp.writeFile(imagePath, buffer);
      pages.push({
        pageNumber,
        imageFile: path.join("pages", fileName),
        widthPx,
        heightPx,
        orientation: detectPageOrientation(widthPx, heightPx),
      });
      pdfPage.cleanup();
    }

    await pdfDocument.cleanup();
    await pdfDocument.destroy();
    return pages;
  } finally {
    await loadingTask.destroy();
  }
}

function copyPdfTitle(sourceDocument, targetDocument) {
  const title = sourceDocument.getTitle?.();
  if (title) {
    targetDocument.setTitle(title, { showInWindowTitleBar: true });
  }
}

async function rewritePdfWithRenderMode(sourcePdfPath, outputPath, pdfRenderMode) {
  const pdfBytes = await fsp.readFile(sourcePdfPath);
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBytes),
    disableWorker: true,
    useSystemFonts: true,
  });
  let pdfDocument;

  try {
    pdfDocument = await loadingTask.promise;
    const rasterizedPageNumbers = [];

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      if (pdfRenderMode === "raster-all") {
        rasterizedPageNumbers.push(pageNumber);
        continue;
      }

      const pdfPage = await pdfDocument.getPage(pageNumber);
      const metrics = await analyzePdfPageForRasterization(pdfPage);
      pdfPage.cleanup();

      if (isLikelyRasterizationCandidate(metrics)) {
        rasterizedPageNumbers.push(pageNumber);
      }
    }

    await fsp.rm(outputPath, { force: true });

    if (rasterizedPageNumbers.length === 0) {
      await fsp.rename(sourcePdfPath, outputPath);
      return {
        pageCount: pdfDocument.numPages,
        rasterizedPageNumbers,
      };
    }

    const sourceDocument = await PDFDocument.load(pdfBytes);
    const rewrittenDocument = await PDFDocument.create();
    const rasterizedPageSet = new Set(rasterizedPageNumbers);

    copyPdfTitle(sourceDocument, rewrittenDocument);

    for (let pageNumber = 1; pageNumber <= sourceDocument.getPageCount(); pageNumber += 1) {
      if (!rasterizedPageSet.has(pageNumber)) {
        const [copiedPage] = await rewrittenDocument.copyPages(sourceDocument, [pageNumber - 1]);
        rewrittenDocument.addPage(copiedPage);
        continue;
      }

      const sourcePage = sourceDocument.getPage(pageNumber - 1);
      const pdfPage = await pdfDocument.getPage(pageNumber);
      const { buffer } = await renderPdfPageToPng(pdfPage);
      const embeddedImage = await rewrittenDocument.embedPng(buffer);
      const { width, height } = sourcePage.getSize();
      const rewrittenPage = rewrittenDocument.addPage([width, height]);

      rewrittenPage.drawImage(embeddedImage, {
        x: 0,
        y: 0,
        width,
        height,
      });

      pdfPage.cleanup();
    }

    await fsp.writeFile(outputPath, await rewrittenDocument.save());

    return {
      pageCount: sourceDocument.getPageCount(),
      rasterizedPageNumbers,
    };
  } finally {
    if (pdfDocument) {
      try {
        await pdfDocument.cleanup();
      } catch {}
      try {
        await pdfDocument.destroy();
      } catch {}
    }
    await loadingTask.destroy().catch(() => {});
  }
}

async function rewritePdfWithLandscapeSpreads(sourcePdfPath, outputPath, landscapeSpreads) {
  if (!landscapeSpreads || landscapeSpreads.length === 0) {
    if (path.resolve(sourcePdfPath) !== path.resolve(outputPath)) {
      await fsp.rm(outputPath, { force: true }).catch(() => {});
      await fsp.rename(sourcePdfPath, outputPath);
    }
    return {
      pageCount: null,
      landscapePageNumbers: [],
      landscapePageNumberById: new Map(),
      warnings: [],
    };
  }

  const pages = await extractPdfTextPagesPreferPoppler(sourcePdfPath);
  const markerPageNumberById = new Map();
  const warnings = [];

  for (const spread of landscapeSpreads) {
    const markerPage = pages.find((page) => page.text.includes(spread.markerText));
    if (!markerPage) {
      warnings.push(`landscape_spread_marker_missing:${spread.id}`);
      continue;
    }
    markerPageNumberById.set(spread.id, markerPage.pageNumber);
  }

  const sourceBytes = await fsp.readFile(sourcePdfPath);
  const sourceDocument = await PDFDocument.load(sourceBytes);
  const rewrittenDocument = await PDFDocument.create();
  copyPdfTitle(sourceDocument, rewrittenDocument);
  const landscapePageNumbers = [];
  const landscapePageNumberById = new Map();

  for (let pageNumber = 1; pageNumber <= sourceDocument.getPageCount(); pageNumber += 1) {
    const spread = landscapeSpreads.find(
      (candidate) => markerPageNumberById.get(candidate.id) === pageNumber,
    );

    if (!spread) {
      const [copiedPage] = await rewrittenDocument.copyPages(sourceDocument, [pageNumber - 1]);
      rewrittenDocument.addPage(copiedPage);
      continue;
    }

    const embeddedImage = await rewrittenDocument.embedPng(spread.imageBuffer);
    const landscapePage = rewrittenDocument.addPage([
      LANDSCAPE_PAGE_WIDTH_PT,
      LANDSCAPE_PAGE_HEIGHT_PT,
    ]);
    landscapePage.drawImage(embeddedImage, {
      x: 0,
      y: 0,
      width: LANDSCAPE_PAGE_WIDTH_PT,
      height: LANDSCAPE_PAGE_HEIGHT_PT,
    });

    const finalPageNumber = rewrittenDocument.getPageCount();
    landscapePageNumbers.push(finalPageNumber);
    landscapePageNumberById.set(spread.id, finalPageNumber);
  }

  await fsp.writeFile(outputPath, await rewrittenDocument.save());
  return {
    pageCount: rewrittenDocument.getPageCount(),
    landscapePageNumbers,
    landscapePageNumberById,
    warnings,
  };
}

async function createLlmBundle({ pdfPath, sourceUrl, title }) {
  const finalBundleDir = buildBundleDirectoryPath(pdfPath);
  const temporaryBundleDir = createTemporaryBundleDirectoryPath(finalBundleDir);
  const pagesDirectory = path.join(temporaryBundleDir, "pages");

  await fsp.rm(temporaryBundleDir, { recursive: true, force: true });
  await fsp.mkdir(pagesDirectory, { recursive: true });

  try {
    const pages = await renderPdfPagesToImages(pdfPath, pagesDirectory);
    const manifest = buildBundleManifest({
      bundleDir: temporaryBundleDir,
      pdfPath,
      sourceUrl,
      title,
      pageCount: pages.length,
      pages,
    });

    await fsp.writeFile(
      path.join(temporaryBundleDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    await fsp.rm(finalBundleDir, { recursive: true, force: true });
    await fsp.rename(temporaryBundleDir, finalBundleDir);
    return finalBundleDir;
  } catch (error) {
    await fsp.rm(temporaryBundleDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export function buildChatReadyManifest({
  bundleDir,
  pdfPath,
  sourceUrl,
  title,
  generatedAt = new Date().toISOString(),
  pageCount,
  pages,
  warnings = [],
  qaSummary = null,
}) {
  return {
    mode: "chat-ready",
    sourceUrl,
    title: stripGammaTitleSuffix(title),
    generatedAt,
    pdfFile: toPosixPath(path.relative(bundleDir, pdfPath)),
    markdownFile: "document.md",
    jsonFile: "document.json",
    pageCount,
    paperSize: "letter",
    imageScale: DEFAULT_LLM_IMAGE_SCALE,
    warnings,
    qa: qaSummary,
    pages: pages.map((page) => ({
      pageNumber: page.pageNumber,
      imageFile: toPosixPath(page.imageFile),
      widthPx: page.widthPx,
      heightPx: page.heightPx,
      orientation: page.orientation || detectPageOrientation(page.widthPx, page.heightPx),
    })),
  };
}

function toChatReadyDocumentJson(documentModel) {
  return {
    sourceUrl: documentModel.sourceUrl,
    title: documentModel.title,
    generatedAt: documentModel.generatedAt,
    pageSize: documentModel.pageSize,
    pageCount: documentModel.pageCount,
    pages: documentModel.pages || [],
    sections: documentModel.sections,
    blocks: documentModel.blocks,
  };
}

function normalizePageNumberSet(pageNumbers) {
  if (!Array.isArray(pageNumbers)) {
    return null;
  }

  return new Set(
    pageNumbers
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isFinite(value) && value > 0),
  );
}

async function addHiddenSemanticTextLayer(pdfPath, documentModel, { pageNumbers = null } = {}) {
  try {
    const pdfBytes = await fsp.readFile(pdfPath);
    const document = await PDFDocument.load(pdfBytes);
    const font = await document.embedFont(StandardFonts.Helvetica);
    const pages = document.getPages();
    const allowedPageNumbers = normalizePageNumberSet(pageNumbers);
    let injectedPageCount = 0;

    for (const [pageIndex, page] of pages.entries()) {
      const pageNumber = pageIndex + 1;
      if (allowedPageNumbers && !allowedPageNumbers.has(pageNumber)) {
        continue;
      }

      const pageBlocks = documentModel.blocks.filter(
        (block) => block.pageNumbers?.includes(pageNumber) && block.text,
      );
      const pageText = sanitizePdfTextContent(
        pageBlocks
          .sort((left, right) => left.order - right.order)
          .map((block) => block.text)
          .filter(Boolean)
          .join("\n\n"),
      );

      if (pageText) {
        const fontSize = 3;
        page.drawText(pageText, {
          x: 6,
          y: page.getHeight() - 6,
          maxWidth: Math.max(48, page.getWidth() - 12),
          size: fontSize,
          lineHeight: fontSize * 1.2,
          font,
          opacity: 0.001,
        });
      }

      if (pageText) {
        injectedPageCount += 1;
      }
    }

    await fsp.writeFile(pdfPath, await document.save());
    return { ok: true, warnings: [], injectedPageCount };
  } catch (error) {
    return {
      ok: false,
      warnings: [`hidden_text_missing:${error?.message ?? error}`],
      injectedPageCount: 0,
    };
  }
}

async function addHiddenPageTextLayer(pdfPath, pageTextEntries) {
  try {
    const pdfBytes = await fsp.readFile(pdfPath);
    const document = await PDFDocument.load(pdfBytes);
    const font = await document.embedFont(StandardFonts.Helvetica);
    const pages = document.getPages();
    let injectedPageCount = 0;

    for (const entry of pageTextEntries) {
      const pageIndex = Math.max(0, (entry.pageNumber || 1) - 1);
      const page = pages[pageIndex];
      if (!page) {
        continue;
      }

      const pageText = sanitizePdfTextContent(entry.text);
      if (!pageText) {
        continue;
      }

      const fontSize = 3;
      page.drawText(pageText, {
        x: 6,
        y: page.getHeight() - 6,
        maxWidth: Math.max(48, page.getWidth() - 12),
        size: fontSize,
        lineHeight: fontSize * 1.2,
        font,
        opacity: 0.001,
      });
      injectedPageCount += 1;
    }

    if (injectedPageCount > 0) {
      await fsp.writeFile(pdfPath, await document.save());
    }

    return {
      ok: true,
      warnings: [],
      injectedPageCount,
    };
  } catch (error) {
    return {
      ok: false,
      warnings: [`hidden_page_text_missing:${error?.message ?? error}`],
      injectedPageCount: 0,
    };
  }
}

async function extractPdfTextPages(pdfPath) {
  const pdfBytes = await fsp.readFile(pdfPath);
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBytes),
    disableWorker: true,
    useSystemFonts: true,
  });

  try {
    const document = await loadingTask.promise;
    const pages = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const text = textContent.items.map((item) => String(item.str || "")).join(" ");
      pages.push({
        pageNumber,
        text: text.replace(/\s+/g, " ").trim(),
      });
      page.cleanup();
    }

    await document.cleanup();
    await document.destroy();
    return pages;
  } finally {
    await loadingTask.destroy().catch(() => {});
  }
}

async function execPoppler(command, args, options = {}) {
  return execFile(command, args, {
    encoding: "utf8",
    maxBuffer: POPPLER_EXEC_MAX_BUFFER,
    windowsHide: true,
    ...options,
  });
}

function isMissingExecutableError(error) {
  if (error?.code !== "ENOENT") {
    return false;
  }

  return (
    POPPLER_COMMANDS.has(error?.path) ||
    POPPLER_COMMANDS.has(error?.spawnfile) ||
    POPPLER_COMMANDS.has(error?.syscall?.replace(/^spawn\s+/, ""))
  );
}

export function parsePdfInfoPageCount(text) {
  const match = String(text || "").match(/^Pages:\s+(\d+)/m);
  return match ? Number.parseInt(match[1], 10) : null;
}

async function resolvePdfPageCount(pdfPath) {
  try {
    const { stdout } = await execPoppler("pdfinfo", [pdfPath]);
    const pageCount = parsePdfInfoPageCount(stdout);
    if (pageCount) {
      return pageCount;
    }
  } catch (error) {
    if (!isMissingExecutableError(error)) {
      throw error;
    }
  }

  const pages = await extractPdfTextPages(pdfPath);
  return pages.length;
}

export function summarizePdffontsOutput(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .slice(2)
    .map((line) => line.trimEnd())
    .filter(Boolean);

  const fontLines = lines.filter((line) => !/^[-]+$/.test(line));
  return {
    totalFontCount: fontLines.length,
    type3FontCount: fontLines.filter((line) => /\bType 3\b/i.test(line)).length,
  };
}

async function extractPdfTextPagesWithPoppler(pdfPath) {
  const { stdout } = await execPoppler("pdftotext", [
    "-layout",
    "-enc",
    "UTF-8",
    "-eol",
    "unix",
    pdfPath,
    "-",
  ]);

  const rawPages = stdout
    .split("\f")
    .map((pageText) => pageText.replace(/\s+/g, " ").trim());

  if (rawPages.length > 0 && rawPages[rawPages.length - 1] === "") {
    rawPages.pop();
  }

  return rawPages.map((text, index) => ({
    pageNumber: index + 1,
    text,
  }));
}

async function extractPdfTextPagesPreferPoppler(pdfPath) {
  try {
    return await extractPdfTextPagesWithPoppler(pdfPath);
  } catch (error) {
    if (!isMissingExecutableError(error)) {
      throw error;
    }

    return extractPdfTextPages(pdfPath);
  }
}

async function determineHiddenTextInjectionPages({
  pdfPath,
  candidatePageNumbers,
}) {
  const candidateSet = normalizePageNumberSet(candidatePageNumbers);
  if (candidateSet === null) {
    return null;
  }

  if (candidateSet.size === 0) {
    return [];
  }

  const extractedPages = await extractPdfTextPagesPreferPoppler(pdfPath);
  const extractedPageMap = new Map(
    extractedPages.map((page) => [page.pageNumber, page.text.length]),
  );

  return [...candidateSet]
    .filter((pageNumber) => (extractedPageMap.get(pageNumber) || 0) < READY_TEXT_MIN_LENGTH)
    .sort((left, right) => left - right);
}

async function determineSparseSemanticFallbackPages({
  pdfPath,
  documentModel,
}) {
  const extractedPages = await extractPdfTextPagesPreferPoppler(pdfPath);
  return selectSparseSemanticFallbackPageNumbers({
    extractedPages,
    documentModel,
  });
}

async function isTesseractAvailable() {
  try {
    await execFile("tesseract", ["--version"], {
      encoding: "utf8",
      maxBuffer: POPPLER_EXEC_MAX_BUFFER,
      windowsHide: true,
    });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function runTesseractOnImage(imagePath) {
  const { stdout } = await execFile("tesseract", [imagePath, "stdout", "--psm", "6"], {
    encoding: "utf8",
    maxBuffer: POPPLER_EXEC_MAX_BUFFER,
    windowsHide: true,
  });
  return sanitizePdfTextContent(stdout);
}

async function applySparsePageOcr({
  pdfPath,
  documentModel,
  bundleDir,
  visuallySparsePages = [],
}) {
  const available = await isTesseractAvailable();
  if (!available) {
    return {
      warnings: ["ocr_missing:tesseract"],
      ocrPages: [],
      ocrBackend: null,
    };
  }

  const extractedPages = await extractPdfTextPagesPreferPoppler(pdfPath);
  const candidatePageNumbers = selectSparseOcrPageNumbers({
    extractedPages,
    visuallySparsePages,
    minimumTextLength: OCR_PAGE_TEXT_LENGTH_THRESHOLD,
  });

  if (candidatePageNumbers.length === 0) {
    return {
      warnings: [],
      ocrPages: [],
      ocrBackend: "tesseract",
    };
  }

  const pageTextEntries = [];
  for (const pageNumber of candidatePageNumbers) {
    const pageBlocks = documentModel.blocks.filter(
      (block) => block.pageNumbers?.includes(pageNumber) && block.text,
    );
    const domTextLength = pageBlocks.reduce((sum, block) => sum + (block.text?.length ?? 0), 0);
    if (domTextLength >= READY_TEXT_MIN_LENGTH) {
      continue;
    }

    const imagePath = path.join(
      bundleDir,
      "pages",
      `page-${String(pageNumber).padStart(3, "0")}.png`,
    );
    if (!(await pathExists(imagePath))) {
      continue;
    }

    const ocrText = await runTesseractOnImage(imagePath);
    if (!ocrText || ocrText.length < OCR_PAGE_TEXT_LENGTH_THRESHOLD) {
      continue;
    }

    pageTextEntries.push({ pageNumber, text: ocrText });
  }

  if (pageTextEntries.length === 0) {
    return {
      warnings: [],
      ocrPages: [],
      ocrBackend: "tesseract",
    };
  }

  const hiddenTextResult = await addHiddenPageTextLayer(pdfPath, pageTextEntries);
  return {
    warnings: hiddenTextResult.warnings,
    ocrPages: pageTextEntries.map((entry) => entry.pageNumber),
    ocrBackend: "tesseract",
  };
}

async function computeImageInkDensity(imagePath) {
  const image = await loadImage(await fsp.readFile(imagePath));
  const width = Math.max(1, image.width);
  const height = Math.max(1, image.height);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, width, height);

  let sampleCount = 0;
  let inkCount = 0;
  const sampledRowCount = Math.ceil(height / POPPLER_QA_SAMPLE_STEP);
  const sampledColumnCount = Math.ceil(width / POPPLER_QA_SAMPLE_STEP);
  const rowHasInk = new Array(sampledRowCount).fill(false);
  const columnHasInk = new Array(sampledColumnCount).fill(false);
  let rowIndex = 0;

  for (let y = 0; y < height; y += POPPLER_QA_SAMPLE_STEP, rowIndex += 1) {
    let columnIndex = 0;
    for (let x = 0; x < width; x += POPPLER_QA_SAMPLE_STEP, columnIndex += 1) {
      const { data } = context.getImageData(x, y, 1, 1);
      sampleCount += 1;
      if (data[3] > 0 && (data[0] < 245 || data[1] < 245 || data[2] < 245)) {
        inkCount += 1;
        rowHasInk[rowIndex] = true;
        columnHasInk[columnIndex] = true;
      }
    }
  }

  return {
    inkDensity: sampleCount > 0 ? inkCount / sampleCount : 0,
    rowCoverage: rowHasInk.filter(Boolean).length / Math.max(rowHasInk.length, 1),
    columnCoverage: columnHasInk.filter(Boolean).length / Math.max(columnHasInk.length, 1),
  };
}

async function renderPdfPagesWithPopplerForQa(pdfPath, pageCount) {
  const temporaryDirectory = await fsp.mkdtemp(
    path.join(os.tmpdir(), "gamma-to-pdf-poppler-qa-"),
  );
  const outputPrefix = path.join(temporaryDirectory, "page");

  try {
    const { stderr } = await execPoppler("pdftoppm", [
      "-png",
      "-r",
      String(POPPLER_QA_RENDER_DPI),
      pdfPath,
      outputPrefix,
    ]);
    const imageEntries = (await fsp.readdir(temporaryDirectory))
      .map((name) => {
        const match = name.match(/^page-(\d+)\.png$/);
        if (!match) {
          return null;
        }

        return {
          pageNumber: Number.parseInt(match[1], 10),
          imagePath: path.join(temporaryDirectory, name),
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.pageNumber - right.pageNumber);

    const pages = [];
    for (const entry of imageEntries) {
      const inkMetrics = await computeImageInkDensity(entry.imagePath);
      pages.push({
        pageNumber: entry.pageNumber,
        ...inkMetrics,
      });
    }

    if (pages.length !== pageCount) {
      throw new CliError(
        `Poppler QA rendered ${pages.length} pages but expected ${pageCount}.`,
        1,
      );
    }

    return {
      pages,
      rendererWarnings: String(stderr || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    };
  } finally {
    await fsp.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

async function scanPopplerVisualSparsePages(pdfPath) {
  const { stdout } = await execPoppler("pdfinfo", [pdfPath]);
  const pageCount = parsePdfInfoPageCount(stdout);
  const visualRender = await renderPdfPagesWithPopplerForQa(pdfPath, pageCount || 1);
  return {
    pageCount: pageCount || visualRender.pages.length,
    visuallySparsePages: visualRender.pages
      .filter((page) => isLikelyVisuallySparsePage(page))
      .map((page) => page.pageNumber),
  };
}

export function findConsecutivePageRuns(pageNumbers) {
  const sorted = [...new Set(pageNumbers)]
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);

  const runs = [];
  let currentRun = [];

  for (const pageNumber of sorted) {
    if (currentRun.length === 0 || pageNumber === currentRun[currentRun.length - 1] + 1) {
      currentRun.push(pageNumber);
      continue;
    }

    runs.push(currentRun);
    currentRun = [pageNumber];
  }

  if (currentRun.length > 0) {
    runs.push(currentRun);
  }

  return runs;
}

export function computeTextDuplicationRatio(referenceTokenCount, candidateTokenCount) {
  return candidateTokenCount / Math.max(referenceTokenCount, 1);
}

export function isLikelyVisuallySparsePage({ inkDensity = 0, columnCoverage = 0 }) {
  return (
    inkDensity < POPPLER_VISUAL_SPARSE_DENSITY_THRESHOLD &&
    columnCoverage < POPPLER_VISUAL_SPARSE_COLUMN_COVERAGE_THRESHOLD
  );
}

export function selectSparseOcrPageNumbers({
  extractedPages,
  visuallySparsePages = [],
  minimumTextLength = OCR_PAGE_TEXT_LENGTH_THRESHOLD,
}) {
  const visuallySparseSet = new Set(
    (visuallySparsePages || [])
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isFinite(value) && value > 0),
  );

  return (extractedPages || [])
    .filter(
      (page) =>
        (page?.text?.length ?? 0) < minimumTextLength &&
        !visuallySparseSet.has(page.pageNumber),
    )
    .map((page) => page.pageNumber)
    .sort((left, right) => left - right);
}

export function selectSparseSemanticFallbackPageNumbers({
  extractedPages,
  documentModel,
  minimumExtractedTextLength = OCR_PAGE_TEXT_LENGTH_THRESHOLD,
  minimumDomTextLength = READY_TEXT_MIN_LENGTH,
}) {
  const domTextLengthByPage = new Map();

  for (const block of documentModel?.blocks || []) {
    const textLength = (block.text || "").length;
    if (textLength === 0) {
      continue;
    }

    for (const pageNumber of block.pageNumbers || []) {
      domTextLengthByPage.set(pageNumber, (domTextLengthByPage.get(pageNumber) || 0) + textLength);
    }
  }

  return (extractedPages || [])
    .filter(
      (page) =>
        (page?.text?.length ?? 0) < minimumExtractedTextLength &&
        (domTextLengthByPage.get(page.pageNumber) || 0) >= minimumDomTextLength,
    )
    .map((page) => page.pageNumber)
    .sort((left, right) => left - right);
}

async function runPdfjsChatReadyQa({
  pdfPath,
  documentModel,
  markdownText,
  bundleDir,
  landscapePages = [],
  ocrPages = [],
  ocrBackend = null,
}) {
  const pages = await extractPdfTextPages(pdfPath);
  const pdfText = pages.map((page) => page.text).join("\n");
  const astText = documentModel.blocks
    .filter((block) => block.text)
    .map((block) => block.text)
    .join("\n");
  const overlap = summarizeTextOverlap(astText || markdownText, pdfText);
  const warnings = [];

  if (overlap.recall < CHAT_READY_QA_WARNING_THRESHOLD) {
    warnings.push(`low_text_recall:${overlap.recall.toFixed(3)}`);
  }

  const sparsePages = pages
    .filter((page) => page.text.length < POPPLER_PARSER_SPARSE_TEXT_LENGTH)
    .map((page) => page.pageNumber);
  if (sparsePages.length > 0) {
    warnings.push(`sparse_pages:${sparsePages.join(",")}`);
  }

  const duplicationRatio = computeTextDuplicationRatio(
    overlap.referenceTokenCount,
    overlap.candidateTokenCount,
  );
  if (duplicationRatio > PDF_TEXT_DUPLICATION_RATIO_WARNING_THRESHOLD) {
    warnings.push(`text_duplication_ratio:${duplicationRatio.toFixed(3)}`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    validator: "pdfjs",
    overlap,
    sparsePages,
    visuallySparsePages: [],
    possibleSplitSpreads: [],
    landscapePages,
    ocrPages,
    ocrBackend,
    duplicationRatio,
    warnings,
  };

  const qaDir = path.join(bundleDir, "qa");
  await fsp.mkdir(qaDir, { recursive: true });
  await fsp.writeFile(path.join(qaDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function runPopplerChatReadyQa({
  pdfPath,
  documentModel,
  markdownText,
  bundleDir,
  landscapePages = [],
  ocrPages = [],
  ocrBackend = null,
}) {
  const [{ stdout: pdfInfoOutput }, { stdout: pdfFontsOutput }, pages] = await Promise.all([
    execPoppler("pdfinfo", [pdfPath]),
    execPoppler("pdffonts", [pdfPath]),
    extractPdfTextPagesWithPoppler(pdfPath),
  ]);

  const pdfPageCount = parsePdfInfoPageCount(pdfInfoOutput);
  const fontSummary = summarizePdffontsOutput(pdfFontsOutput);
  const visualRender = await renderPdfPagesWithPopplerForQa(pdfPath, pdfPageCount || pages.length);

  const pdfText = pages.map((page) => page.text).join("\n");
  const astText = documentModel.blocks
    .filter((block) => block.text)
    .map((block) => block.text)
    .join("\n");
  const overlap = summarizeTextOverlap(astText || markdownText, pdfText);
  const duplicationRatio = computeTextDuplicationRatio(
    overlap.referenceTokenCount,
    overlap.candidateTokenCount,
  );
  const sparsePages = pages
    .filter((page) => page.text.length < POPPLER_PARSER_SPARSE_TEXT_LENGTH)
    .map((page) => page.pageNumber);
  const visuallySparsePages = visualRender.pages
    .filter((page) => isLikelyVisuallySparsePage(page))
    .map((page) => page.pageNumber);
  const possibleSplitSpreads = findConsecutivePageRuns(visuallySparsePages).filter(
    (run) => run.length >= 2,
  );
  const warnings = [];

  if (pdfPageCount && pdfPageCount !== documentModel.pageCount) {
    warnings.push(`page_count_mismatch:${pdfPageCount}:${documentModel.pageCount}`);
  }

  if (overlap.recall < CHAT_READY_QA_WARNING_THRESHOLD) {
    warnings.push(`low_text_recall:${overlap.recall.toFixed(3)}`);
  }

  if (duplicationRatio > PDF_TEXT_DUPLICATION_RATIO_WARNING_THRESHOLD) {
    warnings.push(`text_duplication_ratio:${duplicationRatio.toFixed(3)}`);
  }

  if (sparsePages.length > 0) {
    warnings.push(`sparse_pages:${sparsePages.join(",")}`);
  }

  if (visuallySparsePages.length > 0) {
    warnings.push(`visually_sparse_pages:${visuallySparsePages.join(",")}`);
  }

  for (const run of possibleSplitSpreads) {
    warnings.push(`possible_split_spread:${run[0]}-${run[run.length - 1]}`);
  }

  if (visualRender.rendererWarnings.length > 0) {
    warnings.push(
      `renderer_warnings:${visualRender.rendererWarnings.slice(0, 3).join(" | ")}`,
    );
  }

  const report = {
    generatedAt: new Date().toISOString(),
    validator: "poppler",
    overlap,
    duplicationRatio,
    sparsePages,
    visuallySparsePages,
    possibleSplitSpreads,
    landscapePages,
    ocrPages,
    ocrBackend,
    pageCount: pdfPageCount,
    expectedPageCount: documentModel.pageCount,
    fontSummary,
    rendererWarnings: visualRender.rendererWarnings,
    warnings,
  };

  const qaDir = path.join(bundleDir, "qa");
  await fsp.mkdir(qaDir, { recursive: true });
  await fsp.writeFile(path.join(qaDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function runChatReadyQa({
  pdfPath,
  documentModel,
  markdownText,
  bundleDir,
  landscapePages = [],
  ocrPages = [],
  ocrBackend = null,
}) {
  try {
    return await runPopplerChatReadyQa({
      pdfPath,
      documentModel,
      markdownText,
      bundleDir,
      landscapePages,
      ocrPages,
      ocrBackend,
    });
  } catch (error) {
    if (!isMissingExecutableError(error)) {
      throw error;
    }

    const report = await runPdfjsChatReadyQa({
      pdfPath,
      documentModel,
      markdownText,
      bundleDir,
      landscapePages,
      ocrPages,
      ocrBackend,
    });
    report.warnings.push("validator_missing:poppler");
    await fsp.writeFile(
      path.join(bundleDir, "qa", "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    return report;
  }
}

async function createChatReadyBundle({
  pdfPath,
  documentModel,
  sourceUrl,
  title,
  warnings = [],
  qaSummary = null,
}) {
  const finalBundleDir = buildChatReadyBundleDirectoryPath(pdfPath);
  const temporaryBundleDir = createTemporaryBundleDirectoryPath(finalBundleDir);
  const pagesDirectory = path.join(temporaryBundleDir, "pages");

  await fsp.rm(temporaryBundleDir, { recursive: true, force: true });
  await fsp.mkdir(pagesDirectory, { recursive: true });

  try {
    const markdownText = buildChatReadyMarkdown(documentModel);
    const pages = await renderPdfPagesToImages(pdfPath, pagesDirectory);
    documentModel.pages = pages.map((page) => ({
      pageNumber: page.pageNumber,
      widthPx: page.widthPx,
      heightPx: page.heightPx,
      orientation: page.orientation,
    }));
    documentModel.pageCount = pages.length;
    const documentJson = toChatReadyDocumentJson(documentModel);
    const manifest = buildChatReadyManifest({
      bundleDir: temporaryBundleDir,
      pdfPath,
      sourceUrl,
      title,
      pageCount: pages.length,
      pages,
      warnings,
      qaSummary,
    });

    await fsp.writeFile(path.join(temporaryBundleDir, "document.md"), markdownText);
    await fsp.writeFile(
      path.join(temporaryBundleDir, "document.json"),
      `${JSON.stringify(documentJson, null, 2)}\n`,
    );
    await fsp.writeFile(
      path.join(temporaryBundleDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    await fsp.rm(finalBundleDir, { recursive: true, force: true });
    await fsp.rename(temporaryBundleDir, finalBundleDir);
    return {
      bundlePath: finalBundleDir,
      markdownText,
      manifest,
    };
  } catch (error) {
    await fsp.rm(temporaryBundleDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function buildOutputPath(outputArg, pageTitle, normalizedUrl) {
  const fallbackTitle = deriveFallbackTitle(normalizedUrl);
  const resolvedTitle = sanitizeFilename(pageTitle || fallbackTitle);
  const fileName = `${resolvedTitle}.pdf`;

  if (!outputArg) {
    const defaultOutputDirectory = path.resolve(process.cwd(), DEFAULT_OUTPUT_DIRECTORY);
    await fsp.mkdir(defaultOutputDirectory, { recursive: true });
    let candidate = path.join(defaultOutputDirectory, fileName);
    let index = 2;
    while (await pathExists(candidate)) {
      candidate = path.join(defaultOutputDirectory, `${resolvedTitle}-${index}.pdf`);
      index += 1;
    }
    return candidate;
  }

  const resolvedOutput = path.resolve(outputArg);
  const existing = await fsp.stat(resolvedOutput).catch(() => null);
  if (existing?.isDirectory()) {
    return path.join(resolvedOutput, fileName);
  }

  if (outputArg.endsWith(path.sep)) {
    return path.join(resolvedOutput, fileName);
  }

  return resolvedOutput.toLowerCase().endsWith(".pdf")
    ? resolvedOutput
    : `${resolvedOutput}.pdf`;
}

async function ensureParentDirectory(targetPath) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
}

async function exportPreparedPdfPage(
  page,
  outputPath,
  pdfRenderMode = DEFAULT_PDF_RENDER_MODE,
  renderArtifacts = { landscapeSpreads: [] },
) {
  const needsTemporaryBasePdf =
    pdfRenderMode !== "text" || (renderArtifacts.landscapeSpreads?.length ?? 0) > 0;
  const basePdfPath = needsTemporaryBasePdf ? createTemporaryPdfPath(outputPath) : outputPath;
  const landscapePdfPath =
    (renderArtifacts.landscapeSpreads?.length ?? 0) > 0 && pdfRenderMode !== "text"
      ? createTemporaryPdfPath(outputPath)
      : outputPath;

  try {
    await page.pdf({
      path: basePdfPath,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
      preferCSSPageSize: true,
      printBackground: true,
    });

    const landscapeRewriteResult = await rewritePdfWithLandscapeSpreads(
      basePdfPath,
      landscapePdfPath,
      renderArtifacts.landscapeSpreads ?? [],
    );

    if (pdfRenderMode === "text") {
      return {
        pageCount: landscapeRewriteResult.pageCount,
        rasterizedPageNumbers: [],
        landscapePageNumbers: landscapeRewriteResult.landscapePageNumbers,
        landscapePageNumberById: landscapeRewriteResult.landscapePageNumberById,
        heroRasterIds: renderArtifacts.rasterizedHeroIds ?? [],
        warnings: landscapeRewriteResult.warnings,
      };
    }

    const renderModeResult = await rewritePdfWithRenderMode(
      landscapePdfPath,
      outputPath,
      pdfRenderMode,
    );

    return {
      pageCount: renderModeResult.pageCount || landscapeRewriteResult.pageCount,
      rasterizedPageNumbers: renderModeResult.rasterizedPageNumbers,
      landscapePageNumbers: landscapeRewriteResult.landscapePageNumbers,
      landscapePageNumberById: landscapeRewriteResult.landscapePageNumberById,
      heroRasterIds: renderArtifacts.rasterizedHeroIds ?? [],
      warnings: landscapeRewriteResult.warnings,
    };
  } finally {
    if (basePdfPath !== outputPath) {
      await fsp.rm(basePdfPath, { force: true }).catch(() => {});
    }
    if (landscapePdfPath !== outputPath && landscapePdfPath !== basePdfPath) {
      await fsp.rm(landscapePdfPath, { force: true }).catch(() => {});
    }
  }
}

async function exportPdfFromPage(
  page,
  outputPath,
  deadline = Date.now() + 30_000,
  pdfRenderMode = DEFAULT_PDF_RENDER_MODE,
) {
  const renderArtifacts = await preparePageForPdf(page, deadline, pdfRenderMode);
  return exportPreparedPdfPage(page, outputPath, pdfRenderMode, renderArtifacts);
}

async function exportChatReadyFromPage(
  page,
  outputPath,
  { deadline, sourceUrl, title, qa = false, strictChatReady = false },
) {
  const warnings = [];
  const prep = await preparePageForChatReady(page, deadline, { sourceUrl, title });
  const exportResult = await exportPdfFromPage(page, outputPath, deadline, DEFAULT_PDF_RENDER_MODE);
  warnings.push(...(exportResult.warnings ?? []));

  const finalPageCount = exportResult.pageCount || (await resolvePdfPageCount(outputPath));
  const initialPageMetadata = Array.from({ length: finalPageCount }, (_, index) => ({
    pageNumber: index + 1,
    widthPx:
      exportResult.landscapePageNumbers?.includes(index + 1)
        ? DEFAULT_PRINTABLE_PAGE_HEIGHT_PX
        : DEFAULT_PRINTABLE_PAGE_WIDTH_PX,
    heightPx:
      exportResult.landscapePageNumbers?.includes(index + 1)
        ? DEFAULT_PRINTABLE_PAGE_WIDTH_PX
        : DEFAULT_PRINTABLE_PAGE_HEIGHT_PX,
    orientation: exportResult.landscapePageNumbers?.includes(index + 1) ? "landscape" : "portrait",
  }));
  remapDocumentModelToFinalPages(prep.documentModel, {
    finalPageCount,
    landscapePageNumberById: exportResult.landscapePageNumberById,
    pageMetadata: initialPageMetadata,
  });

  const heroPageNumbers = [...new Set(
    prep.documentModel.blocks
      .filter((block) => block.heroRasterId)
      .flatMap((block) => block.pageNumbers || []),
  )];
  const hiddenTextPageNumbers = await determineHiddenTextInjectionPages({
    pdfPath: outputPath,
    candidatePageNumbers: [
      ...(exportResult.rasterizedPageNumbers ?? []),
      ...(exportResult.landscapePageNumbers ?? []),
      ...heroPageNumbers,
    ],
  });
  const hiddenTextResult = await addHiddenSemanticTextLayer(outputPath, prep.documentModel, {
    pageNumbers: hiddenTextPageNumbers,
  });
  warnings.push(...hiddenTextResult.warnings);

  const semanticFallbackPageNumbers = await determineSparseSemanticFallbackPages({
    pdfPath: outputPath,
    documentModel: prep.documentModel,
  });
  const sparseSemanticPages = semanticFallbackPageNumbers.filter(
    (pageNumber) => !hiddenTextPageNumbers?.includes(pageNumber),
  );
  if (sparseSemanticPages.length > 0) {
    const sparseSemanticResult = await addHiddenSemanticTextLayer(outputPath, prep.documentModel, {
      pageNumbers: sparseSemanticPages,
    });
    warnings.push(...sparseSemanticResult.warnings);
  }

  const bundleResult = await createChatReadyBundle({
    pdfPath: outputPath,
    documentModel: prep.documentModel,
    sourceUrl,
    title,
    warnings,
    qaSummary: null,
  });

  let ocrPages = [];
  let ocrBackend = null;
  try {
    const preQaScan = await scanPopplerVisualSparsePages(outputPath);
    const ocrResult = await applySparsePageOcr({
      pdfPath: outputPath,
      documentModel: prep.documentModel,
      bundleDir: bundleResult.bundlePath,
      visuallySparsePages: preQaScan.visuallySparsePages,
    });
    warnings.push(...ocrResult.warnings);
    ocrPages = ocrResult.ocrPages;
    ocrBackend = ocrResult.ocrBackend;
  } catch (error) {
    if (!isMissingExecutableError(error)) {
      throw error;
    }
    warnings.push("validator_missing:poppler");
  }

  let qaReport = null;
  if (qa) {
    qaReport = await runChatReadyQa({
      pdfPath: outputPath,
      documentModel: prep.documentModel,
      markdownText: bundleResult.markdownText,
      bundleDir: bundleResult.bundlePath,
      landscapePages: exportResult.landscapePageNumbers ?? [],
      ocrPages,
      ocrBackend,
    });

    warnings.push(...qaReport.warnings);
    const qaManifest = buildChatReadyManifest({
      bundleDir: bundleResult.bundlePath,
      pdfPath: outputPath,
      sourceUrl,
      title,
      pageCount: bundleResult.manifest.pageCount,
      pages: bundleResult.manifest.pages,
      warnings: [...new Set(warnings)],
      qaSummary: {
        validator: qaReport.validator,
        recall: qaReport.overlap.recall,
        sparsePages: qaReport.sparsePages,
        visuallySparsePages: qaReport.visuallySparsePages ?? [],
        possibleSplitSpreads: qaReport.possibleSplitSpreads ?? [],
        landscapePages: qaReport.landscapePages ?? [],
        ocrPages: qaReport.ocrPages ?? [],
        ocrBackend: qaReport.ocrBackend ?? null,
      },
    });
    await fsp.writeFile(
      path.join(bundleResult.bundlePath, "manifest.json"),
      `${JSON.stringify(qaManifest, null, 2)}\n`,
    );
  } else {
    const manifest = buildChatReadyManifest({
      bundleDir: bundleResult.bundlePath,
      pdfPath: outputPath,
      sourceUrl,
      title,
      pageCount: bundleResult.manifest.pageCount,
      pages: bundleResult.manifest.pages,
      warnings: [...new Set(warnings)],
      qaSummary: null,
    });
    await fsp.writeFile(
      path.join(bundleResult.bundlePath, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }

  const uniqueWarnings = [...new Set(warnings)];

  if (strictChatReady && uniqueWarnings.length > 0) {
    throw new CliError(`Chat-ready export completed with warnings: ${uniqueWarnings.join("; ")}`, 5);
  }

  return {
    ...exportResult,
    bundlePath: bundleResult.bundlePath,
    warnings: uniqueWarnings,
    qaReport,
  };
}

async function reopenForPdf(normalizedUrl, profileDir, outputPath, pdfRenderMode) {
  const context = await launchContext(profileDir, true);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await waitForGammaDocument(page, normalizedUrl, 60_000);
    return await exportPdfFromPage(page, outputPath, Date.now() + 30_000, pdfRenderMode);
  } finally {
    await context.close().catch(() => {});
  }
}

async function reopenForChatReady(normalizedUrl, profileDir, outputPath, options) {
  const context = await launchContext(profileDir, true);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const signals = await waitForGammaDocument(page, normalizedUrl, 60_000);
    return await exportChatReadyFromPage(page, outputPath, {
      deadline: Date.now() + 30_000,
      sourceUrl: normalizedUrl,
      title: signals.title,
      qa: options.qa,
      strictChatReady: options.strictChatReady,
    });
  } finally {
    await context.close().catch(() => {});
  }
}

function formatRasterizationSummary(pdfRenderMode, rasterizedPageNumbers) {
  if (pdfRenderMode === "text" || rasterizedPageNumbers.length === 0) {
    return null;
  }

  const pageLabel =
    rasterizedPageNumbers.length === 1
      ? `page ${rasterizedPageNumbers[0]}`
      : `${rasterizedPageNumbers.length} pages (${rasterizedPageNumbers.join(", ")})`;

  if (pdfRenderMode === "raster-all") {
    return `Render mode raster-all rasterized ${pageLabel}.`;
  }

  return `Render mode hybrid rasterized ${pageLabel} for viewer compatibility.`;
}

async function runFixtureCorpus(args) {
  const fixtureListPath = path.resolve(args.qaFixtures);
  const raw = await fsp.readFile(fixtureListPath, "utf8");
  const fixtures = JSON.parse(raw);

  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    throw new CliError("Expected --qa-fixtures to point to a JSON array of fixture records.", 2);
  }

  const outputRoot = path.resolve(args.output || path.join(process.cwd(), "chat-ready-fixtures"));
  await fsp.mkdir(outputRoot, { recursive: true });

  let failures = 0;
  for (const fixture of fixtures) {
    if (!fixture?.url) {
      failures += 1;
      console.error("Skipped fixture without url.");
      continue;
    }

    const fixtureName = sanitizeFilename(fixture.name || deriveFallbackTitle(fixture.url));
    const fixtureArgs = {
      ...args,
      inputUrl: fixture.url,
      output: path.join(outputRoot, fixtureName),
      qaFixtures: null,
    };

    try {
      await run(fixtureArgs);
    } catch (error) {
      failures += 1;
      console.error(`Fixture "${fixtureName}" failed: ${error?.message ?? error}`);
    }
  }

  if (failures > 0) {
    throw new CliError(`Fixture corpus completed with ${failures} failure(s).`, 5);
  }
}

export async function run(args) {
  if (args.help || (!args.inputUrl && !args.qaFixtures)) {
    printHelp();
    return;
  }

  if (!args.inputUrl && args.qaFixtures) {
    await runFixtureCorpus(args);
    return;
  }

  const normalizedUrl = normalizeGammaUrl(args.inputUrl);
  const profileDir = path.resolve(args.profileDir);
  await fsp.mkdir(profileDir, { recursive: true });

  let context;
  try {
    context = await launchContext(profileDir, args.headless);
    const page = context.pages()[0] ?? (await context.newPage());
    const signals = await waitForGammaDocument(page, normalizedUrl, args.timeoutMs);
    let exportResult;

    const outputPath = await buildOutputPath(args.output, signals.title, normalizedUrl);
    await ensureParentDirectory(outputPath);

    try {
      if (args.chatReady) {
        exportResult = await exportChatReadyFromPage(page, outputPath, {
          deadline: Date.now() + args.timeoutMs,
          sourceUrl: normalizedUrl,
          title: signals.title,
          qa: args.qa,
          strictChatReady: args.strictChatReady,
        });
      } else {
        exportResult = await exportPdfFromPage(
          page,
          outputPath,
          Date.now() + args.timeoutMs,
          args.pdfRenderMode,
        );
      }
    } catch (error) {
      const message = `${error?.message ?? error}`;
      if (!/pdf|headless|print/i.test(message)) {
        throw error;
      }

      await context.close().catch(() => {});
      context = null;
      exportResult = args.chatReady
        ? await reopenForChatReady(normalizedUrl, profileDir, outputPath, {
            qa: args.qa,
            strictChatReady: args.strictChatReady,
          })
        : await reopenForPdf(
            normalizedUrl,
            profileDir,
            outputPath,
            args.pdfRenderMode,
          );
    }

    console.error(`Saved PDF to ${outputPath}`);
    const rasterizationSummary = formatRasterizationSummary(
      args.chatReady ? DEFAULT_PDF_RENDER_MODE : args.pdfRenderMode,
      exportResult?.rasterizedPageNumbers ?? [],
    );
    if (rasterizationSummary) {
      console.error(rasterizationSummary);
    }

    if (args.chatReady) {
      console.error(`Saved chat-ready bundle to ${exportResult.bundlePath}`);
      if (exportResult.warnings?.length) {
        console.error(`Chat-ready warnings: ${exportResult.warnings.join("; ")}`);
      }
    } else if (args.llmBundle) {
      const bundlePath = await createLlmBundle({
        pdfPath: outputPath,
        sourceUrl: normalizedUrl,
        title: signals.title,
      });
      console.error(`Saved LLM bundle to ${bundlePath}`);
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }

    if (/ERR_NAME_NOT_RESOLVED|net::ERR_|Navigation timeout/i.test(error?.message ?? "")) {
      throw new CliError(`Failed to load the Gamma page: ${error.message}`, 4);
    }

    throw new CliError(error?.message ?? "Unexpected error.", 1);
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }
}

function printHelp() {
  console.log(`Usage:
  npm run export -- <gamma-doc-url> [options]
  npm run export -- --chat-ready --qa --qa-fixtures ./fixtures.json [options]

Options:
  -o, --output <path>       Output file path or existing directory
  --profile-dir <path>      Persistent browser profile directory
  --timeout-ms <ms>         Total time to wait for login/challenge/render
  --headless                Run without opening a browser window
  --pdf-render-mode <mode>  PDF output mode: hybrid, text, or raster-all
  --llm-bundle              Also create a sibling bundle with per-page PNGs and manifest.json
  --chat-ready              Emit a PDF plus a .chat bundle with Markdown, JSON, and page images
  --qa                      Run automated parseability checks for chat-ready output
  --strict-chat-ready       Fail if chat-ready warnings are emitted
  --qa-fixtures <path>      Local JSON fixture list for chat-ready corpus runs
  -h, --help                Show this help

Examples:
  npm run export -- 'https://gamma.app/docs/AIAA-Offers-x6jr2brhztt8fwb?mode=doc'
  npm run export -- 'https://gamma.app/docs/AIAA-Offers-x6jr2brhztt8fwb' -o ./exports/
  npm run export -- 'https://gamma.app/docs/AIAA-Offers-x6jr2brhztt8fwb' --pdf-render-mode text
  npm run export -- 'https://gamma.app/docs/AIAA-Offers-x6jr2brhztt8fwb' --llm-bundle
  npm run export -- 'https://gamma.app/docs/AIAA-Offers-x6jr2brhztt8fwb' --chat-ready --qa
`);
}
