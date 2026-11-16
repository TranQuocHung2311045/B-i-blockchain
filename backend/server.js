require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, "moto.db"));
db.exec(`CREATE TABLE IF NOT EXISTS records(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plate TEXT NOT NULL, date TEXT NOT NULL, odo INTEGER NOT NULL,
  type TEXT NOT NULL, description TEXT DEFAULT '', cost INTEGER DEFAULT 0,
  garage TEXT DEFAULT '', prev_hash TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
  tx_hash TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
db.exec("CREATE INDEX IF NOT EXISTS idx_plate ON records(plate)");
for (const col of ["image_hash TEXT DEFAULT ''", "image_file TEXT DEFAULT ''"])
  try { db.exec("ALTER TABLE records ADD COLUMN " + col); } catch (e) { /* da co cot */ }
db.exec(`CREATE TABLE IF NOT EXISTS vehicles(
  plate TEXT PRIMARY KEY, brand TEXT DEFAULT '', model TEXT DEFAULT '', year TEXT DEFAULT '',
  color TEXT DEFAULT '', vin TEXT DEFAULT '', engine TEXT DEFAULT '')`);
const UPLOADS = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOADS, { recursive: true });

// ---------- Tai khoan garage duy nhat (cau hinh trong .env) ----------
const GARAGE = process.env.GARAGE_NAME || "Garage";
const USER = (process.env.ADMIN_USER || "admin").toLowerCase();
const PASS = process.env.ADMIN_PASS || "admin123";
if (!process.env.ADMIN_PASS) console.log("CANH BAO: dang dung mat khau mac dinh admin123. Hay dat ADMIN_PASS trong backend/.env");

const sha = s => crypto.createHash("sha256").update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
const b64 = s => Buffer.from(s).toString("base64url");
const mac = s => crypto.createHmac("sha256", SECRET).update(s).digest("base64url");
const sign = p => { const body = b64(JSON.stringify(p)); return body + "." + mac(body); };
function verify(t) {
  const [body, sig] = String(t || "").split(".");
  if (!body || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(mac(body));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const p = JSON.parse(Buffer.from(body, "base64url")); return p.exp > Date.now() ? p : null; } catch { return null; }
}
const me = { username: USER, garage_name: GARAGE };
const auth = (req, res, next) =>
  verify((req.headers.authorization || "").replace(/^Bearer /, ""))
    ? next() : res.status(401).json({ error: "Bạn cần đăng nhập" });

// ---------- Ham dung chung ----------
const norm = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
// Neu moc co anh hoa don thi ma bam cua anh cung nam trong cong thuc (moc cu khong anh giu nguyen ma bam)
const hashOf = r => {
  const a = [r.plate, r.date, r.odo, r.type, r.description, r.cost, r.garage, r.prev_hash];
  if (r.image_hash) a.push(r.image_hash);
  return "0x" + crypto.createHash("sha256").update(JSON.stringify(a)).digest("hex");
};
const sha256hex = buf => crypto.createHash("sha256").update(buf).digest("hex");
const imageOk = r => {
  if (!r.image_hash) return true;
  try { return "0x" + sha256hex(fs.readFileSync(path.join(UPLOADS, r.image_file))) === r.image_hash; } catch { return false; }
};
const MAGIC = { "image/jpeg": b => b[0] === 0xff && b[1] === 0xd8, "image/png": b => b.slice(1, 4).toString() === "PNG",
  "image/webp": b => b.slice(0, 4).toString() === "RIFF" && b.slice(8, 12).toString() === "WEBP",
  "application/pdf": b => b.slice(0, 4).toString() === "%PDF" };
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };
function saveImage(dataUrl) {
  const m = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!m || !MAGIC[m[1]]) throw new Error("Chỉ nhận ảnh JPG, PNG, WEBP hoặc PDF");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 3 * 1024 * 1024) throw new Error("Tệp tối đa 3 MB");
  if (!MAGIC[m[1]](buf)) throw new Error("Nội dung tệp không khớp định dạng");
  const h = sha256hex(buf), file = h + "." + EXT[m[1]];
  fs.writeFileSync(path.join(UPLOADS, file), buf);
  return { hash: "0x" + h, file };
}
const vehicleOf = plate => { const v = db.prepare("SELECT brand,model,year,color,vin,engine FROM vehicles WHERE plate=?").get(plate); return v ? { ...v } : null; };
const list = plate => db.prepare("SELECT * FROM records WHERE plate=? ORDER BY date, odo, id").all(plate);

// ---------- Nhac bao duong dinh ky ----------
const SERVICE_KM = Number(process.env.SERVICE_KM) || 2000;
const SERVICE_MONTHS = Number(process.env.SERVICE_MONTHS) || 6;
const isService = t => { const x = String(t).normalize("NFC").toLowerCase(); return x.includes("định kỳ") || x.includes("nhớt"); };
function reminder(rows) { // rows da sap xep theo ngay, ODO
  const svc = rows.filter(r => isService(r.type)), base = (svc.length ? svc : rows).slice(-1)[0];
  const maxOdo = Math.max(...rows.map(r => r.odo));
  const [y, m, d] = base.date.split("-").map(Number);
  const due = new Date(Date.UTC(y, m - 1 + SERVICE_MONTHS, d));
  const dueDate = due.toISOString().slice(0, 10), dueOdo = base.odo + SERVICE_KM;
  const kmLeft = dueOdo - maxOdo, daysLeft = Math.ceil((due - Date.now()) / 864e5);
  const status = kmLeft <= 0 || daysLeft <= 0 ? "due" : (kmLeft <= SERVICE_KM * 0.15 || daysLeft <= 30 ? "soon" : "ok");
  const text = status === "due"
    ? `Đã quá hạn bảo dưỡng: hạn là ${dueOdo} km hoặc ngày ${dueDate} (ODO ghi nhận gần nhất ${maxOdo} km).`
    : `Còn khoảng ${kmLeft} km hoặc ${daysLeft} ngày nữa (hạn ${dueOdo} km / ${dueDate}).`;
  return { status, dueOdo, dueDate, kmLeft, daysLeft, text, base: { date: base.date, odo: base.odo, type: base.type } };
}

const app = express();
app.use(express.json({ limit: "6mb" }));
app.use("/uploads", express.static(UPLOADS));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (_q, res) =>
  res.json({ contract: process.env.CONTRACT_ADDRESS || "", chainId: 11155111, serviceKm: SERVICE_KM, serviceMonths: SERVICE_MONTHS }));

// ---------- Dang nhap ----------
let fails = { n: 0, t: 0 }; // 5 lan sai thi khoa 1 phut
app.post("/api/login", (req, res) => {
  const b = req.body || {};
  if (fails.n >= 5 && Date.now() - fails.t < 60000)
    return res.status(429).json({ error: "Sai quá nhiều lần, thử lại sau 1 phút" });
  if (!(same(String(b.username || "").trim().toLowerCase(), USER) && same(b.password || "", PASS))) {
    fails = { n: (Date.now() - fails.t < 60000 ? fails.n : 0) + 1, t: Date.now() };
    return res.status(401).json({ error: "Sai tên đăng nhập hoặc mật khẩu" });
  }
  fails = { n: 0, t: 0 };
  res.json({ token: sign({ exp: Date.now() + 8 * 3600 * 1000 }), user: me });
});
app.get("/api/me", auth, (_q, res) => res.json(me));

// ---------- Moc bao tri ----------
app.post("/api/records", auth, (req, res) => {
  const b = req.body || {};
  const r = {
    plate: norm(b.plate), date: String(b.date || ""), odo: Number.parseInt(b.odo, 10),
    type: String(b.type || "").trim(), description: String(b.description || "").trim(),
    cost: Number.parseInt(b.cost, 10) || 0, garage: GARAGE
  };
  if (!r.plate || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !Number.isInteger(r.odo) || r.odo < 0 || !r.type)
    return res.status(400).json({ error: "Thiếu hoặc sai: biển số, ngày, ODO, loại công việc" });
  const rows = list(r.plate);
  const before = rows.filter(x => x.date <= r.date).pop();
  if (before && r.odo < before.odo)
    return res.status(409).json({ error: `ODO (${r.odo}) nhỏ hơn mốc trước (${before.odo} km, ${before.date})` });
  const after = rows.find(x => x.date > r.date);
  if (after && r.odo > after.odo)
    return res.status(409).json({ error: `ODO (${r.odo}) lớn hơn mốc sau (${after.odo} km, ${after.date})` });
  r.image_hash = ""; r.image_file = "";
  if (b.image && b.image.data) {
    try { const im = saveImage(b.image.data); r.image_hash = im.hash; r.image_file = im.file; }
    catch (e) { return res.status(400).json({ error: e.message }); }
  }
  const last = rows[rows.length - 1];
  r.prev_hash = last ? last.hash : "0x0";
  r.hash = hashOf(r);
  const info = db.prepare(`INSERT INTO records(plate,date,odo,type,description,cost,garage,prev_hash,hash,image_hash,image_file)
    VALUES(@plate,@date,@odo,@type,@description,@cost,@garage,@prev_hash,@hash,@image_hash,@image_file)`).run(r);
  res.status(201).json({ id: Number(info.lastInsertRowid), hash: r.hash });
});

// Tra cuu cong khai + kiem tra toan ven
app.get("/api/vehicles/:plate", (req, res) => {
  const plate = norm(req.params.plate), rows = list(plate);
  if (!rows.length) return res.status(404).json({ error: "Không tìm thấy lịch sử cho biển số " + plate });
  let prev = "0x0", maxOdo = -1, issues = 0;
  const records = rows.map(r => {
    const checks = { hash: hashOf(r) === r.hash, chain: r.prev_hash === prev, odo: r.odo >= maxOdo };
    if (r.image_hash) checks.image = imageOk(r);
    if (!Object.values(checks).every(Boolean)) issues++;
    prev = r.hash; maxOdo = Math.max(maxOdo, r.odo);
    return { ...r, checks };
  });
  res.json({ plate, total: rows.length, maxOdo, issues, records, reminder: reminder(rows), vehicle: vehicleOf(plate) });
});

// Thong tin xe (metadata, khong nam trong ma bam)
app.get("/api/vehicles/:plate/info", (req, res) => res.json(vehicleOf(norm(req.params.plate)) || {}));
app.put("/api/vehicles/:plate/info", auth, (req, res) => {
  const plate = norm(req.params.plate), b = req.body || {};
  if (!plate) return res.status(400).json({ error: "Thiếu biển số" });
  const t = (k, n = 60) => String(b[k] || "").trim().slice(0, n);
  const year = t("year", 4);
  if (year && !(/^\d{4}$/.test(year) && +year >= 1950 && +year <= 2100)) return res.status(400).json({ error: "Năm sản xuất không hợp lệ" });
  db.prepare(`INSERT INTO vehicles(plate,brand,model,year,color,vin,engine) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(plate) DO UPDATE SET brand=excluded.brand,model=excluded.model,year=excluded.year,color=excluded.color,vin=excluded.vin,engine=excluded.engine`)
    .run(plate, t("brand"), t("model"), year, t("color"), t("vin", 30).toUpperCase(), t("engine", 30).toUpperCase());
  res.json({ ok: true });
});

app.patch("/api/records/:id/tx", auth, (req, res) => {
  const tx = String((req.body || {}).tx || "");
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) return res.status(400).json({ error: "tx hash không hợp lệ" });
  const info = db.prepare("UPDATE records SET tx_hash=? WHERE id=?").run(tx, req.params.id);
  info.changes ? res.json({ ok: true }) : res.status(404).json({ error: "Không thấy bản ghi" });
});

// ---------- Thong ke (can dang nhap) ----------
app.get("/api/stats", auth, (_q, res) => {
  const all = db.prepare("SELECT * FROM records ORDER BY plate, date, odo, id").all();
  const by = {};
  all.forEach(r => (by[r.plate] = by[r.plate] || []).push(r));
  let issueVehicles = 0; const alerts = [];
  for (const [plate, rows] of Object.entries(by)) {
    let prev = "0x0", maxOdo = -1, bad = false;
    for (const r of rows) {
      if (hashOf(r) !== r.hash || r.prev_hash !== prev || r.odo < maxOdo || !imageOk(r)) bad = true;
      prev = r.hash; maxOdo = Math.max(maxOdo, r.odo);
    }
    if (bad) issueVehicles++;
    const rm = reminder(rows);
    if (rm.status !== "ok") alerts.push({ plate, status: rm.status, text: rm.text });
  }
  alerts.sort((a, b) => (a.status === "due" ? 0 : 1) - (b.status === "due" ? 0 : 1));
  res.json({
    vehicles: Object.keys(by).length, records: all.length,
    totalCost: all.reduce((t, r) => t + r.cost, 0), anchored: all.filter(r => r.tx_hash).length,
    issueVehicles, alerts,
    byType: db.prepare("SELECT type, COUNT(*) c FROM records GROUP BY type ORDER BY c DESC").all().map(x => ({ ...x })),
    byMonth: db.prepare("SELECT substr(date,1,7) m, COUNT(*) c, SUM(cost) s FROM records GROUP BY m ORDER BY m DESC LIMIT 12").all().map(x => ({ ...x })).reverse()
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Moto Maintenance Chain: http://localhost:" + port));
