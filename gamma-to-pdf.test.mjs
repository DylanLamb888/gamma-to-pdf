import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  buildOutputPath,
  buildBundleDirectoryPath,
  buildBundleManifest,
  buildChatReadyBundleDirectoryPath,
  buildChatReadyManifest,
  buildChatReadyMarkdown,
  classifyPageState,
  computeTextDuplicationRatio,
  detectPageOrientation,
  deriveFallbackTitle,
  findConsecutivePageRuns,
  isKeepTogetherCandidate,
  isLikelyChromeElement,
  isLikelyDomRasterizationCandidate,
  isLikelyHeroRasterCandidate,
  isLikelyLandscapeSpreadCandidate,
  isLikelyRasterizationCandidate,
  isLikelyVisuallySparsePage,
  mapPageNumberProportionally,
  normalizeGammaUrl,
  normalizeComparableText,
  normalizePdfRenderMode,
  paginateDocumentBlocks,
  parseArgs,
  parsePdfInfoPageCount,
  sanitizeFilename,
  selectSparseOcrPageNumbers,
  selectSparseSemanticFallbackPageNumbers,
  summarizeTextOverlap,
  summarizePdffontsOutput,
  shouldForceBreakBeforeSection,
  stripGammaTitleSuffix,
} from "./gamma-to-pdf.mjs";

test("parseArgs handles standard flags", () => {
  const args = parseArgs([
    "https://gamma.app/docs/example-abc123456",
    "--timeout-ms",
    "5000",
    "--profile-dir",
    "/tmp/profile",
    "-o",
    "out.pdf",
    "--headless",
  ]);

  assert.equal(args.inputUrl, "https://gamma.app/docs/example-abc123456");
  assert.equal(args.timeoutMs, 5000);
  assert.equal(args.profileDir, "/tmp/profile");
  assert.equal(args.output, "out.pdf");
  assert.equal(args.headless, true);
  assert.equal(args.pdfRenderMode, "hybrid");
});

test("parseArgs enables llm bundle mode", () => {
  const args = parseArgs([
    "https://gamma.app/docs/example-abc123456",
    "--llm-bundle",
  ]);

  assert.equal(args.llmBundle, true);
});

test("parseArgs enables chat-ready mode and QA flags", () => {
  const args = parseArgs([
    "https://gamma.app/docs/example-abc123456",
    "--chat-ready",
    "--qa",
    "--strict-chat-ready",
  ]);

  assert.equal(args.chatReady, true);
  assert.equal(args.qa, true);
  assert.equal(args.strictChatReady, true);
});

test("parseArgs accepts explicit pdf render mode", () => {
  const args = parseArgs([
    "https://gamma.app/docs/example-abc123456",
    "--pdf-render-mode",
    "raster-all",
  ]);

  assert.equal(args.pdfRenderMode, "raster-all");
});

test("parseArgs rejects incompatible chat-ready combinations", () => {
  assert.throws(
    () =>
      parseArgs([
        "https://gamma.app/docs/example-abc123456",
        "--chat-ready",
        "--llm-bundle",
      ]),
    /--chat-ready or --llm-bundle/,
  );

  assert.throws(
    () =>
      parseArgs([
        "https://gamma.app/docs/example-abc123456",
        "--chat-ready",
        "--pdf-render-mode",
        "text",
      ]),
    /omit --pdf-render-mode/,
  );
});

test("normalizeGammaUrl enforces gamma docs path and mode=doc", () => {
  assert.equal(
    normalizeGammaUrl("https://gamma.app/docs/AIAA-Offers-x6jr2brhztt8fwb"),
    "https://gamma.app/docs/AIAA-Offers-x6jr2brhztt8fwb?mode=doc",
  );
});

test("normalizePdfRenderMode validates supported modes", () => {
  assert.equal(normalizePdfRenderMode("TEXT"), "text");
  assert.throws(() => normalizePdfRenderMode("bitmap"), /--pdf-render-mode/);
});

test("deriveFallbackTitle strips trailing Gamma ids", () => {
  assert.equal(
    deriveFallbackTitle("https://gamma.app/docs/AIAA-Offers-x6jr2brhztt8fwb?mode=doc"),
    "AIAA Offers",
  );
});

test("sanitizeFilename removes invalid characters and suffixes", () => {
  assert.equal(sanitizeFilename('Quarterly "Plan" / Gamma - Gamma'), "Quarterly -Plan- - Gamma");
});

test("buildBundleDirectoryPath derives sibling bundle directory from pdf path", () => {
  assert.equal(
    buildBundleDirectoryPath("/tmp/exports/AIAA- Offers.pdf"),
    "/tmp/exports/AIAA- Offers.llm",
  );
});

test("buildChatReadyBundleDirectoryPath derives sibling chat bundle directory from pdf path", () => {
  assert.equal(
    buildChatReadyBundleDirectoryPath("/tmp/exports/AIAA- Offers.pdf"),
    "/tmp/exports/AIAA- Offers.chat",
  );
});

test("buildOutputPath defaults to the exports directory", async () => {
  const originalCwd = process.cwd();
  process.chdir("/tmp");

  try {
    const outputPath = await buildOutputPath(
      null,
      "AIAA: Offers - Gamma",
      "https://gamma.app/docs/AIAA-Offers-x6jr2brhztt8fwb?mode=doc",
    );
    assert.equal(path.basename(outputPath), "AIAA- Offers.pdf");
    assert.equal(path.basename(path.dirname(outputPath)), "exports");
  } finally {
    process.chdir(originalCwd);
  }
});

test("buildBundleManifest emits relative bundle paths and metadata", () => {
  const bundleDir = "/tmp/exports/AIAA- Offers.llm";
  const pdfPath = "/tmp/exports/AIAA- Offers.pdf";
  const manifest = buildBundleManifest({
    bundleDir,
    pdfPath,
    sourceUrl: "https://gamma.app/docs/AIAA-Offers-x6jr2brhztt8fwb?mode=doc",
    title: "AIAA: Offers - Gamma",
    generatedAt: "2026-03-24T10:00:00.000Z",
    pageCount: 2,
    pages: [
      {
        pageNumber: 1,
        imageFile: "pages/page-001.png",
        widthPx: 1632,
        heightPx: 2112,
        orientation: "portrait",
      },
      {
        pageNumber: 2,
        imageFile: "pages/page-002.png",
        widthPx: 1632,
        heightPx: 2112,
        orientation: "portrait",
      },
    ],
  });

  assert.deepEqual(manifest, {
    sourceUrl: "https://gamma.app/docs/AIAA-Offers-x6jr2brhztt8fwb?mode=doc",
    title: "AIAA: Offers",
    generatedAt: "2026-03-24T10:00:00.000Z",
    pdfFile: "../AIAA- Offers.pdf",
    pageCount: 2,
    paperSize: "letter",
    imageScale: 2,
    pages: [
      {
        pageNumber: 1,
        imageFile: "pages/page-001.png",
        widthPx: 1632,
        heightPx: 2112,
        orientation: "portrait",
      },
      {
        pageNumber: 2,
        imageFile: "pages/page-002.png",
        widthPx: 1632,
        heightPx: 2112,
        orientation: "portrait",
      },
    ],
  });
});

test("buildChatReadyManifest includes sidecar files and warnings", () => {
  const manifest = buildChatReadyManifest({
    bundleDir: "/tmp/exports/AIAA- Offers.chat",
    pdfPath: "/tmp/exports/AIAA- Offers.pdf",
    sourceUrl: "https://gamma.app/docs/AIAA-Offers-x6jr2brhztt8fwb?mode=doc",
    title: "AIAA: Offers - Gamma",
    generatedAt: "2026-03-24T10:00:00.000Z",
    pageCount: 1,
    warnings: ["low_text_recall:0.950"],
    qaSummary: {
      validator: "poppler",
      recall: 0.95,
      sparsePages: [18],
      visuallySparsePages: [18, 19],
      possibleSplitSpreads: [[18, 19]],
      landscapePages: [18],
      ocrPages: [30],
      ocrBackend: "tesseract",
    },
    pages: [
      {
        pageNumber: 1,
        imageFile: "pages/page-001.png",
        widthPx: 1632,
        heightPx: 2112,
        orientation: "portrait",
      },
    ],
  });

  assert.deepEqual(manifest, {
    mode: "chat-ready",
    sourceUrl: "https://gamma.app/docs/AIAA-Offers-x6jr2brhztt8fwb?mode=doc",
    title: "AIAA: Offers",
    generatedAt: "2026-03-24T10:00:00.000Z",
    pdfFile: "../AIAA- Offers.pdf",
    markdownFile: "document.md",
    jsonFile: "document.json",
    pageCount: 1,
    paperSize: "letter",
    imageScale: 2,
    warnings: ["low_text_recall:0.950"],
    qa: {
      validator: "poppler",
      recall: 0.95,
      sparsePages: [18],
      visuallySparsePages: [18, 19],
      possibleSplitSpreads: [[18, 19]],
      landscapePages: [18],
      ocrPages: [30],
      ocrBackend: "tesseract",
    },
    pages: [
      {
        pageNumber: 1,
        imageFile: "pages/page-001.png",
        widthPx: 1632,
        heightPx: 2112,
        orientation: "portrait",
      },
    ],
  });
});

test("buildChatReadyMarkdown renders headings, lists, callouts, and figures", () => {
  const markdown = buildChatReadyMarkdown({
    blocks: [
      { type: "heading", text: "Offers", level: 1 },
      { type: "paragraph", text: "Opening paragraph." },
      { type: "list_item", text: "Point one" },
      { type: "callout", text: "Important note." },
      { type: "figure", text: "", pageNumbers: [3] },
    ],
  });

  assert.equal(
    markdown,
    "# Offers\n\nOpening paragraph.\n\n- Point one\n> [!NOTE] Important note.\n\n![Figure on page 3]()\n",
  );
});

test("summarizeTextOverlap computes approximate recall", () => {
  const summary = summarizeTextOverlap(
    "This exporter emits hidden semantic text for chat parsing",
    "Hidden semantic text helps chat parsing",
  );

  assert.equal(summary.referenceTokenCount > 0, true);
  assert.equal(summary.candidateTokenCount > 0, true);
  assert.equal(summary.recall > 0 && summary.recall < 1, true);
});

test("parsePdfInfoPageCount reads page totals from pdfinfo output", () => {
  assert.equal(parsePdfInfoPageCount("Title: Example\nPages:           58\n"), 58);
  assert.equal(parsePdfInfoPageCount("Title: Example\n"), null);
});

test("summarizePdffontsOutput counts embedded Type 3 fonts", () => {
  const summary = summarizePdffontsOutput(`name                                 type              encoding
------------------------------------ ----------------- ----------------
AAAAAA+PetronaRoman-Bold             Type 3            Custom
Helvetica                            Type 1            WinAnsi
`);

  assert.deepEqual(summary, {
    totalFontCount: 2,
    type3FontCount: 1,
  });
});

test("findConsecutivePageRuns groups page ranges for split-spread warnings", () => {
  assert.deepEqual(findConsecutivePageRuns([19, 18, 27, 29, 28, 31]), [
    [18, 19],
    [27, 28, 29],
    [31],
  ]);
});

test("computeTextDuplicationRatio highlights extracted text inflation", () => {
  assert.equal(computeTextDuplicationRatio(100, 90), 0.9);
  assert.equal(computeTextDuplicationRatio(100, 150), 1.5);
});

test("detectPageOrientation and proportional page mapping support mixed final PDFs", () => {
  assert.equal(detectPageOrientation(1632, 2112), "portrait");
  assert.equal(detectPageOrientation(2112, 1632), "landscape");
  assert.equal(mapPageNumberProportionally(1, 49, 58), 1);
  assert.equal(mapPageNumberProportionally(49, 49, 58), 57);
});

test("isLikelyVisuallySparsePage flags narrow split-page artifacts", () => {
  assert.equal(
    isLikelyVisuallySparsePage({
      inkDensity: 0.085,
      columnCoverage: 0.09,
    }),
    true,
  );

  assert.equal(
    isLikelyVisuallySparsePage({
      inkDensity: 0.56,
      columnCoverage: 0.25,
    }),
    false,
  );
});

test("selectSparseOcrPageNumbers keeps screenshot-heavy sparse pages but skips visually sparse split pages", () => {
  assert.deepEqual(
    selectSparseOcrPageNumbers({
      extractedPages: [
        { pageNumber: 18, text: "The Videos" },
        { pageNumber: 19, text: "Views" },
        { pageNumber: 30, text: "tiny" },
        { pageNumber: 31, text: "Enough extracted text to skip OCR entirely." },
      ],
      visuallySparsePages: [18, 19],
      minimumTextLength: 12,
    }),
    [30],
  );
});

test("selectSparseSemanticFallbackPageNumbers targets parser-sparse pages with strong DOM text", () => {
  assert.deepEqual(
    selectSparseSemanticFallbackPageNumbers({
      extractedPages: [
        { pageNumber: 12, text: "" },
        { pageNumber: 13, text: "Enough extracted text already present here." },
      ],
      documentModel: {
        blocks: [
          { text: "A".repeat(120), pageNumbers: [12] },
          { text: "short", pageNumbers: [13] },
        ],
      },
      minimumExtractedTextLength: 24,
      minimumDomTextLength: 80,
    }),
    [12],
  );
});

test("paginateDocumentBlocks accounts for forced breaks and keep-together shifts", () => {
  const blocks = paginateDocumentBlocks([
    {
      type: "paragraph",
      text: "Intro",
      level: null,
      sourceKind: "semantic-tag",
      rect: { left: 0, top: 700, width: 600, height: 120 },
      keepTogether: false,
      allowSplit: false,
      forceBreakBefore: false,
    },
    {
      type: "heading",
      text: "Section Title",
      level: 2,
      sourceKind: "semantic-tag",
      rect: { left: 0, top: 980, width: 600, height: 120 },
      keepTogether: true,
      allowSplit: false,
      forceBreakBefore: true,
    },
    {
      type: "paragraph",
      text: "Body",
      level: null,
      sourceKind: "semantic-tag",
      rect: { left: 0, top: 1100, width: 600, height: 200 },
      keepTogether: true,
      allowSplit: false,
      forceBreakBefore: false,
    },
  ]);

  assert.deepEqual(
    blocks.map((block) => ({
      text: block.text,
      pages: block.pageNumbers,
    })),
    [
      { text: "Intro", pages: [1] },
      { text: "Section Title", pages: [2] },
      { text: "Body", pages: [2] },
    ],
  );
});

test("isLikelyRasterizationCandidate flags digit-heavy infographic layouts", () => {
  assert.equal(
    isLikelyRasterizationCandidate({
      shortLargeItemCount: 28,
      digitLargeItemCount: 6,
      averageShortLargeWidth: 81.1,
      verticalSpread: 318.7,
      leftAlignedLargeItemCount: 11,
      rightAlignedLargeItemCount: 14,
    }),
    true,
  );

  assert.equal(
    isLikelyRasterizationCandidate({
      shortLargeItemCount: 21,
      digitLargeItemCount: 0,
      averageShortLargeWidth: 42.1,
      verticalSpread: 559.5,
      leftAlignedLargeItemCount: 12,
      rightAlignedLargeItemCount: 4,
    }),
    false,
  );
});

test("isLikelyDomRasterizationCandidate flags complex live sections with visuals and distributed labels", () => {
  assert.equal(
    isLikelyDomRasterizationCandidate({
      visualCount: 1,
      digitMarkerCount: 6,
      headingBlockCount: 8,
      leftHeadingCount: 3,
      rightHeadingCount: 3,
      topHeadingCount: 2,
      bottomHeadingCount: 3,
    }),
    true,
  );

  assert.equal(
    isLikelyDomRasterizationCandidate({
      visualCount: 0,
      digitMarkerCount: 6,
      headingBlockCount: 8,
      leftHeadingCount: 3,
      rightHeadingCount: 3,
      topHeadingCount: 2,
      bottomHeadingCount: 3,
    }),
    false,
  );
});

test("hero and landscape override heuristics flag the intended high-risk sections", () => {
  assert.equal(
    isLikelyHeroRasterCandidate({
      gradientSignalCount: 3,
      fontSize: 72,
      width: 720,
      textLength: 64,
      top: 120,
      headingLike: true,
    }),
    true,
  );

  assert.equal(
    isLikelyLandscapeSpreadCandidate({
      width: 760,
      height: 540,
      textLength: 180,
      visualCount: 1,
      absoluteLikeCount: 6,
      shortHeadingCount: 8,
      digitMarkerCount: 4,
      distributedLabelCount: 5,
      lowTextDensity: true,
    }),
    true,
  );
});

test("shouldForceBreakBeforeSection pushes section starts off cramped page bottoms", () => {
  assert.equal(
    shouldForceBreakBeforeSection({
      offsetWithinPage: 930,
      height: 280,
    }),
    true,
  );

  assert.equal(
    shouldForceBreakBeforeSection({
      offsetWithinPage: 80,
      height: 280,
    }),
    false,
  );
});

test("stripGammaTitleSuffix and normalizeComparableText clean display strings", () => {
  assert.equal(stripGammaTitleSuffix("AIAA: Offers - Gamma"), "AIAA: Offers");
  assert.equal(normalizeComparableText("  AIAA:   Offers  "), "aiaa: offers");
});

test("isLikelyChromeElement detects title rows and avatar badges", () => {
  assert.equal(
    isLikelyChromeElement(
      {
        text: "AIAA: Offers",
        top: 12,
        right: 1180,
        width: 1080,
        height: 42,
        viewportWidth: 1440,
        viewportHeight: 1024,
        interactiveScore: 0,
        isFixedLike: false,
      },
      { pageTitle: "AIAA: Offers - Gamma" },
    ),
    true,
  );

  assert.equal(
    isLikelyChromeElement(
      {
        text: "AA",
        top: 8,
        right: 1400,
        width: 40,
        height: 40,
        viewportWidth: 1440,
        viewportHeight: 1024,
        interactiveScore: 1,
        isFixedLike: false,
      },
      { pageTitle: "AIAA: Offers - Gamma" },
    ),
    true,
  );
});

test("isKeepTogetherCandidate prefers callouts and section containers but skips oversize blocks", () => {
  assert.equal(
    isKeepTogetherCandidate({
      isRoot: false,
      isFixedLike: false,
      isScrollable: false,
      width: 700,
      height: 260,
      hasVisualContainer: true,
      hasMedia: false,
      hasHeading: false,
      hasDenseText: true,
      hasList: false,
    }),
    true,
  );

  assert.equal(
    isKeepTogetherCandidate({
      isRoot: false,
      isFixedLike: false,
      isScrollable: false,
      width: 700,
      height: 980,
      hasVisualContainer: true,
      hasMedia: false,
      hasHeading: true,
      hasDenseText: true,
      hasList: false,
    }),
    false,
  );
});

test("classifyPageState recognizes challenge and access denied pages", () => {
  assert.equal(
    classifyPageState({
      url: "https://gamma.app/docs/foo",
      title: "Just a moment...",
      bodyText: "Verify you are human",
      contentScore: 10,
    }),
    "challenge",
  );

  assert.equal(
    classifyPageState({
      url: "https://gamma.app/docs/foo",
      title: "Private Gamma",
      bodyText: "Ask the creator for access",
      contentScore: 20,
    }),
    "access-denied",
  );

  assert.equal(
    classifyPageState({
      url: "https://gamma.app/docs/foo",
      title: "AIAA Offers - Gamma",
      bodyText: "Enough rendered text to be considered ready.",
      contentScore: 120,
    }),
    "ready",
  );
});
