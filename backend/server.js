require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, "moto.db"));
db.exec(`CREATE TABLE IF NOT EXISTS records(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plate TEXT NOT NULL, date TEXT NOT NULL, odo INTEGER NOT NULL,
  type TEXT NOT NULL, description TEXT DEFAULT '', cost INTEGER DEFAULT 0,
  garage TEXT DEFAULT '', prev_hash TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
  tx_hash TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
db.exec("CREATE INDEX IF NOT EXISTS idx_plate ON records(plate)");

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
const hashOf = r => "0x" + crypto.createHash("sha256").update(
  JSON.stringify([r.plate, r.date, r.odo, r.type, r.description, r.cost, r.garage, r.prev_hash])
).digest("hex");
const list = plate => db.prepare("SELECT * FROM records WHERE plate=? ORDER BY date, odo, id").all(plate);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (_q, res) =>
  res.json({ contract: process.env.CONTRACT_ADDRESS || "", chainId: 11155111 }));

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
  const last = rows[rows.length - 1];
  r.prev_hash = last ? last.hash : "0x0";
  r.hash = hashOf(r);
  const info = db.prepare(`INSERT INTO records(plate,date,odo,type,description,cost,garage,prev_hash,hash)
    VALUES(@plate,@date,@odo,@type,@description,@cost,@garage,@prev_hash,@hash)`).run(r);
  res.status(201).json({ id: Number(info.lastInsertRowid), hash: r.hash });
});

// Tra cuu cong khai + kiem tra toan ven
app.get("/api/vehicles/:plate", (req, res) => {
  const plate = norm(req.params.plate), rows = list(plate);
  if (!rows.length) return res.status(404).json({ error: "Không tìm thấy lịch sử cho biển số " + plate });
  let prev = "0x0", maxOdo = -1, issues = 0;
  const records = rows.map(r => {
    const checks = { hash: hashOf(r) === r.hash, chain: r.prev_hash === prev, odo: r.odo >= maxOdo };
    if (!checks.hash || !checks.chain || !checks.odo) issues++;
    prev = r.hash; maxOdo = Math.max(maxOdo, r.odo);
    return { ...r, checks };
  });
  res.json({ plate, total: rows.length, maxOdo, issues, records });
});

app.patch("/api/records/:id/tx", auth, (req, res) => {
  const tx = String((req.body || {}).tx || "");
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) return res.status(400).json({ error: "tx hash không hợp lệ" });
  const info = db.prepare("UPDATE records SET tx_hash=? WHERE id=?").run(tx, req.params.id);
  info.changes ? res.json({ ok: true }) : res.status(404).json({ error: "Không thấy bản ghi" });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Moto Maintenance Chain: http://localhost:" + port));
