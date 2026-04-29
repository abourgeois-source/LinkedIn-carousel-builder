require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("node:path");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { exportCarousel } = require("./lib/exporter");

const app = express();
const port = Number(process.env.PORT || 4173);
const workspaceRoot = path.join(os.homedir(), "LinkedIn Design Builder Web");
const uploadRoot = path.join(workspaceRoot, "Uploads");
const exportRoot = path.join(workspaceRoot, "Exports");
const distRoot = path.join(__dirname, "..", "dist");

const storage = multer.diskStorage({
  destination: async (_req, _file, callback) => {
    try {
      const folder = path.join(uploadRoot, new Date().toISOString().replace(/[:.]/g, "-"));
      await fs.mkdir(folder, { recursive: true });
      callback(null, folder);
    } catch (error) {
      callback(error);
    }
  },
  filename: (_req, file, callback) => {
    callback(null, sanitizeFileName(file.originalname));
  }
});

const upload = multer({ storage });

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    openaiEnabled: Boolean(process.env.OPENAI_API_KEY)
  });
});

app.use(requireBasicAuth);
app.use("/exports", express.static(exportRoot));

app.post(
  "/api/assets",
  upload.fields([
    { name: "html", maxCount: 1 },
    { name: "css", maxCount: 1 },
    { name: "images", maxCount: 50 }
  ]),
  async (req, res, next) => {
    try {
      const html = req.files?.html?.[0];
      if (!html) {
        res.status(400).json({ error: "Please upload an HTML template." });
        return;
      }

      res.json({
        htmlPath: html.path,
        cssPath: req.files?.css?.[0]?.path || "",
        imagePaths: (req.files?.images || []).map((file) => file.path)
      });
    } catch (error) {
      next(error);
    }
  }
);

app.post("/api/export", async (req, res, next) => {
  try {
    const result = await exportCarousel({
      ...req.body,
      exportRoot,
      useOpenAI: Boolean(process.env.OPENAI_API_KEY)
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/download", async (req, res, next) => {
  try {
    const folderPath = req.query.folderPath;
    if (!folderPath || typeof folderPath !== "string") {
      res.status(400).json({ error: "Missing folder path." });
      return;
    }

    const safeFolderPath = resolveInsideExportRoot(folderPath);
    const zip = await createZipFromFolder(safeFolderPath);
    const fileName = `${sanitizeFileName(path.basename(safeFolderPath)) || "linkedin-carousel-export"}.zip`;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Length", zip.length);
    res.send(zip);
  } catch (error) {
    next(error);
  }
});

app.post("/api/open-folder", async (req, res, next) => {
  try {
    const folderPath = req.body?.folderPath;
    if (!folderPath) {
      res.status(400).json({ error: "Missing folder path." });
      return;
    }
    openFolder(folderPath);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

if (fsSync.existsSync(distRoot)) {
  app.use(express.static(distRoot));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api") || req.path.startsWith("/exports")) {
      next();
      return;
    }
    res.sendFile(path.join(distRoot, "index.html"));
  });
}

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.message || "Something went wrong." });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`LinkedIn Design Builder web app API running at http://localhost:${port}`);
  console.log(`Team access on your network: http://YOUR-COMPUTER-IP:${port}`);
});

function sanitizeFileName(value) {
  return value.replace(/[<>:"/\\|?*]+/g, "-").replace(/\s+/g, " ").trim();
}

function requireBasicAuth(req, res, next) {
  const password = process.env.APP_PASSWORD;
  if (!password) {
    next();
    return;
  }

  const username = process.env.APP_USERNAME || "team";
  const auth = req.headers.authorization || "";
  const [scheme, encoded] = auth.split(" ");
  if (scheme === "Basic" && encoded) {
    const [providedUser, providedPassword] = Buffer.from(encoded, "base64").toString("utf8").split(":");
    if (providedUser === username && providedPassword === password) {
      next();
      return;
    }
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="LinkedIn Carousel Builder"');
  res.status(401).send("Authentication required.");
}

function resolveInsideExportRoot(folderPath) {
  const resolvedRoot = path.resolve(exportRoot);
  const resolvedFolder = path.resolve(folderPath);
  const relativePath = path.relative(resolvedRoot, resolvedFolder);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    const error = new Error("Export folder is outside the allowed export directory.");
    error.status = 400;
    throw error;
  }
  return resolvedFolder;
}

async function createZipFromFolder(folderPath) {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /\.(png|txt)$/i.test(name))
    .sort((a, b) => a.localeCompare(b));

  if (!files.length) {
    throw new Error("No exported files were found in this folder.");
  }

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const fileName of files) {
    const filePath = path.join(folderPath, fileName);
    const data = await fs.readFile(filePath);
    const nameBuffer = Buffer.from(fileName, "utf8");
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuffer, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endHeader = Buffer.alloc(22);
  endHeader.writeUInt32LE(0x06054b50, 0);
  endHeader.writeUInt16LE(0, 4);
  endHeader.writeUInt16LE(0, 6);
  endHeader.writeUInt16LE(files.length, 8);
  endHeader.writeUInt16LE(files.length, 10);
  endHeader.writeUInt32LE(centralDirectory.length, 12);
  endHeader.writeUInt32LE(offset, 16);
  endHeader.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, endHeader]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = Array.from({ length: 256 }, (_value, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function openFolder(folderPath) {
  if (process.platform === "win32") {
    spawn("explorer.exe", [folderPath], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (process.platform === "darwin") {
    spawn("open", [folderPath], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [folderPath], { detached: true, stdio: "ignore" }).unref();
}
