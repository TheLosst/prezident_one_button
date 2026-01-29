const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { nanoid } = require("nanoid");
const archiver = require("archiver");

const app = express();
const PORT = process.env.PORT || 3000;

const ADMIN_USER = "admin";
const ADMIN_PASS = "6kv8cHujbo9H";
const UPLOAD_USER = "uploader";
const UPLOAD_PASS = "mGe1pYeVkJCk";
let adminToken = null;
let uploadToken = null;

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const sanitizeFio = (value = "") =>
  value
    .toString()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[\\/:*?"<>|%]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 80);

const fioToFilenamePart = (value = "") =>
  sanitizeFio(value).replace(/\s/g, "_");

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const fioPart = fioToFilenamePart(req.body?.fio || "");
    const safePrefix = fioPart || "unknown";
    const uniqueName = `${safePrefix}_${Date.now()}-${nanoid(10)}${ext}`;
    cb(null, uniqueName);
  },
});

const upload = multer({ storage });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, "public")));

const getCookie = (req, name) => {
  const header = req.headers.cookie;
  if (!header) return null;
  const cookies = header.split(";").map((item) => item.trim());
  const match = cookies.find((item) => item.startsWith(`${name}=`));
  if (!match) return null;
  return decodeURIComponent(match.split("=")[1]);
};

const requireAdmin = (req, res, next) => {
  const token = getCookie(req, "admin_auth");
  if (!token || !adminToken || token !== adminToken) {
    return res.status(401).json({ ok: false, message: "Не авторизован" });
  }
  return next();
};

const requireUploadAuth = (req, res, next) => {
  const token = getCookie(req, "upload_auth");
  if (!token || !uploadToken || token !== uploadToken) {
    return res.status(401).json({ ok: false, message: "Не авторизован" });
  }
  return next();
};

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/upload-login", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "upload-login.html"));
});

app.post("/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    adminToken = nanoid(24);
    res.cookie("admin_auth", adminToken, {
      httpOnly: true,
      sameSite: "lax",
    });
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, message: "Неверные данные" });
});

app.post("/admin/logout", (req, res) => {
  adminToken = null;
  res.cookie("admin_auth", "", { maxAge: 0 });
  return res.json({ ok: true });
});

app.post("/upload/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === UPLOAD_USER && password === UPLOAD_PASS) {
    uploadToken = nanoid(24);
    res.cookie("upload_auth", uploadToken, {
      httpOnly: true,
      sameSite: "lax",
    });
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, message: "Неверные данные" });
});

app.post("/upload/logout", (req, res) => {
  uploadToken = null;
  res.cookie("upload_auth", "", { maxAge: 0 });
  return res.json({ ok: true });
});

app.get("/upload/session", (req, res) => {
  const token = getCookie(req, "upload_auth");
  if (token && uploadToken && token === uploadToken) {
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false });
});

app.get("/admin/files", requireAdmin, async (_req, res) => {
  try {
    const entries = await fs.promises.readdir(uploadsDir);
    const files = await Promise.all(
      entries
        .filter((name) => name !== ".gitkeep")
        .map(async (name) => {
          const filePath = path.join(uploadsDir, name);
          const stat = await fs.promises.stat(filePath);
          return {
            name,
            size: stat.size,
            mtime: stat.mtimeMs,
          };
        }),
    );

    files.sort((a, b) => b.mtime - a.mtime);
    return res.json({ ok: true, files, count: files.length });
  } catch (error) {
    return res.status(500).json({ ok: false, message: "Ошибка чтения" });
  }
});

app.get("/admin/download/:name", requireAdmin, (req, res) => {
  const safeName = path.basename(req.params.name);
  if (safeName !== req.params.name) {
    return res.status(400).json({ ok: false, message: "Некорректное имя" });
  }
  const filePath = path.join(uploadsDir, safeName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ ok: false, message: "Файл не найден" });
  }
  return res.download(filePath, safeName);
});

app.get("/admin/download-all", requireAdmin, async (_req, res) => {
  const entries = await fs.promises.readdir(uploadsDir);
  const files = entries.filter((name) => name !== ".gitkeep");
  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="uploads_${Date.now()}.zip"`,
  );

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", () => {
    res.status(500).end();
  });
  archive.pipe(res);

  for (const name of files) {
    const filePath = path.join(uploadsDir, name);
    archive.file(filePath, { name });
  }

  archive.finalize();
});

app.post("/upload", requireUploadAuth, upload.single("file"), (req, res) => {
  const fio = sanitizeFio(req.body?.fio || "");
  if (!fio) {
    if (req.file?.path) {
      fs.unlink(req.file.path, () => undefined);
    }
    return res.status(400).json({ ok: false, message: "ФИО обязательно" });
  }
  if (!req.file) {
    return res.status(400).json({ ok: false, message: "Файл не получен" });
  }

  return res.json({
    ok: true,
    filename: req.file.filename,
    originalName: req.file.originalname,
    size: req.file.size,
  });
});

app.listen(PORT, () => {
  console.log(`Server started on http://localhost:${PORT}`);
});
