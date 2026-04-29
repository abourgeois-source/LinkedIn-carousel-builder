import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { CheckCircle2, Download, FileCode2, ImagePlus, Loader2, Lock, Play, Upload } from "lucide-react";
import "./styles.css";

const apiBase = import.meta.env.VITE_API_BASE || (import.meta.env.PROD ? "" : `${window.location.protocol}//${window.location.hostname}:4173`);
const defaultSlides = [
  "Write the cover hook for slide one.",
  "Add the first body idea for slide two.",
  "Add the second body idea for slide three.",
  "Add the third body idea for slide four.",
  "Add the fourth body idea for slide five.",
  "Summarize the main takeaway for slide six.",
  "Add the final CTA or brand message for slide seven."
];

function App() {
  const [htmlFile, setHtmlFile] = useState(null);
  const [cssFile, setCssFile] = useState(null);
  const [imageFiles, setImageFiles] = useState([]);
  const [uploadedAssets, setUploadedAssets] = useState(null);
  const [slideImages, setSlideImages] = useState(Array(defaultSlides.length).fill(""));
  const [slides, setSlides] = useState(defaultSlides);
  const [width, setWidth] = useState(1080);
  const [height, setHeight] = useState(1350);
  const [outputFolderName, setOutputFolderName] = useState("LinkedIn carousel export");
  const [status, setStatus] = useState({ type: "idle", message: "Ready to export." });
  const [exportResult, setExportResult] = useState(null);
  const [isExporting, setIsExporting] = useState(false);
  const [openaiEnabled, setOpenaiEnabled] = useState(false);

  const slideCount = slides.length;
  const imageSummary = useMemo(() => {
    if (!imageFiles.length) return "No replacement images selected";
    return `${imageFiles.length} image${imageFiles.length === 1 ? "" : "s"} selected`;
  }, [imageFiles]);

  async function uploadAssets() {
    if (!htmlFile) throw new Error("Upload an HTML template first.");
    const formData = new FormData();
    formData.append("html", htmlFile);
    if (cssFile) formData.append("css", cssFile);
    imageFiles.forEach((file) => formData.append("images", file));

    const response = await fetch(`${apiBase}/api/assets`, {
      method: "POST",
      body: formData
    });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Upload failed.");
      setUploadedAssets(data);
      setSlideImages((current) => current.map((imagePath, slideIndex) => {
        const hasManualMapping = current.some(Boolean);
        if (!hasManualMapping && data.imagePaths.length === 1) {
          return slideIndex === 0 ? data.imagePaths[0] : "";
        }
        if (!hasManualMapping && data.imagePaths.length === 2 && current.length >= 5) {
          if (slideIndex === 0) return data.imagePaths[0];
          if (slideIndex === 4) return data.imagePaths[1];
          return "";
        }
        if (!imagePath) return "";
        if (data.imagePaths.includes(imagePath)) return imagePath;
        return data.imagePaths.find((serverPath) => fileName(serverPath) === imagePath) || "";
      }));
      return data;
  }

  function updateSlideCount(nextCount) {
    const normalizedCount = Math.max(1, Math.min(30, Number(nextCount) || 1));
    setSlides((current) => {
      if (normalizedCount > current.length) {
        return [...current, ...Array.from({ length: normalizedCount - current.length }, (_, index) => `Slide ${current.length + index + 1} copy`)];
      }
      return current.slice(0, normalizedCount);
    });
    setSlideImages((current) => {
      if (normalizedCount > current.length) {
        return [...current, ...Array.from({ length: normalizedCount - current.length }, () => "")];
      }
      return current.slice(0, normalizedCount);
    });
  }

  function updateSlide(index, value) {
    setSlides((current) => current.map((slide, slideIndex) => (slideIndex === index ? value : slide)));
  }

  function updateSlideImage(index, value) {
    setSlideImages((current) => current.map((imagePath, slideIndex) => (slideIndex === index ? value : imagePath)));
  }

  async function startExport() {
    setExportResult(null);
    setIsExporting(true);
    setStatus({ type: "working", message: "Uploading files..." });

    try {
      const assets = uploadedAssets || await uploadAssets();
      const exportSlideImages = resolveSlideImagesForExport(slideImages, assets.imagePaths);
      setStatus({ type: "working", message: `Checking layout and generating ${slideCount} PNG slides...` });
      const response = await fetch(`${apiBase}/api/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...assets,
          slideImages: exportSlideImages,
          slides,
          width: Number(width),
          height: Number(height),
          outputFolderName
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Export failed.");
      setExportResult(result);
      setOpenaiEnabled(result.openaiEnabled);
      setStatus({ type: "success", message: "Carousel exported successfully" });
    } catch (error) {
      setStatus({ type: "error", message: error.message || "Export failed. Please check your files and try again." });
    } finally {
      setIsExporting(false);
    }
  }

  function downloadExport() {
    if (!exportResult?.outputFolder) return;
    window.location.href = `${apiBase}/api/download?folderPath=${encodeURIComponent(exportResult.outputFolder)}`;
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <h1>LinkedIn Design Builder</h1>
          <p>Team web app for locked-design carousel exports.</p>
        </div>
        <div className="lock-pill" title="Only copy and image replacement are enabled.">
          <Lock size={16} />
          Lock Design Mode
        </div>
      </header>

      <section className="grid">
        <Panel eyebrow="Template" title="Locked carousel source">
          <FileInput icon={<FileCode2 size={22} />} label="HTML template" accept=".html,.htm" file={htmlFile} onChange={setHtmlFile} />
          <FileInput icon={<FileCode2 size={22} />} label="CSS file" accept=".css" file={cssFile} optional onChange={setCssFile} />
        </Panel>

        <Panel eyebrow="Images" title="Replacement assets">
          <label className="file-input-card">
            <ImagePlus size={22} />
            <span>{imageSummary}</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              multiple
              onChange={(event) => {
                const files = Array.from(event.target.files || []);
                setImageFiles(files);
                setUploadedAssets(null);
              }}
            />
          </label>
          <div className="file-list" aria-label="Selected replacement images">
            {imageFiles.slice(0, 8).map((file) => <span key={file.name}>{file.name}</span>)}
            {imageFiles.length > 8 && <span>+ {imageFiles.length - 8} more</span>}
          </div>
        </Panel>
      </section>

      <section className="grid wide-left">
        <Panel eyebrow="Content" title="Slide copy and image mapping">
          <div className="slide-count-row">
            <label htmlFor="slide-count">Number of slides</label>
            <input id="slide-count" type="number" min="1" max="30" value={slideCount} onChange={(event) => updateSlideCount(event.target.value)} />
          </div>
          <div className="slides-stack">
            {slides.map((slide, index) => (
              <div className="slide-editor" key={`slide-${index + 1}`}>
                <label className="copy-field">
                  <span>{getSlideLabel(index + 1, slideCount)}</span>
                  <textarea value={slide} rows={3} onChange={(event) => updateSlide(index, event.target.value)} />
                </label>
                <label className="image-picker">
                  <span>Image for slide {index + 1}</span>
                  <select value={slideImages[index] || ""} onChange={(event) => updateSlideImage(index, event.target.value)}>
                    <option value="">No replacement image</option>
                    {(uploadedAssets?.imagePaths || imageFiles.map((file) => file.name)).map((imagePath, imageIndex) => (
                      <option value={imagePath} key={`${index}-${imagePath}`}>
                        {imageFiles[imageIndex]?.name || fileName(imagePath)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ))}
          </div>
        </Panel>

        <Panel eyebrow="Output" title="Export settings">
          <div className="settings-grid">
            <label>Width<input type="number" min="100" value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label>
            <label>Height<input type="number" min="100" value={height} onChange={(event) => setHeight(Number(event.target.value))} /></label>
          </div>
          <label className="stacked-label">Output folder name<input value={outputFolderName} onChange={(event) => setOutputFolderName(event.target.value)} /></label>
          <div className="format-box"><span>Export format</span><strong>PNG</strong></div>
          <p className="path-note">Server output path: LinkedIn Design Builder Web/Exports/</p>
          <p className="path-note">OpenAI validation: {openaiEnabled ? "enabled" : "disabled until OPENAI_API_KEY is set"}</p>
        </Panel>
      </section>

      <section className="export-panel">
        <div className={`status-line ${status.type}`}>
          {status.type === "success" ? <CheckCircle2 size={19} /> : status.type === "working" ? <Loader2 size={19} className="spin" /> : <Upload size={19} />}
          <span>{status.message}</span>
        </div>
        <div className="export-actions">
          {exportResult?.outputFolder && <button className="secondary-button" type="button" onClick={downloadExport}><Download size={17} />Download ZIP</button>}
          <button className="primary-button" type="button" disabled={!htmlFile || isExporting} onClick={startExport}>
            {isExporting ? <Loader2 size={18} className="spin" /> : <Play size={18} />}
            Generate {slideCount} PNG Slides
          </button>
        </div>
      </section>
    </main>
  );
}

function resolveSlideImagesForExport(slideImages, imagePaths) {
  const paths = imagePaths || [];
  const hasManualMapping = slideImages.some(Boolean);
  if (!hasManualMapping && paths.length === 1) {
    return slideImages.map((_value, index) => (index === 0 ? paths[0] : ""));
  }
  if (!hasManualMapping && paths.length === 2 && slideImages.length >= 5) {
    return slideImages.map((_value, index) => {
      if (index === 0) return paths[0];
      if (index === 4) return paths[1];
      return "";
    });
  }
  return slideImages.map((value) => {
    if (!value) return "";
    if (paths.includes(value)) return value;
    return paths.find((serverPath) => fileName(serverPath) === value) || "";
  });
}

function Panel({ eyebrow, title, children }) {
  return (
    <section className="panel">
      <div className="panel-header"><div><p>{eyebrow}</p><h2>{title}</h2></div></div>
      {children}
    </section>
  );
}

function FileInput({ icon, label, accept, file, optional, onChange }) {
  return (
    <label className="file-input-card">
      {icon}
      <span>{file?.name || `${label}${optional ? " (optional)" : ""}`}</span>
      <input type="file" accept={accept} onChange={(event) => onChange(event.target.files?.[0] || null)} />
    </label>
  );
}

function fileName(filePath) {
  return filePath.split(/[\\/]/).pop();
}

function getSlideLabel(slideNumber, totalSlides) {
  if (slideNumber === 1) return "Slide 1 copy - Cover slide";
  if (slideNumber === totalSlides) return `Slide ${slideNumber} copy - Final CTA or brand slide`;
  if (slideNumber === totalSlides - 1 && totalSlides > 2) return `Slide ${slideNumber} copy - Closing/summary slide`;
  return `Slide ${slideNumber} copy - Body slide`;
}

createRoot(document.getElementById("root")).render(<App />);
