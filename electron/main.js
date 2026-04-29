const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

const isDev = !app.isPackaged;
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 940,
    minHeight: 720,
    backgroundColor: "#f7f8fa",
    title: "LinkedIn Design Builder",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDev) {
    mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle("dialog:selectFile", async (_event, options) => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: options?.filters || []
  });

  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("dialog:selectImages", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "svg"] }
    ]
  });

  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle("dialog:selectImageFolder", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"]
  });

  if (result.canceled) return [];

  const folderPath = result.filePaths[0];
  const entries = await fs.readdir(folderPath);
  return entries
    .filter((entry) => /\.(png|jpe?g|webp|svg)$/i.test(entry))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((entry) => path.join(folderPath, entry));
});

ipcMain.handle("app:getSamplePaths", async () => {
  const sampleRoot = isDev
    ? path.join(app.getAppPath(), "samples")
    : path.join(process.resourcesPath, "samples");

  return {
    htmlPath: path.join(sampleRoot, "templates", "sample-carousel.html"),
    cssPath: path.join(sampleRoot, "templates", "sample-carousel.css"),
    imagePaths: [
      path.join(sampleRoot, "images", "sample-01.svg"),
      path.join(sampleRoot, "images", "sample-02.svg"),
      path.join(sampleRoot, "images", "sample-03.svg")
    ]
  };
});

ipcMain.handle("export:start", async (_event, payload) => {
  validateExportPayload(payload);
  return exportSlides(payload);
});

ipcMain.handle("folder:open", async (_event, folderPath) => {
  if (!folderPath) return false;
  await shell.openPath(folderPath);
  return true;
});

function validateExportPayload(payload) {
  if (!payload?.htmlPath) throw new Error("Please select an HTML template before exporting.");
  if (!payload?.slides?.length) throw new Error("Please add copy for at least one slide.");
  if (payload.slides.length > 30) throw new Error("Please use 30 slides or fewer.");
  if (!Number.isInteger(payload.width) || payload.width < 100) throw new Error("Width must be at least 100 px.");
  if (!Number.isInteger(payload.height) || payload.height < 100) throw new Error("Height must be at least 100 px.");
  if (!payload.outputFolderName?.trim()) throw new Error("Please enter an output folder name.");
}

async function exportSlides(payload) {
  await assertReadable(payload.htmlPath, "HTML template");
  if (payload.cssPath) await assertReadable(payload.cssPath, "CSS file");

  const outputBase = path.join(os.homedir(), "LinkedIn Design Builder", "Exports");
  await fs.mkdir(outputBase, { recursive: true });

  const outputFolder = await createUniqueOutputFolder(outputBase, payload.outputFolderName);
  const tempFolder = path.join(outputFolder, ".lidb-temp");
  await fs.mkdir(tempFolder, { recursive: true });

  const html = await fs.readFile(payload.htmlPath, "utf8");
  const cssHref = payload.cssPath ? pathToFileURL(payload.cssPath).toString() : null;
  const imagePaths = payload.imagePaths || [];

  let report;
  try {
    report = await renderSlidesWithPlaywright({ payload, html, cssHref, imagePaths, tempFolder, outputFolder });
  } catch (error) {
    if (!isBrowserInstallError(error)) throw error;
    report = await renderSlidesWithElectron({ payload, html, cssHref, imagePaths, tempFolder, outputFolder });
  } finally {
    await fs.rm(tempFolder, { recursive: true, force: true });
  }

  await writeExportReport({ outputFolder, payload, report });

  return {
    outputFolder,
    slideCount: payload.slides.length,
    reportPath: path.join(outputFolder, "export-report.txt")
  };
}

async function renderSlidesWithPlaywright({ payload, html, cssHref, imagePaths, tempFolder, outputFolder }) {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: payload.width, height: payload.height },
    deviceScaleFactor: 1
  });

  const report = [];

  try {
    for (let index = 0; index < payload.slides.length; index += 1) {
      const slide = await prepareSlideFile({ payload, html, cssHref, imagePaths, tempFolder, outputFolder, index });
      await page.goto(pathToFileURL(slide.tempHtmlPath).toString(), { waitUntil: "networkidle" });
      const validation = await page.evaluate((script) => eval(script), getValidationScript(slide.runtimeValues, payload));
      await page.waitForFunction(() => Array.from(document.images).every((image) => image.complete), null, { timeout: 5000 }).catch(() => {});
      const finalValidation = await page.evaluate((script) => eval(script), getValidationScript(slide.runtimeValues, payload));
      report.push(finalValidation || validation);
      await page.screenshot({ path: slide.outputPath, type: "png", clip: { x: 0, y: 0, width: payload.width, height: payload.height } });
    }
  } finally {
    await browser.close();
  }

  return report;
}

async function renderSlidesWithElectron({ payload, html, cssHref, imagePaths, tempFolder, outputFolder }) {
  const renderWindow = new BrowserWindow({
    show: false,
    width: payload.width,
    height: payload.height,
    useContentSize: true,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const report = [];

  try {
    for (let index = 0; index < payload.slides.length; index += 1) {
      const slide = await prepareSlideFile({ payload, html, cssHref, imagePaths, tempFolder, outputFolder, index });
      renderWindow.setContentSize(payload.width, payload.height);
      await renderWindow.loadFile(slide.tempHtmlPath);
      await renderWindow.webContents.executeJavaScript(getValidationScript(slide.runtimeValues, payload));
      await renderWindow.webContents.executeJavaScript(
        "Promise.all(Array.from(document.images).map((image) => image.complete ? Promise.resolve() : new Promise((resolve) => { image.onload = resolve; image.onerror = resolve; })))"
      );
      const finalValidation = await renderWindow.webContents.executeJavaScript(
        getValidationScript(slide.runtimeValues, payload)
      );
      report.push(finalValidation);
      const image = await renderWindow.webContents.capturePage({
        x: 0,
        y: 0,
        width: payload.width,
        height: payload.height
      });
      await fs.writeFile(slide.outputPath, image.toPNG());
    }
  } finally {
    renderWindow.destroy();
  }

  return report;
}

async function prepareSlideFile({ payload, html, cssHref, imagePaths, tempFolder, outputFolder, index }) {
  const slideNumber = index + 1;
  const slideCopy = payload.slides[index] || "";
  const imagePath = getSlideImagePath(payload, imagePaths, index);
  const slideType = getSlideType(slideNumber, payload.slides.length);
  if (imagePath) await assertReadable(imagePath, `Image for slide ${slideNumber}`);

  const preparedHtml = prepareHtml({
    html,
    cssHref,
    slideCopy,
    slideNumber,
    totalSlides: payload.slides.length,
    imagePath
  });

  const tempHtmlPath = path.join(tempFolder, `slide-${String(slideNumber).padStart(2, "0")}.html`);
  const outputPath = path.join(outputFolder, `slide-${String(slideNumber).padStart(2, "0")}.png`);
  await fs.writeFile(tempHtmlPath, preparedHtml, "utf8");

  return {
    tempHtmlPath,
    outputPath,
    runtimeValues: {
      slideCopy,
      slideNumber,
      totalSlides: payload.slides.length,
      slideType,
      imageUrl: imagePath ? pathToFileURL(imagePath).toString() : ""
    }
  };
}

function runLockedDesignCheck({ slideCopy, slideNumber, totalSlides, slideType, imageUrl, width, height }) {
  const warnings = [];
  document.documentElement.dataset.lidbSlideType = slideType;
  document.body.dataset.lidbSlideType = slideType;
  prepareFixedExportCanvas(width, height);

  const activeRoot = activateSlideRoot(slideNumber);
  const exportRoot = isolateExportRoot(activeRoot, width, height);
  const scope = exportRoot || activeRoot || document;
  const copyTargets = findCopyTargets(scope, slideType);
  copyTargets.forEach((node) => {
    node.textContent = slideCopy;
    node.dataset.lidbOriginalCopy = slideCopy;
    node.style.whiteSpace = "pre-line";
    node.style.overflowWrap = "break-word";
  });

  const imageTargets = findImageTargets(scope);
  imageTargets.forEach((node) => {
    if (!imageUrl) return;
    if (node.tagName.toLowerCase() === "img") {
      node.setAttribute("src", imageUrl);
    } else {
      node.style.backgroundImage = `url("${imageUrl}")`;
    }
  });

  scope.querySelectorAll("[data-lidb-slide-number]").forEach((node) => {
    node.textContent = String(slideNumber).padStart(2, "0");
  });

  scope.querySelectorAll("[data-lidb-total-slides]").forEach((node) => {
    node.textContent = String(totalSlides).padStart(2, "0");
  });

  const target = copyTargets[0];
  if (!target) {
    warnings.push("No text target found. Add data-lidb-copy to the intended text element for perfect replacement.");
    return createSlideReport({ slideNumber, slideType, passed: false, finalFontSize: "template", warnings });
  }

  const safeArea = findSafeTextArea(target);
  const originalFontSize = parseFloat(getComputedStyle(target).fontSize) || 64;
  const minFontSize = Math.max(getMinimumFontSize(slideType), Math.round(originalFontSize * 0.62));
  let finalFontSize = originalFontSize;
  let validation = validateSlideLayout({ target, safeArea, slideNumber, slideCopy, scope });

  for (let attempt = 0; attempt < 12 && !validation.passed; attempt += 1) {
    if (validation.overflow && finalFontSize > minFontSize) {
      finalFontSize = Math.max(minFontSize, Math.floor(finalFontSize * 0.93));
      target.style.fontSize = `${finalFontSize}px`;
      target.style.lineHeight = getLineHeight(slideType);
    }

    if (validation.overflow || validation.tooWide) {
      target.textContent = balanceLineBreaks(slideCopy, slideType, finalFontSize);
    }

    if (!validation.overflow && validation.tooShort) {
      verticallyBalanceText(target, safeArea);
    }

    validation = validateSlideLayout({ target, safeArea, slideNumber, slideCopy, scope });
  }

  if (validation.overflow) warnings.push("Text was fitted to the minimum allowed font size and may still be tight.");
  if (validation.overlaps.length) warnings.push(`Possible overlap with: ${validation.overlaps.join(", ")}.`);
  if (!validation.copyMatches) warnings.push("Rendered text does not match the expected slide copy.");
  if (validation.tooShort) warnings.push("Short copy was vertically balanced inside the existing text area.");

  const report = createSlideReport({
    slideNumber,
    slideType,
    passed: validation.passed,
    finalFontSize: `${Math.round(finalFontSize)}px`,
    warnings
  });
  report.exportRoot = exportRoot?.getAttribute("data-lidb-export-detected") || "template";
  return report;
}

function prepareFixedExportCanvas(width, height) {
  const style = document.getElementById("lidb-export-reset") || document.createElement("style");
  style.id = "lidb-export-reset";
  style.textContent = `
    html, body {
      width: ${width}px !important;
      height: ${height}px !important;
      min-width: ${width}px !important;
      min-height: ${height}px !important;
      max-width: ${width}px !important;
      max-height: ${height}px !important;
      margin: 0 !important;
      padding: 0 !important;
      overflow: hidden !important;
      scrollbar-width: none !important;
    }
    body::-webkit-scrollbar,
    html::-webkit-scrollbar {
      display: none !important;
    }
    [data-lidb-hide-for-export],
    .swiper-button-next,
    .swiper-button-prev,
    .swiper-pagination,
    .slick-dots,
    .carousel-control,
    .carousel-controls,
    [class*="pagination"],
    [class*="swiper"],
    [class*="slider"],
    [class*="arrow"] {
      display: none !important;
    }
  `;
  document.head.appendChild(style);
}

function isolateExportRoot(activeRoot, width, height) {
  if (document.body.dataset.lidbIsolated === "true") {
    return document.querySelector("[data-lidb-export-root='true']");
  }

  const exportRoot = findExportRoot(activeRoot);
  if (!exportRoot || exportRoot === document.body || exportRoot === document.documentElement) return null;

  const rect = exportRoot.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return null;

  const originalWidth = rect.width;
  const originalHeight = rect.height;
  const clone = exportRoot.cloneNode(true);
  clone.setAttribute("data-lidb-export-root", "true");
  clone.setAttribute("data-lidb-export-detected", exportRoot.tagName.toLowerCase());

  document.body.innerHTML = "";
  document.body.appendChild(clone);
  document.body.dataset.lidbIsolated = "true";
  document.body.style.margin = "0";
  document.body.style.padding = "0";
  document.body.style.overflow = "hidden";
  document.body.style.width = `${width}px`;
  document.body.style.height = `${height}px`;

  clone.style.position = "fixed";
  clone.style.left = "0";
  clone.style.top = "0";
  clone.style.margin = "0";
  clone.style.transformOrigin = "top left";
  clone.style.transform = `scale(${width / originalWidth}, ${height / originalHeight})`;
  clone.style.width = `${originalWidth}px`;
  clone.style.height = `${originalHeight}px`;
  clone.style.maxWidth = "none";
  clone.style.maxHeight = "none";
  clone.style.overflow = "hidden";

  return clone;
}

function findExportRoot(activeRoot) {
  const explicit = document.querySelector("[data-lidb-export], [data-export-slide], [data-export-root]");
  if (explicit) return explicit;
  if (activeRoot) return activeRoot;

  const candidates = Array.from(document.querySelectorAll("article, section, main, .slide, .card, .carousel-slide, .swiper-slide, [class*='slide'], [class*='card'], [class*='post'], [class*='canvas']"));
  const viewportArea = window.innerWidth * window.innerHeight;
  const scored = candidates
    .map((node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return null;
      if (rect.width < 120 || rect.height < 120) return null;
      const area = rect.width * rect.height;
      if (area > viewportArea * 0.92) return null;
      const ratio = rect.width / rect.height;
      const ratioScore = Math.abs(ratio - 0.8);
      const hasImage = node.querySelector("img, [data-lidb-image], [data-slide-image]") ? 1 : 0;
      const hasText = node.innerText && node.innerText.trim().length > 20 ? 1 : 0;
      const usableArea = Math.min(area, 320000);
      return { node, score: (1 - Math.min(ratioScore, 1)) * 1000000 + usableArea + hasImage * 220000 + hasText * 120000 };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.node || document.body;
}

function findCopyTargets(scope, slideType) {
  const marked = Array.from(scope.querySelectorAll("[data-lidb-copy], [data-slide-copy]"));
  if (marked.length) return marked;

  const headlineSelectors = [
    "[data-lidb-headline]",
    "[data-slide-headline]",
    ".headline",
    ".title",
    ".heading",
    "[class*='headline']",
    "[class*='title']",
    "h1",
    "h2"
  ];
  const bodySelectors = [
    "[data-lidb-body]",
    "[data-slide-body]",
    ".body",
    ".copy",
    ".description",
    "[class*='body']",
    "[class*='copy']",
    "p"
  ];
  const selectors = slideType === "cover" || slideType === "cta"
    ? [...headlineSelectors, ...bodySelectors]
    : [...bodySelectors, ...headlineSelectors];
  const candidates = Array.from(scope.querySelectorAll(selectors.join(", "))).filter(isReplaceableTextNode);
  if (candidates.length) {
    candidates.sort((a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return bRect.width * bRect.height - aRect.width * aRect.height;
    });
    return [candidates[0]];
  }

  const textCandidates = Array.from(scope.querySelectorAll("h1, h2, h3, p, div, span"))
    .filter(isReplaceableTextNode)
    .sort((a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return bRect.width * bRect.height - aRect.width * aRect.height;
    });
  return textCandidates.slice(0, 1);
}

function findImageTargets(scope) {
  const marked = Array.from(scope.querySelectorAll("[data-lidb-image], [data-slide-image]"));
  if (marked.length) return marked;

  const images = Array.from(scope.querySelectorAll("img")).filter((node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width >= 40 && rect.height >= 40 && style.display !== "none" && style.visibility !== "hidden";
  });

  if (!images.length) return [];
  images.sort((a, b) => {
    const aRect = a.getBoundingClientRect();
    const bRect = b.getBoundingClientRect();
    return bRect.width * bRect.height - aRect.width * aRect.height;
  });
  return [images[0]];
}

function isReplaceableTextNode(node) {
  const text = (node.textContent || "").trim();
  if (text.length < 8) return false;
  const tag = node.tagName.toLowerCase();
  if (["script", "style", "button", "nav", "footer"].includes(tag)) return false;
  if (node.closest("footer, nav, [data-lidb-footer], [data-lidb-logo], .logo, .brand-row")) return false;
  const rect = node.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 12) return false;
  return true;
}

function activateSlideRoot(slideNumber) {
  const selectors = [
    `[data-lidb-slide="${slideNumber}"]`,
    `[data-slide="${slideNumber}"]`,
    `[data-slide-number="${slideNumber}"]`,
    `[data-lidb-slide-index="${slideNumber}"]`
  ];
  const allSlideRoots = Array.from(document.querySelectorAll("[data-lidb-slide], [data-slide], [data-slide-number], [data-lidb-slide-index]"));
  if (!allSlideRoots.length) return null;

  const activeRoot = document.querySelector(selectors.join(", "));
  allSlideRoots.forEach((node) => {
    if (node === activeRoot) {
      node.style.display = "";
      node.removeAttribute("aria-hidden");
    } else {
      node.style.display = "none";
      node.setAttribute("aria-hidden", "true");
    }
  });

  return activeRoot;
}

function findSafeTextArea(target) {
  return target.closest("[data-lidb-safe-area], [data-lidb-text-area], [data-slide-copy-area], [data-safe-text-area], .content") || target.parentElement || target;
}

function validateSlideLayout({ target, safeArea, slideNumber, slideCopy, scope }) {
  const targetRect = target.getBoundingClientRect();
  const safeRect = safeArea.getBoundingClientRect();
  const normalizedRenderedCopy = normalizeCopy(target.textContent);
  const normalizedExpectedCopy = normalizeCopy(slideCopy);
  const overflow = target.scrollHeight > target.clientHeight + 2 || target.scrollWidth > target.clientWidth + 2 ||
    targetRect.bottom > safeRect.bottom + 2 || targetRect.top < safeRect.top - 2 ||
    targetRect.left < safeRect.left - 2 || targetRect.right > safeRect.right + 2;
  const tooWide = targetRect.width > safeRect.width + 2;
  const tooShort = targetRect.height < safeRect.height * 0.34 && normalizedExpectedCopy.length < 95;
  const overlaps = findOverlaps(targetRect, target, scope);
  const copyMatches = normalizedRenderedCopy === normalizedExpectedCopy;

  return {
    slideNumber,
    copyMatches,
    overflow,
    tooWide,
    tooShort,
    overlaps,
    passed: copyMatches && !overflow && !tooWide && overlaps.length === 0
  };
}

function findOverlaps(targetRect, target, scope) {
  const protectedSelectors = [
    "[data-lidb-image]",
    "[data-slide-image]",
    "[data-lidb-slide-number]",
    "[data-lidb-total-slides]",
    "[data-lidb-logo]",
    "[data-lidb-footer]",
    ".logo",
    ".brand-row",
    "footer",
    ".footer",
    ".charcoal-box",
    "[class*='charcoal']"
  ];
  const overlaps = [];
  const nodes = Array.from(scope.querySelectorAll(protectedSelectors.join(", ")));

  nodes.forEach((node) => {
    if (node === target || node.contains(target) || target.contains(node)) return;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return;
    const rect = node.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    if (rectanglesOverlap(targetRect, rect, 4)) {
      overlaps.push(node.getAttribute("data-lidb-role") || node.className || node.tagName.toLowerCase());
    }
  });

  return Array.from(new Set(overlaps)).slice(0, 5);
}

function rectanglesOverlap(a, b, padding) {
  return !(a.right <= b.left + padding || a.left >= b.right - padding || a.bottom <= b.top + padding || a.top >= b.bottom - padding);
}

function verticallyBalanceText(target, safeArea) {
  if (safeArea === target) return;
  safeArea.style.display = "flex";
  safeArea.style.flexDirection = "column";
  safeArea.style.justifyContent = "center";
}

function balanceLineBreaks(copy, slideType, fontSize) {
  const normalized = String(copy).replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const words = normalized.split(" ");
  const lineCount = getPreferredLineCount(slideType, normalized.length);
  const charsPerLine = Math.max(12, Math.ceil(normalized.length / lineCount) - Math.floor(fontSize / 18));
  const lines = [];
  let current = "";

  words.forEach((word) => {
    if ((current + " " + word).trim().length > charsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = (current + " " + word).trim();
    }
  });

  if (current) lines.push(current);
  return lines.join("\n");
}

function normalizeCopy(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function getPreferredLineCount(slideType, length) {
  if (slideType === "cover") return length > 90 ? 5 : 4;
  if (slideType === "closing") return length > 120 ? 6 : 5;
  if (slideType === "cta") return length > 90 ? 4 : 3;
  return length > 140 ? 7 : 6;
}

function getMinimumFontSize(slideType) {
  if (slideType === "cover") return 42;
  if (slideType === "cta") return 38;
  if (slideType === "closing") return 34;
  return 32;
}

function getLineHeight(slideType) {
  if (slideType === "cover") return "1.02";
  if (slideType === "cta") return "1.08";
  return "1.12";
}

function createSlideReport({ slideNumber, slideType, passed, finalFontSize, warnings }) {
  return {
    slide: slideNumber,
    type: slideType,
    passed,
    finalFontSize,
    warnings
  };
}

function getValidationScript(runtimeValues, payload) {
  const values = {
    ...runtimeValues,
    width: payload.width,
    height: payload.height
  };
  return `
    ${prepareFixedExportCanvas.toString()}
    ${isolateExportRoot.toString()}
    ${findExportRoot.toString()}
    ${findCopyTargets.toString()}
    ${findImageTargets.toString()}
    ${isReplaceableTextNode.toString()}
    ${activateSlideRoot.toString()}
    ${findSafeTextArea.toString()}
    ${validateSlideLayout.toString()}
    ${findOverlaps.toString()}
    ${rectanglesOverlap.toString()}
    ${verticallyBalanceText.toString()}
    ${balanceLineBreaks.toString()}
    ${normalizeCopy.toString()}
    ${getPreferredLineCount.toString()}
    ${getMinimumFontSize.toString()}
    ${getLineHeight.toString()}
    ${createSlideReport.toString()}
    (${runLockedDesignCheck.toString()})(${JSON.stringify(values)});
  `;
}

function isBrowserInstallError(error) {
  return /Executable doesn't exist|browserType.launch|install/i.test(error?.message || "");
}

function getSlideImagePath(payload, imagePaths, index) {
  if (Array.isArray(payload.slideImages) && Object.prototype.hasOwnProperty.call(payload.slideImages, index)) {
    return payload.slideImages[index] || "";
  }
  return imagePaths[index % Math.max(imagePaths.length, 1)] || "";
}

function getSlideType(slideNumber, totalSlides) {
  if (slideNumber === 1) return "cover";
  if (slideNumber === totalSlides) return "cta";
  if (slideNumber === totalSlides - 1 && totalSlides > 2) return "closing";
  return "body";
}

async function writeExportReport({ outputFolder, payload, report }) {
  const reportItems = Array.isArray(report) ? report : [];
  const lines = [
    "LinkedIn Design Builder Export Report",
    `Generated: ${new Date().toLocaleString()}`,
    `Slides generated: ${payload.slides.length}/${payload.slides.length}`,
    `Dimensions: ${payload.width} x ${payload.height}px`,
    "Files:",
    ...payload.slides.map((_slide, index) => `- slide-${String(index + 1).padStart(2, "0")}.png`),
    "",
    "Layout validation:"
  ];

  if (!reportItems.length) {
    lines.push("- Warning: layout validation report was unavailable, but export completed.");
  }

  reportItems.forEach((item) => {
    lines.push(`- Slide ${String(item.slide).padStart(2, "0")} (${item.type}): ${item.passed ? "passed" : "warning"}; final font size: ${item.finalFontSize}`);
    const imagePath = getSlideImagePath(payload, payload.imagePaths || [], item.slide - 1);
    lines.push(`  Image: ${imagePath ? path.basename(imagePath) : "none"}`);
    if (item.warnings?.length) {
      item.warnings.forEach((warning) => lines.push(`  Warning: ${warning}`));
    }
  });

  await fs.writeFile(path.join(outputFolder, "export-report.txt"), `${lines.join("\n")}\n`, "utf8");
}

async function assertReadable(filePath, label) {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) throw new Error();
  } catch {
    throw new Error(`${label} could not be found. Please select it again.`);
  }
}

async function createUniqueOutputFolder(basePath, requestedName) {
  const safeName = requestedName
    .trim()
    .replace(/[<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 80);

  const datePart = new Date().toISOString().slice(0, 10);
  let candidate = path.join(basePath, `${datePart} - ${safeName}`);
  let counter = 2;

  while (await pathExists(candidate)) {
    candidate = path.join(basePath, `${datePart} - ${safeName} (${counter})`);
    counter += 1;
  }

  await fs.mkdir(candidate, { recursive: true });
  return candidate;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function prepareHtml({ html, cssHref, slideCopy, slideNumber, totalSlides, imagePath }) {
  const imageUrl = imagePath ? pathToFileURL(imagePath).toString() : "";
  let prepared = html
    .replaceAll("{{SLIDE_COPY}}", escapeHtml(slideCopy))
    .replaceAll("{{SLIDE_NUMBER}}", String(slideNumber).padStart(2, "0"))
    .replaceAll("{{TOTAL_SLIDES}}", String(totalSlides).padStart(2, "0"))
    .replaceAll("{{IMAGE_SRC}}", imageUrl);

  if (cssHref && !prepared.includes(cssHref)) {
    const linkTag = `<link rel="stylesheet" href="${cssHref}">`;
    prepared = prepared.includes("</head>")
      ? prepared.replace("</head>", `${linkTag}\n</head>`)
      : `${linkTag}\n${prepared}`;
  }

  return prepared;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
