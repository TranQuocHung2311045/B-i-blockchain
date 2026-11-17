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
db.exec(`
CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, full_name TEXT NOT NULL,
  phone TEXT DEFAULT '', salt TEXT NOT NULL, pass_hash TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS vehicle_owner(plate TEXT PRIMARY KEY, customer_id INTEGER NOT NULL, linked_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS claims(plate TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS vehicle_prefs(plate TEXT PRIMARY KEY, service_km INTEGER, service_months INTEGER);
CREATE TABLE IF NOT EXISTS cust_reminders(id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, plate TEXT NOT NULL,
  title TEXT NOT NULL, due_date TEXT DEFAULT '', due_odo INTEGER, note TEXT DEFAULT '', done INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);

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
const me = { username: USER, garage_name: GARAGE, role: "garage" };
const bearer = req => (req.headers.authorization || "").replace(/^Bearer /, "");
const auth = (req, res, next) => {
  const p = verify(bearer(req));
  return p && p.r === "garage" ? next() : res.status(401).json({ error: "Bạn cần đăng nhập bằng tài khoản garage" });
};
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString("hex");
const custUser = c => ({ id: c.id, email: c.email, full_name: c.full_name, phone: c.phone, role: "customer" });
const authC = (req, res, next) => {
  const p = verify(bearer(req));
  const c = p && p.r === "customer" && db.prepare("SELECT id,email,full_name,phone FROM customers WHERE id=?").get(p.id);
  if (!c) return res.status(401).json({ error: "Bạn cần đăng nhập bằng tài khoản khách hàng" });
  req.cust = { ...c };
  next();
};

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
function reminder(rows, km = SERVICE_KM, months = SERVICE_MONTHS) { // rows da sap xep theo ngay, ODO
  const svc = rows.filter(r => isService(r.type)), base = (svc.length ? svc : rows).slice(-1)[0];
  const maxOdo = Math.max(...rows.map(r => r.odo));
  const [y, m, d] = base.date.split("-").map(Number);
  const due = new Date(Date.UTC(y, m - 1 + months, d));
  const dueDate = due.toISOString().slice(0, 10), dueOdo = base.odo + km;
  const kmLeft = dueOdo - maxOdo, daysLeft = Math.ceil((due - Date.now()) / 864e5);
  const status = kmLeft <= 0 || daysLeft <= 0 ? "due" : (kmLeft <= km * 0.15 || daysLeft <= 30 ? "soon" : "ok");
  const text = status === "due"
    ? `Đã quá hạn bảo dưỡng: hạn là ${dueOdo} km hoặc ngày ${dueDate} (ODO ghi nhận gần nhất ${maxOdo} km).`
    : `Còn khoảng ${kmLeft} km hoặc ${daysLeft} ngày nữa (hạn ${dueOdo} km / ${dueDate}).`;
  return { status, dueOdo, dueDate, kmLeft, daysLeft, text, km, months, base: { date: base.date, odo: base.odo, type: base.type } };
}

const remFor = (plate, rows) => {
  const pf = db.prepare("SELECT service_km, service_months FROM vehicle_prefs WHERE plate=?").get(plate);
  return reminder(rows, (pf && pf.service_km) || SERVICE_KM, (pf && pf.service_months) || SERVICE_MONTHS);
};
function custRem(r, maxOdo) { // nhac tuy chinh cua khach
  if (r.done) return { status: "done", text: "Đã hoàn thành" };
  const today = new Date().toISOString().slice(0, 10); let st = "ok"; const parts = [];
  if (r.due_date) {
    const days = Math.ceil((Date.parse(r.due_date) - Date.parse(today)) / 864e5);
    if (days < 0) { st = "due"; parts.push(`quá hạn ${-days} ngày`); }
    else { if (days <= 30) st = "soon"; parts.push(`còn ${days} ngày (hạn ${r.due_date})`); }
  }
  if (r.due_odo != null) {
    const left = r.due_odo - maxOdo;
    if (left <= 0) { st = "due"; parts.push(`ODO đã đạt mốc ${r.due_odo} km`); }
    else { if (left <= 300 && st !== "due") st = "soon"; parts.push(`còn ${left} km (mốc ${r.due_odo} km)`); }
  }
  return { status: st, text: parts.join(" · ") || "Không đặt hạn" };
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
  res.json({ token: sign({ r: "garage", exp: Date.now() + 8 * 3600 * 1000 }), user: me });
});
app.get("/api/me", auth, (_q, res) => res.json(me));
// Ai dang dang nhap (garage hoac khach hang)
app.get("/api/whoami", (req, res) => {
  const p = verify(bearer(req));
  if (p && p.r === "garage") return res.json(me);
  const c = p && p.r === "customer" && db.prepare("SELECT id,email,full_name,phone FROM customers WHERE id=?").get(p.id);
  return c ? res.json(custUser(c)) : res.status(401).json({ error: "Chưa đăng nhập" });
});

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
function detail(plate) {
  const rows = list(plate);
  if (!rows.length) return null;
  let prev = "0x0", maxOdo = -1, issues = 0;
  const records = rows.map(r => {
    const checks = { hash: hashOf(r) === r.hash, chain: r.prev_hash === prev, odo: r.odo >= maxOdo };
    if (r.image_hash) checks.image = imageOk(r);
    if (!Object.values(checks).every(Boolean)) issues++;
    prev = r.hash; maxOdo = Math.max(maxOdo, r.odo);
    return { ...r, checks };
  });
  return { plate, total: rows.length, maxOdo, issues, records, reminder: remFor(plate, rows), vehicle: vehicleOf(plate) };
}
app.get("/api/vehicles/:plate", (req, res) => {
  const d = detail(norm(req.params.plate));
  d ? res.json(d) : res.status(404).json({ error: "Không tìm thấy lịch sử cho biển số " + norm(req.params.plate) });
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

// ---------- Khach hang ----------
const authFails = new Map();
const throttled = (key, max, ms) => { const f = authFails.get(key); return f && f.n >= max && Date.now() - f.t < ms; };
const fail = key => { const f = authFails.get(key); authFails.set(key, { n: (f && Date.now() - f.t < 600000 ? f.n : 0) + 1, t: Date.now() }); };

app.post("/api/customers/register", (req, res) => {
  const b = req.body || {}, email = String(b.email || "").trim().toLowerCase(), name = String(b.full_name || "").trim().slice(0, 80);
  const phone = String(b.phone || "").trim().slice(0, 20), pw = String(b.password || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: "Email không hợp lệ" });
  if (name.length < 2) return res.status(400).json({ error: "Vui lòng nhập họ tên" });
  if (phone && !/^[0-9+() .-]{8,20}$/.test(phone)) return res.status(400).json({ error: "Số điện thoại không hợp lệ" });
  if (pw.length < 8) return res.status(400).json({ error: "Mật khẩu tối thiểu 8 ký tự" });
  if (db.prepare("SELECT 1 FROM customers WHERE email=?").get(email)) return res.status(409).json({ error: "Email này đã được đăng ký" });
  const salt = crypto.randomBytes(16).toString("hex");
  const info = db.prepare("INSERT INTO customers(email,full_name,phone,salt,pass_hash) VALUES(?,?,?,?,?)").run(email, name, phone, salt, hashPw(pw, salt));
  const c = { id: Number(info.lastInsertRowid), email, full_name: name, phone };
  res.status(201).json({ token: sign({ r: "customer", id: c.id, exp: Date.now() + 8 * 3600 * 1000 }), user: custUser(c) });
});
app.post("/api/customers/login", (req, res) => {
  const email = String((req.body || {}).email || "").trim().toLowerCase(), pw = String((req.body || {}).password || "");
  if (throttled("l:" + email, 5, 60000)) return res.status(429).json({ error: "Sai quá nhiều lần, thử lại sau 1 phút" });
  const c = db.prepare("SELECT * FROM customers WHERE email=?").get(email);
  if (!c || !crypto.timingSafeEqual(Buffer.from(hashPw(pw, c.salt)), Buffer.from(c.pass_hash))) { fail("l:" + email); return res.status(401).json({ error: "Sai email hoặc mật khẩu" }); }
  authFails.delete("l:" + email);
  res.json({ token: sign({ r: "customer", id: c.id, exp: Date.now() + 8 * 3600 * 1000 }), user: custUser(c) });
});
app.get("/api/customers/me", authC, (req, res) => res.json(custUser(req.cust)));
app.put("/api/customers/me", authC, (req, res) => {
  const name = String((req.body || {}).full_name || "").trim().slice(0, 80), phone = String((req.body || {}).phone || "").trim().slice(0, 20);
  if (name.length < 2) return res.status(400).json({ error: "Vui lòng nhập họ tên" });
  if (phone && !/^[0-9+() .-]{8,20}$/.test(phone)) return res.status(400).json({ error: "Số điện thoại không hợp lệ" });
  db.prepare("UPDATE customers SET full_name=?, phone=? WHERE id=?").run(name, phone, req.cust.id);
  res.json(custUser({ ...req.cust, full_name: name, phone }));
});
app.post("/api/customers/password", authC, (req, res) => {
  const o = String((req.body || {}).old_password || ""), n = String((req.body || {}).new_password || "");
  const c = db.prepare("SELECT * FROM customers WHERE id=?").get(req.cust.id);
  if (!crypto.timingSafeEqual(Buffer.from(hashPw(o, c.salt)), Buffer.from(c.pass_hash))) return res.status(400).json({ error: "Mật khẩu hiện tại không đúng" });
  if (n.length < 8) return res.status(400).json({ error: "Mật khẩu mới tối thiểu 8 ký tự" });
  const salt = crypto.randomBytes(16).toString("hex");
  db.prepare("UPDATE customers SET salt=?, pass_hash=? WHERE id=?").run(salt, hashPw(n, salt), req.cust.id);
  res.json({ ok: true });
});

// Garage cap ma lien ket de khach nhan xe (dung 1 lan, 30 ngay)
app.post("/api/vehicles/:plate/claim-code", auth, (req, res) => {
  const plate = norm(req.params.plate);
  if (!plate || (!list(plate).length && !vehicleOf(plate))) return res.status(404).json({ error: "Chưa có dữ liệu cho biển số này. Hãy ghi một mốc bảo trì hoặc lưu thông tin xe trước." });
  const ALPH = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; let code = "";
  for (const x of crypto.randomBytes(8)) code += ALPH[x % ALPH.length];
  const expires = new Date(Date.now() + 30 * 864e5).toISOString();
  db.prepare("INSERT INTO claims(plate,code_hash,expires) VALUES(?,?,?) ON CONFLICT(plate) DO UPDATE SET code_hash=excluded.code_hash,expires=excluded.expires")
    .run(plate, sha256hex(code), expires);
  res.json({ code: code.slice(0, 4) + "-" + code.slice(4), expires: expires.slice(0, 10) });
});

const owns = (cid, plate) => !!db.prepare("SELECT 1 FROM vehicle_owner WHERE plate=? AND customer_id=?").get(plate, cid);
const mustOwn = (req, res, next) => { req.plate = norm(req.params.plate); return owns(req.cust.id, req.plate) ? next() : res.status(403).json({ error: "Xe này chưa được liên kết với tài khoản của bạn" }); };
const carSummary = plate => {
  const d = detail(plate), l = d && d.records[d.records.length - 1];
  return { plate, vehicle: vehicleOf(plate), total: d ? d.total : 0, maxOdo: d ? d.maxOdo : 0, issues: d ? d.issues : 0,
    last: l ? { date: l.date, odo: l.odo, type: l.type } : null, reminder: d ? d.reminder : null };
};

app.post("/api/customers/vehicles/claim", authC, (req, res) => {
  const key = "c:" + req.cust.id;
  if (throttled(key, 5, 600000)) return res.status(429).json({ error: "Nhập sai quá nhiều lần, thử lại sau 10 phút" });
  const plate = norm((req.body || {}).plate), code = String((req.body || {}).code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const c = db.prepare("SELECT * FROM claims WHERE plate=?").get(plate);
  if (!c || c.expires < new Date().toISOString() || !crypto.timingSafeEqual(Buffer.from(sha256hex(code)), Buffer.from(c.code_hash))) {
    fail(key); return res.status(400).json({ error: "Biển số hoặc mã liên kết không đúng hoặc đã hết hạn" });
  }
  db.prepare("INSERT INTO vehicle_owner(plate,customer_id) VALUES(?,?) ON CONFLICT(plate) DO UPDATE SET customer_id=excluded.customer_id, linked_at=CURRENT_TIMESTAMP").run(plate, req.cust.id);
  db.prepare("DELETE FROM claims WHERE plate=?").run(plate);
  authFails.delete(key);
  res.json(carSummary(plate));
});
app.get("/api/customers/vehicles", authC, (req, res) =>
  res.json(db.prepare("SELECT plate FROM vehicle_owner WHERE customer_id=? ORDER BY linked_at DESC").all(req.cust.id).map(x => carSummary(x.plate))));

app.get("/api/customers/vehicles/:plate", authC, mustOwn, (req, res) => {
  const d = detail(req.plate);
  if (!d) return res.status(404).json({ error: "Xe chưa có lịch sử bảo trì" });
  const rems = db.prepare("SELECT * FROM cust_reminders WHERE customer_id=? AND plate=? ORDER BY done, id DESC").all(req.cust.id, req.plate)
    .map(r => ({ id: r.id, title: r.title, due_date: r.due_date, due_odo: r.due_odo, note: r.note, done: !!r.done, ...custRem(r, d.maxOdo) }));
  res.json({ ...d, customReminders: rems });
});
app.delete("/api/customers/vehicles/:plate", authC, mustOwn, (req, res) => {
  db.prepare("DELETE FROM vehicle_owner WHERE plate=?").run(req.plate);
  db.prepare("DELETE FROM cust_reminders WHERE customer_id=? AND plate=?").run(req.cust.id, req.plate);
  res.json({ ok: true });
});
app.put("/api/customers/vehicles/:plate/prefs", authC, mustOwn, (req, res) => {
  const km = Number.parseInt((req.body || {}).service_km, 10), mo = Number.parseInt((req.body || {}).service_months, 10);
  if (!(km >= 500 && km <= 20000) || !(mo >= 1 && mo <= 24)) return res.status(400).json({ error: "Chu kỳ hợp lệ: 500-20000 km và 1-24 tháng" });
  db.prepare("INSERT INTO vehicle_prefs(plate,service_km,service_months) VALUES(?,?,?) ON CONFLICT(plate) DO UPDATE SET service_km=excluded.service_km, service_months=excluded.service_months").run(req.plate, km, mo);
  res.json({ ok: true });
});
app.post("/api/customers/vehicles/:plate/reminders", authC, mustOwn, (req, res) => {
  const b = req.body || {}, title = String(b.title || "").trim().slice(0, 100), note = String(b.note || "").trim().slice(0, 300);
  const dd = String(b.due_date || "").trim(), od = b.due_odo === "" || b.due_odo == null ? null : Number.parseInt(b.due_odo, 10);
  if (!title) return res.status(400).json({ error: "Vui lòng nhập nội dung nhắc" });
  if (dd && !/^\d{4}-\d{2}-\d{2}$/.test(dd)) return res.status(400).json({ error: "Ngày không hợp lệ" });
  if (od !== null && !(od >= 0)) return res.status(400).json({ error: "ODO không hợp lệ" });
  if (!dd && od === null) return res.status(400).json({ error: "Hãy đặt hạn theo ngày hoặc theo ODO" });
  if (db.prepare("SELECT COUNT(*) c FROM cust_reminders WHERE customer_id=? AND plate=?").get(req.cust.id, req.plate).c >= 30) return res.status(400).json({ error: "Tối đa 30 lịch nhắc cho mỗi xe" });
  const info = db.prepare("INSERT INTO cust_reminders(customer_id,plate,title,due_date,due_odo,note) VALUES(?,?,?,?,?,?)").run(req.cust.id, req.plate, title, dd, od, note);
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});
app.patch("/api/customers/vehicles/:plate/reminders/:id", authC, mustOwn, (req, res) => {
  const i = db.prepare("UPDATE cust_reminders SET done=? WHERE id=? AND customer_id=? AND plate=?").run((req.body || {}).done ? 1 : 0, req.params.id, req.cust.id, req.plate);
  i.changes ? res.json({ ok: true }) : res.status(404).json({ error: "Không thấy lịch nhắc" });
});
app.delete("/api/customers/vehicles/:plate/reminders/:id", authC, mustOwn, (req, res) => {
  const i = db.prepare("DELETE FROM cust_reminders WHERE id=? AND customer_id=? AND plate=?").run(req.params.id, req.cust.id, req.plate);
  i.changes ? res.json({ ok: true }) : res.status(404).json({ error: "Không thấy lịch nhắc" });
});
// Tong hop lich nhac sap toi cua tat ca xe
app.get("/api/customers/reminders", authC, (req, res) => {
  const out = [], rank = { due: 0, soon: 1, ok: 2 };
  for (const { plate } of db.prepare("SELECT plate FROM vehicle_owner WHERE customer_id=?").all(req.cust.id)) {
    const d = detail(plate), maxOdo = d ? d.maxOdo : 0;
    if (d) out.push({ plate, kind: "auto", title: "Bảo dưỡng định kỳ", status: d.reminder.status, text: d.reminder.text });
    for (const r of db.prepare("SELECT * FROM cust_reminders WHERE customer_id=? AND plate=? AND done=0").all(req.cust.id, plate)) {
      const c = custRem(r, maxOdo); out.push({ plate, kind: "custom", title: r.title, status: c.status, text: c.text });
    }
  }
  res.json(out.sort((a, b) => rank[a.status] - rank[b.status]));
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
    const rm = remFor(plate, rows);
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
