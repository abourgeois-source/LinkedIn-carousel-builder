const path = require("node:path");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");
const OpenAI = require("openai");

async function exportCarousel(payload) {
  validatePayload(payload);

  await assertReadable(payload.htmlPath, "HTML template");
  if (payload.cssPath) await assertReadable(payload.cssPath, "CSS file");

  const outputFolder = await createUniqueOutputFolder(payload.exportRoot, payload.outputFolderName);
  const tempFolder = path.join(outputFolder, ".temp");
  await fs.mkdir(tempFolder, { recursive: true });

  const html = await fs.readFile(payload.htmlPath, "utf8");
  const cssHref = payload.cssPath ? pathToFileURL(payload.cssPath).toString() : null;
  const report = [];

  const browser = await launchBrowser();
  const page = await browser.newPage({
    viewport: { width: payload.width, height: payload.height },
    deviceScaleFactor: 1
  });

  try {
    for (let index = 0; index < payload.slides.length; index += 1) {
      const slide = await prepareSlideFile({ payload, html, cssHref, tempFolder, outputFolder, index });
      await page.goto(pathToFileURL(slide.tempHtmlPath).toString(), { waitUntil: "networkidle" });
      await page.waitForFunction(
        () => document.querySelector(".stage .slide, [data-index], [data-lidb-slide], [data-slide], [data-slide-number], [data-lidb-slide-index]"),
        null,
        { timeout: 8000 }
      ).catch(() => {});
      await page.evaluate((script) => eval(script), getValidationScript(slide.runtimeValues, payload));
      await page.waitForFunction(() => Array.from(document.images).every((image) => image.complete), null, { timeout: 5000 }).catch(() => {});
      const finalValidation = await page.evaluate((script) => eval(script), getValidationScript(slide.runtimeValues, payload));
      await page.screenshot({ path: slide.outputPath, type: "png", clip: { x: 0, y: 0, width: payload.width, height: payload.height } });

      const aiReview = payload.useOpenAI ? await reviewSlideWithOpenAI(slide.outputPath, finalValidation) : null;
      report.push({ ...finalValidation, aiReview });
    }
  } finally {
    await browser.close();
    await fs.rm(tempFolder, { recursive: true, force: true });
  }

  await writeExportReport({ outputFolder, payload, report });

  return {
    outputFolder,
    slideCount: payload.slides.length,
    reportPath: path.join(outputFolder, "export-report.txt"),
    openaiEnabled: Boolean(payload.useOpenAI)
  };
}

async function launchBrowser() {
  try {
    return await chromium.launch();
  } catch (error) {
    if (!isMissingPlaywrightBrowser(error)) throw error;
    const executablePath = findSystemBrowser();
    if (!executablePath) {
      throw new Error(
        "Playwright Chromium is not installed, and no local Chrome/Edge executable was found. Run `npm run install:browsers` or install Chrome/Edge."
      );
    }
    return chromium.launch({ executablePath });
  }
}

function isMissingPlaywrightBrowser(error) {
  return /Executable doesn't exist|browserType\.launch|playwright install/i.test(error?.message || "");
}

function findSystemBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ].filter(Boolean);
  return candidates.find((candidate) => fsSync.existsSync(candidate));
}

function validatePayload(payload) {
  if (!payload?.htmlPath) throw new Error("Please upload an HTML template.");
  if (!payload?.slides?.length) throw new Error("Please add at least one slide.");
  if (payload.slides.length > 30) throw new Error("Please use 30 slides or fewer.");
  if (!Number.isInteger(payload.width) || payload.width < 100) throw new Error("Width must be at least 100 px.");
  if (!Number.isInteger(payload.height) || payload.height < 100) throw new Error("Height must be at least 100 px.");
  if (!payload.outputFolderName?.trim()) throw new Error("Please enter an output folder name.");
}

async function prepareSlideFile({ payload, html, cssHref, tempFolder, outputFolder, index }) {
  const slideNumber = index + 1;
  const slideCopy = payload.slides[index] || "";
  const imagePath = getSlideImagePath(payload, index);
  const slideType = getSlideType(slideNumber, payload.slides.length);
  if (imagePath) await assertReadable(imagePath, `Image for slide ${slideNumber}`);

  const preparedHtml = isBespokeAuditsTemplate(html)
    ? prepareBespokeAuditsHtml({
        slideCopy,
        slideNumber,
        totalSlides: payload.slides.length,
        imagePath,
        width: payload.width,
        height: payload.height
      })
    : prepareHtml({
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

function isBespokeAuditsTemplate(html) {
  return /Bespoke Audits/i.test(html) && /(Seven signs|What Good Looks Like|Canela|Leadership Alignment)/i.test(html);
}

function prepareBespokeAuditsHtml({ slideCopy, slideNumber, totalSlides, imagePath, width, height }) {
  const parts = splitSlideCopyNode(slideCopy);
  const imageUrl = imagePath ? pathToFileURL(imagePath).toString() : "";
  const isCover = slideNumber === 1;
  const isCta = slideNumber === totalSlides;
  const isImage = Boolean(imageUrl) && !isCover;
  const isAlt = slideNumber % 2 === 1;
  const eyebrow = parts.eyebrow || "Leadership Alignment";
  const label = isCover || isCta ? eyebrow : `${String(slideNumber - 1).padStart(2, "0")}  ·  ${eyebrow}`;
  const page = `${String(slideNumber).padStart(2, "0")}  /  ${String(totalSlides).padStart(2, "0")}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
*{box-sizing:border-box}html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#2E3532}
body{font-family:Inter,Arial,sans-serif}.slide{position:relative;width:${width}px;height:${height}px;overflow:hidden}
:root{--forest:#2E3532;--ink:#3E3A36;--cream:#F7F5F2;--stone:#EEEAE4;--taupe:#CFC8BE;--muted:#8B877F;--body:#6E6A65;--gold:#D8B46A;--goldDeep:#B89C6D;--rule:#D9D4CC;--serif:Canela,"Playfair Display",Georgia,serif}
.eyebrow,.label,.post,.pag,.slide-ref{font-family:Inter,Arial,sans-serif;text-transform:uppercase;letter-spacing:.28em;font-weight:600}
.cover{background:var(--forest)}.cover-photo{position:absolute;inset:0 0 650px 0;background:${imageUrl ? `url("${imageUrl}") center center/cover` : "#46504b"};filter:saturate(.82) contrast(.94) brightness(.84)}.cover-photo:after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(46,53,50,.06),rgba(46,53,50,.34) 62%,rgba(46,53,50,.96))}
.cover-panel{position:absolute;left:0;right:0;bottom:0;height:650px;background:var(--forest);padding:58px 96px 118px;display:flex;flex-direction:column;justify-content:space-between}
.eyebrow{font-size:25px;color:var(--taupe);margin-bottom:32px}.cover h1{font-family:var(--serif);font-size:60px;line-height:1.12;font-weight:400;color:var(--cream);max-width:890px;margin:0}.cover p{font-size:28px;line-height:1.48;color:var(--taupe);max-width:850px;margin:24px 0 0}.brand-row{border-top:2px solid rgba(216,180,106,.45);padding-top:32px;display:flex;justify-content:space-between;align-items:center}.brand-name{font-family:var(--serif);font-size:34px;color:var(--cream)}.slide-ref{font-size:23px;color:var(--muted)}
.text{background:var(--cream);padding:86px 98px 142px;display:flex;flex-direction:column}.text.alt{background:var(--stone)}.text.dark{background:var(--forest);color:var(--cream)}.photo-bg{background:${imageUrl ? `linear-gradient(180deg,rgba(46,53,50,.76),rgba(46,53,50,.90)),url("${imageUrl}") center center/cover` : "var(--forest)"}}
.top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:36px}.label{font-size:25px;color:var(--muted)}.dark .label{color:var(--taupe)}.post{font-size:23px;color:var(--taupe)}.dark .post{color:var(--muted)}.rule{width:86px;border:0;border-top:3px solid var(--gold);margin:0}
.content{position:relative;flex:1;display:flex;flex-direction:column;justify-content:center;padding-bottom:30px}.num{font-family:var(--serif);font-size:160px;line-height:.92;font-style:italic;color:var(--goldDeep);margin-bottom:28px}.title{font-family:var(--serif);font-size:60px;line-height:1.16;font-weight:400;color:var(--ink);max-width:850px;margin:0}.dark .title{color:var(--cream)}.body{font-size:29px;line-height:1.62;color:var(--body);max-width:835px;margin:32px 0 0}.dark .body{color:var(--taupe)}.ghost{position:absolute;right:-42px;bottom:108px;font-family:var(--serif);font-style:italic;font-size:620px;line-height:.8;color:rgba(62,58,54,.06);z-index:0}.content>*:not(.ghost){position:relative;z-index:1}
.footer{border-top:2px solid var(--rule);padding-top:32px;display:flex;justify-content:space-between;align-items:center}.dark .footer{border-top-color:rgba(216,180,106,.32)}.brand{font-family:var(--serif);font-size:32px;color:var(--body)}.dark .brand{color:var(--taupe)}.pag{font-size:23px;color:var(--taupe)}
.cta{background:var(--forest);display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:96px 96px 150px}.cta .eyebrow{margin-bottom:74px}.cta h2{font-family:var(--serif);font-size:76px;line-height:1.16;font-weight:400;color:var(--cream);max-width:860px;margin:0}.cta-rule{width:120px;border:0;border-top:3px solid var(--gold);margin:74px 0 70px}.cta-brand{font-family:var(--serif);font-size:43px;color:var(--cream);margin-bottom:18px}.cta-sub{font-size:23px;letter-spacing:.28em;text-transform:uppercase;color:var(--muted)}
</style>
</head>
<body>
${isCover ? `<section class="slide cover"><div class="cover-photo" data-lidb-image></div><div class="cover-panel"><div><div class="eyebrow">${escapeHtml(label)}</div><h1 data-lidb-headline>${escapeHtml(parts.headline)}</h1><p data-lidb-body>${escapeHtml(parts.body)}</p></div><div class="brand-row"><span class="brand-name">Bespoke Audits</span><span class="slide-ref">Swipe</span></div></div></section>` : ""}
${!isCover && !isCta ? `<section class="slide text ${isImage ? "dark photo-bg" : isAlt ? "alt" : ""}"><div class="top"><span class="label">${escapeHtml(label)}</span><span class="post">May 21</span></div><hr class="rule"><div class="content"><div class="num">${String(slideNumber - 1).padStart(2, "0")}</div><h2 class="title" data-lidb-headline>${escapeHtml(parts.headline)}</h2><p class="body" data-lidb-body>${escapeHtml(parts.body)}</p><div class="ghost">${slideNumber}</div></div><div class="footer"><span class="brand">Bespoke Audits</span><span class="pag">${page}</span></div></section>` : ""}
${isCta ? `<section class="slide cta"><div class="eyebrow">${escapeHtml(label)}</div><h2 data-lidb-headline>${escapeHtml(parts.headline)}</h2><hr class="cta-rule"><div class="cta-brand">Bespoke Audits</div><div class="cta-sub">Luxury Hospitality Advisory</div></section>` : ""}
</body>
</html>`;
}

function splitSlideCopyNode(slideCopy) {
  const normalized = String(slideCopy || "").replace(/\r/g, "").trim();
  const rawLines = normalized.split("\n").map((line) => line.trim()).filter(Boolean);
  const eyebrowLines = [];
  const lines = [];
  rawLines.forEach((line) => {
    const match = line.match(/^(eyebrow title|eyebrow|post label|label)\s*:\s*(.+)$/i);
    if (match) {
      eyebrowLines.push(match[2].trim());
      return;
    }
    lines.push(line);
  });
  const eyebrow = eyebrowLines[0] || "";
  const cleaned = lines.join("\n").trim();
  if (lines.length > 1) return { eyebrow, headline: lines[0], body: lines.slice(1).join("\n"), full: normalized };
  const sentences = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [cleaned];
  if (sentences.length > 1 && cleaned.length > 110) {
    return { eyebrow, headline: sentences[0].trim(), body: sentences.slice(1).join(" ").trim(), full: normalized };
  }
  return { eyebrow, headline: cleaned, body: "", full: normalized };
}

function runLockedDesignCheck({ slideCopy, slideNumber, totalSlides, slideType, imageUrl, width, height }) {
  const warnings = [];
  prepareFixedExportCanvas(width, height);

  const activeRoot = activateSlideRoot(slideNumber);
  prepareStageOnlyExport(activeRoot, width, height);
  const exportRoot = isolateExportRoot(activeRoot, width, height);
  const scope = exportRoot || activeRoot || document;

  const copyParts = splitSlideCopy(slideCopy);
  const copyTargets = replaceSlideCopy(scope, slideType, copyParts);

  const imageTargets = findImageTargets(scope);
  if (imageUrl && imageTargets.length) {
    imageTargets.forEach((node) => {
      if (node.tagName.toLowerCase() === "img") node.setAttribute("src", imageUrl);
      else if (node.classList?.contains("photo-bg")) node.style.backgroundImage = `linear-gradient(180deg, rgba(46,53,50,0.76), rgba(46,53,50,0.90)), url("${imageUrl}")`;
      else node.style.backgroundImage = `url("${imageUrl}")`;
    });
  } else if (imageUrl && scope?.style) {
    scope.style.backgroundImage = `linear-gradient(180deg, rgba(46,53,50,0.72), rgba(46,53,50,0.90)), url("${imageUrl}")`;
    scope.style.backgroundSize = "cover";
    scope.style.backgroundPosition = "center center";
  }

  scope.querySelectorAll("[data-lidb-slide-number], [data-slide-number]").forEach((node) => {
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
  const minFontSize = Math.max(getMinimumFontSize(slideType), Math.round(originalFontSize * 0.58));
  let finalFontSize = originalFontSize;
  let validation = validateSlideLayout({ target, safeArea, slideCopy, scope });

  for (let attempt = 0; attempt < 14 && !validation.passed; attempt += 1) {
    if (validation.overflow && finalFontSize > minFontSize) {
      finalFontSize = Math.max(minFontSize, Math.floor(finalFontSize * 0.92));
      target.style.fontSize = `${finalFontSize}px`;
      target.style.lineHeight = getLineHeight(slideType);
    }
    if (validation.overflow || validation.tooWide) {
      target.textContent = balanceLineBreaks(slideCopy, slideType, finalFontSize);
    }
    if (!validation.overflow && validation.tooShort) {
      verticallyBalanceText(target, safeArea);
    }
    validation = validateSlideLayout({ target, safeArea, slideCopy, scope });
  }

  if (validation.overflow) warnings.push("Text may still be tight after fitting.");
  if (validation.overlaps.length) warnings.push(`Possible overlap with: ${validation.overlaps.join(", ")}.`);
  if (!validation.copyMatches) warnings.push("Rendered text does not match the expected slide copy.");

  return createSlideReport({
    slideNumber,
    slideType,
    passed: validation.passed,
    finalFontSize: `${Math.round(finalFontSize)}px`,
    warnings
  });
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
    body::-webkit-scrollbar, html::-webkit-scrollbar { display: none !important; }
    .swiper-button-next, .swiper-button-prev, .swiper-pagination, .slick-dots,
    .carousel-control, .carousel-controls, [class*="pagination"], [class*="slider"], [class*="arrow"] {
      display: none !important;
    }
  `;
  document.head.appendChild(style);
}

function prepareStageOnlyExport(activeRoot, width, height) {
  const stage = activeRoot?.closest?.(".stage") || document.querySelector(".stage");
  if (!stage) return false;
  const rect = stage.getBoundingClientRect();
  if (rect.width < 100 || rect.height < 100) return false;
  const scaleX = width / rect.width;
  const scaleY = height / rect.height;
  const scale = Math.min(scaleX, scaleY);

  document.querySelectorAll(".controls, .counter, .dots, .btn-nav, [id='dots'], [id='counter'], [id='prev'], [id='next']").forEach((node) => {
    node.style.display = "none";
    node.style.visibility = "hidden";
  });

  const viewer = stage.closest(".viewer");
  if (viewer) {
    viewer.style.display = "block";
    viewer.style.width = `${width}px`;
    viewer.style.height = `${height}px`;
    viewer.style.margin = "0";
    viewer.style.padding = "0";
    viewer.style.gap = "0";
  }

  stage.setAttribute("data-lidb-stage-export", "true");
  stage.style.position = "fixed";
  stage.style.left = "0";
  stage.style.top = "0";
  stage.style.margin = "0";
  stage.style.boxShadow = "none";
  stage.style.overflow = "hidden";
  stage.style.transformOrigin = "top left";
  stage.style.transform = "none";
  stage.style.width = `${width}px`;
  stage.style.height = `${height}px`;
  stage.style.zIndex = "999999";

  stage.querySelectorAll(".slide, [data-index], [data-lidb-slide], [data-slide]").forEach((node) => {
    node.style.width = `${width}px`;
    node.style.height = `${height}px`;
  });
  scaleElementTree(stage, scale);

  document.body.style.background = getComputedStyle(activeRoot || stage).backgroundColor || "#2E3532";
  return true;
}

function scaleElementTree(root, scale) {
  const properties = [
    "fontSize",
    "lineHeight",
    "letterSpacing",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "marginTop",
    "marginRight",
    "marginBottom",
    "marginLeft",
    "width",
    "height",
    "maxWidth",
    "maxHeight",
    "minWidth",
    "minHeight",
    "top",
    "right",
    "bottom",
    "left",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth"
  ];
  const nodes = Array.from(root.querySelectorAll("*"));
  nodes.forEach((node) => {
    const computed = getComputedStyle(node);
    const isSlideContainer = node.matches(".slide, [data-index], [data-lidb-slide], [data-slide]");
    properties.forEach((property) => {
      if (isSlideContainer && ["width", "height", "maxWidth", "maxHeight", "minWidth", "minHeight", "top", "right", "bottom", "left"].includes(property)) return;
      const value = computed[property];
      if (!value || !value.endsWith("px")) return;
      const numeric = parseFloat(value);
      if (!Number.isFinite(numeric) || numeric === 0) return;
      node.style[property] = `${numeric * scale}px`;
    });
    if (computed.backgroundSize === "cover" || node.style.backgroundImage) {
      node.style.backgroundSize = "cover";
    }
  });
}

function isolateExportRoot(activeRoot, width, height) {
  const stage = activeRoot?.closest?.("[data-lidb-stage-export='true']");
  if (stage) return activeRoot || stage;
  if (activeRoot) {
    activeRoot.setAttribute("data-lidb-export-root", "true");
    activeRoot.style.position = "fixed";
    activeRoot.style.left = "0";
    activeRoot.style.top = "0";
    activeRoot.style.width = `${width}px`;
    activeRoot.style.height = `${height}px`;
    activeRoot.style.maxWidth = "none";
    activeRoot.style.maxHeight = "none";
    activeRoot.style.margin = "0";
    activeRoot.style.transform = "none";
    activeRoot.style.overflow = "hidden";
    return activeRoot;
  }
  if (document.body.dataset.lidbIsolated === "true") return document.querySelector("[data-lidb-export-root='true']");
  const exportRoot = findExportRoot(activeRoot);
  if (!exportRoot || exportRoot === document.body || exportRoot === document.documentElement) return null;

  const rect = exportRoot.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return null;

  const clone = exportRoot.cloneNode(true);
  document.body.innerHTML = "";
  document.body.appendChild(clone);
  document.body.dataset.lidbIsolated = "true";
  clone.setAttribute("data-lidb-export-root", "true");
  clone.style.position = "fixed";
  clone.style.left = "0";
  clone.style.top = "0";
  clone.style.margin = "0";
  clone.style.transformOrigin = "top left";
  clone.style.transform = `scale(${width / rect.width}, ${height / rect.height})`;
  clone.style.width = `${rect.width}px`;
  clone.style.height = `${rect.height}px`;
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
  const scored = candidates.map((node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return null;
    if (rect.width < 120 || rect.height < 120) return null;
    const area = rect.width * rect.height;
    if (area > viewportArea * 0.92) return null;
    const ratioScore = Math.abs(rect.width / rect.height - 0.8);
    const hasImage = node.querySelector("img, [data-lidb-image], [data-slide-image]") ? 1 : 0;
    const hasText = node.innerText && node.innerText.trim().length > 20 ? 1 : 0;
    return { node, score: (1 - Math.min(ratioScore, 1)) * 1000000 + Math.min(area, 320000) + hasImage * 220000 + hasText * 120000 };
  }).filter(Boolean).sort((a, b) => b.score - a.score);
  return scored[0]?.node || document.body;
}

function activateSlideRoot(slideNumber) {
  const zeroIndex = slideNumber - 1;
  const allSlideRoots = uniqueNodes(Array.from(document.querySelectorAll("[data-lidb-slide], [data-slide], [data-slide-number], [data-lidb-slide-index], [data-index], .slide, .carousel-slide, .swiper-slide")));
  if (!allSlideRoots.length) return null;
  const activeRoot = document.querySelector(`[data-lidb-slide="${slideNumber}"], [data-slide="${slideNumber}"], [data-slide-number="${slideNumber}"], [data-lidb-slide-index="${slideNumber}"], [data-lidb-slide-index="${zeroIndex}"], [data-index="${slideNumber}"], [data-index="${zeroIndex}"]`) || allSlideRoots[zeroIndex] || allSlideRoots[slideNumber - 1] || (allSlideRoots.length === 1 ? allSlideRoots[0] : null);
  allSlideRoots.forEach((node) => {
    const isActive = node === activeRoot;
    node.classList.toggle("active", isActive);
    node.setAttribute("aria-hidden", isActive ? "false" : "true");
    node.style.display = isActive ? "" : "none";
    node.style.opacity = isActive ? "1" : "0";
    node.style.pointerEvents = isActive ? "auto" : "none";
  });
  return activeRoot;
}

function replaceSlideCopy(scope, slideType, copyParts) {
  const explicitHeadline = firstVisible(scope, "[data-lidb-headline], [data-slide-headline]");
  const explicitBody = firstVisible(scope, "[data-lidb-body], [data-slide-body]");
  const explicitCopy = Array.from(scope.querySelectorAll("[data-lidb-copy], [data-slide-copy]")).filter(isReplaceableTextNode);
  if (explicitHeadline || explicitBody) {
    if (explicitHeadline) setTextNode(explicitHeadline, copyParts.headline);
    if (explicitBody) setTextNode(explicitBody, copyParts.body);
    else if (copyParts.body) appendBodyAfter(explicitHeadline, copyParts.body);
    return [explicitHeadline, explicitBody].filter(Boolean);
  }
  if (explicitCopy.length) {
    setTextNode(explicitCopy[0], copyParts.full);
    return [explicitCopy[0]];
  }

  const heading = findCopyTargets(scope, slideType, "headline")[0];
  const body = findCopyTargets(scope, slideType, "body").find((node) => node !== heading);
  if (heading && body && copyParts.body) {
    setTextNode(heading, copyParts.headline);
    setTextNode(body, copyParts.body);
    return [heading, body];
  }
  const target = heading || body || findCopyTargets(scope, slideType, "any")[0];
  if (target) setTextNode(target, copyParts.full);
  return target ? [target] : [];
}

function splitSlideCopy(slideCopy) {
  const normalized = String(slideCopy || "").replace(/\r/g, "").trim();
  const rawLines = normalized.split("\n").map((line) => line.trim()).filter(Boolean);
  const lines = [];
  rawLines.forEach((line) => {
    if (/^(eyebrow title|eyebrow|post label|label)\s*:/i.test(line)) return;
    lines.push(line);
  });
  const cleaned = lines.join("\n").trim();
  if (lines.length > 1) {
    return { headline: lines[0], body: lines.slice(1).join("\n"), full: normalized };
  }
  const sentences = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [cleaned];
  if (sentences.length > 1 && cleaned.length > 110) {
    return { headline: sentences[0].trim(), body: sentences.slice(1).join(" ").trim(), full: normalized };
  }
  return { headline: cleaned, body: "", full: normalized };
}

function setTextNode(node, value) {
  node.textContent = value;
  node.style.whiteSpace = "pre-line";
  node.style.overflowWrap = "break-word";
}

function appendBodyAfter(heading, bodyText) {
  if (!heading || !bodyText) return;
  const body = document.createElement("p");
  body.textContent = bodyText;
  body.style.whiteSpace = "pre-line";
  body.style.overflowWrap = "break-word";
  heading.insertAdjacentElement("afterend", body);
}

function findCopyTargets(scope, slideType, part = "any") {
  const marked = Array.from(scope.querySelectorAll("[data-lidb-copy], [data-slide-copy]"));
  if (marked.length) return marked;
  const headlineSelectors = ["[data-lidb-headline]", ".headline", ".title", ".heading", "[class*='headline']", "[class*='title']", "h1", "h2"];
  const bodySelectors = ["[data-lidb-body]", ".body", ".copy", ".description", "[class*='body']", "[class*='copy']", "p"];
  const selectors = part === "headline"
    ? headlineSelectors
    : part === "body"
      ? bodySelectors
      : slideType === "cover" || slideType === "cta" ? [...headlineSelectors, ...bodySelectors] : [...bodySelectors, ...headlineSelectors];
  const candidates = Array.from(scope.querySelectorAll(selectors.join(", "))).filter(isReplaceableTextNode);
  if (candidates.length) return [largestNode(candidates)];
  return Array.from(scope.querySelectorAll("h1, h2, h3, p, div, span")).filter(isReplaceableTextNode).sort(compareNodeArea).slice(0, 1);
}

function findImageTargets(scope) {
  const marked = Array.from(scope.querySelectorAll("[data-lidb-image], [data-slide-image]"));
  if (marked.length) return marked;
  const images = Array.from(scope.querySelectorAll("img")).filter((node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width >= 40 && rect.height >= 40 && style.display !== "none" && style.visibility !== "hidden";
  });
  if (images.length) return [largestNode(images)];
  const backgroundNodes = Array.from(scope.querySelectorAll("[style*='background-image'], .photo, [class*='photo'], [class*='image'], [class*='media']")).filter((node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width >= 80 && rect.height >= 80 && style.display !== "none" && style.visibility !== "hidden";
  });
  if (backgroundNodes.length) return [largestNode(backgroundNodes)];
  if (typeof scope.getBoundingClientRect !== "function") return [];
  const scopeRect = scope.getBoundingClientRect();
  return scopeRect.width >= 80 && scopeRect.height >= 80 ? [scope] : [];
}

function firstVisible(scope, selector) {
  return Array.from(scope.querySelectorAll(selector)).find(isReplaceableTextNode) || null;
}

function uniqueNodes(nodes) {
  return Array.from(new Set(nodes));
}

function isReplaceableTextNode(node) {
  const text = (node.textContent || "").trim();
  if (text.length < 8) return false;
  const tag = node.tagName.toLowerCase();
  if (["script", "style", "button", "nav", "footer"].includes(tag)) return false;
  if (node.closest("footer, nav, [data-lidb-footer], [data-lidb-logo], .logo, .brand-row")) return false;
  const rect = node.getBoundingClientRect();
  return rect.width >= 40 && rect.height >= 12;
}

function largestNode(nodes) {
  return nodes.sort(compareNodeArea)[0];
}

function compareNodeArea(a, b) {
  const aRect = a.getBoundingClientRect();
  const bRect = b.getBoundingClientRect();
  return bRect.width * bRect.height - aRect.width * aRect.height;
}

function findSafeTextArea(target) {
  return target.closest("[data-lidb-safe-area], [data-lidb-text-area], [data-slide-copy-area], [data-safe-text-area], .content") || target.parentElement || target;
}

function validateSlideLayout({ target, safeArea, slideCopy, scope }) {
  const targetRect = target.getBoundingClientRect();
  const safeRect = safeArea.getBoundingClientRect();
  const overflow = target.scrollHeight > target.clientHeight + 2 || target.scrollWidth > target.clientWidth + 2 ||
    targetRect.bottom > safeRect.bottom + 2 || targetRect.top < safeRect.top - 2 ||
    targetRect.left < safeRect.left - 2 || targetRect.right > safeRect.right + 2;
  const tooWide = targetRect.width > safeRect.width + 2;
  const tooShort = targetRect.height < safeRect.height * 0.34 && normalizeCopy(slideCopy).length < 95;
  const overlaps = findOverlaps(targetRect, target, scope);
  const copyMatches = normalizeCopy(target.textContent) === normalizeCopy(slideCopy);
  const normalizedTarget = normalizeCopy(target.textContent);
  const normalizedSlide = normalizeCopy(slideCopy);
  const acceptableCopy = normalizedTarget && (normalizedSlide.includes(normalizedTarget) || normalizedTarget.includes(normalizedSlide));
  return { copyMatches: acceptableCopy, overflow, tooWide, tooShort, overlaps, passed: acceptableCopy && !overflow && !tooWide && overlaps.length === 0 };
}

function findOverlaps(targetRect, target, scope) {
  const protectedSelectors = "[data-lidb-image], [data-slide-image], [data-lidb-slide-number], [data-lidb-total-slides], [data-lidb-logo], [data-lidb-footer], .logo, .brand-row, footer, .footer, .charcoal-box, [class*='charcoal']";
  const overlaps = [];
  Array.from(scope.querySelectorAll(protectedSelectors)).forEach((node) => {
    if (node === target || node.contains(target) || target.contains(node)) return;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return;
    const rect = node.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    if (!(targetRect.right <= rect.left + 4 || targetRect.left >= rect.right - 4 || targetRect.bottom <= rect.top + 4 || targetRect.top >= rect.bottom - 4)) {
      overlaps.push(node.className || node.tagName.toLowerCase());
    }
  });
  return Array.from(new Set(overlaps)).slice(0, 5);
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
  if (slideType === "cover") return 28;
  if (slideType === "cta") return 24;
  if (slideType === "closing") return 22;
  return 20;
}

function getLineHeight(slideType) {
  if (slideType === "cover") return "1.02";
  if (slideType === "cta") return "1.08";
  return "1.12";
}

function createSlideReport({ slideNumber, slideType, passed, finalFontSize, warnings }) {
  return { slide: slideNumber, type: slideType, passed, finalFontSize, warnings };
}

function getValidationScript(runtimeValues, payload) {
  const values = { ...runtimeValues, width: payload.width, height: payload.height };
  return `
    ${prepareFixedExportCanvas.toString()}
    ${prepareStageOnlyExport.toString()}
    ${scaleElementTree.toString()}
    ${isolateExportRoot.toString()}
    ${findExportRoot.toString()}
    ${activateSlideRoot.toString()}
    ${uniqueNodes.toString()}
    ${replaceSlideCopy.toString()}
    ${splitSlideCopy.toString()}
    ${setTextNode.toString()}
    ${appendBodyAfter.toString()}
    ${findCopyTargets.toString()}
    ${findImageTargets.toString()}
    ${firstVisible.toString()}
    ${isReplaceableTextNode.toString()}
    ${largestNode.toString()}
    ${compareNodeArea.toString()}
    ${findSafeTextArea.toString()}
    ${validateSlideLayout.toString()}
    ${findOverlaps.toString()}
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

async function reviewSlideWithOpenAI(imagePath, validation) {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const client = new OpenAI();
    const image = await fs.readFile(imagePath);
    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-5.2",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Review this LinkedIn carousel slide. Return a concise JSON-like verdict with pass true/false and warnings. Check text visibility, overflow, overlap, spacing, and whether it looks like a finished slide. Do not suggest redesigning colors, fonts, backgrounds, image placement, or structure."
            },
            {
              type: "input_image",
              image_url: `data:image/png;base64,${image.toString("base64")}`
            }
          ]
        }
      ]
    });
    return response.output_text || "";
  } catch (error) {
    return `OpenAI review failed: ${error.message}`;
  }
}

async function writeExportReport({ outputFolder, payload, report }) {
  const lines = [
    "LinkedIn Design Builder Export Report",
    `Generated: ${new Date().toLocaleString()}`,
    `Slides generated: ${payload.slides.length}/${payload.slides.length}`,
    `Dimensions: ${payload.width} x ${payload.height}px`,
    `OpenAI validation: ${payload.useOpenAI ? "enabled" : "disabled"}`,
    "Files:",
    ...payload.slides.map((_slide, index) => `- slide-${String(index + 1).padStart(2, "0")}.png`),
    "",
    "Layout validation:"
  ];

  report.forEach((item) => {
    lines.push(`- Slide ${String(item.slide).padStart(2, "0")} (${item.type}): ${item.passed ? "passed" : "warning"}; final font size: ${item.finalFontSize}`);
    const imagePath = getSlideImagePath(payload, item.slide - 1);
    lines.push(`  Image: ${imagePath ? path.basename(imagePath) : "none"}`);
    if (item.warnings?.length) item.warnings.forEach((warning) => lines.push(`  Warning: ${warning}`));
    if (item.aiReview) lines.push(`  OpenAI: ${item.aiReview}`);
  });

  await fs.writeFile(path.join(outputFolder, "export-report.txt"), `${lines.join("\n")}\n`, "utf8");
}

function getSlideImagePath(payload, index) {
  const imagePaths = payload.imagePaths || [];
  if (Array.isArray(payload.slideImages) && Object.prototype.hasOwnProperty.call(payload.slideImages, index)) {
    return resolveUploadedImagePath(payload.slideImages[index], imagePaths);
  }
  return "";
}

function resolveUploadedImagePath(value, imagePaths) {
  if (!value) return "";
  if (imagePaths.includes(value)) return value;
  const byName = imagePaths.find((imagePath) => path.basename(imagePath) === value || path.basename(imagePath) === path.basename(value));
  return byName || value;
}

function getSlideType(slideNumber, totalSlides) {
  if (slideNumber === 1) return "cover";
  if (slideNumber === totalSlides) return "cta";
  if (slideNumber === totalSlides - 1 && totalSlides > 2) return "closing";
  return "body";
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
    prepared = prepared.includes("</head>") ? prepared.replace("</head>", `${linkTag}\n</head>`) : `${linkTag}\n${prepared}`;
  }
  return prepared;
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

async function assertReadable(filePath, label) {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) throw new Error();
  } catch {
    throw new Error(`${label} could not be found. Please upload it again.`);
  }
}

async function createUniqueOutputFolder(basePath, requestedName) {
  await fs.mkdir(basePath, { recursive: true });
  const safeName = requestedName.trim().replace(/[<>:"/\\|?*]+/g, "-").replace(/\s+/g, " ").slice(0, 80);
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

module.exports = { exportCarousel };
