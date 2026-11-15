require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync(path.join(__dirname, "moto.db"));
db.exec(`CREATE TABLE IF NOT EXISTS records(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plate TEXT NOT NULL, date TEXT NOT NULL, odo INTEGER NOT NULL,
  type TEXT NOT NULL, description TEXT DEFAULT '', cost INTEGER DEFAULT 0,
  garage TEXT DEFAULT '', prev_hash TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
  tx_hash TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
db.exec("CREATE INDEX IF NOT EXISTS idx_plate ON records(plate)");

const norm = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
// Cong thuc bam duy nhat cho ca he thong
const hashOf = r => "0x" + crypto.createHash("sha256").update(
  JSON.stringify([r.plate, r.date, r.odo, r.type, r.description, r.cost, r.garage, r.prev_hash])
).digest("hex");
const list = plate => db.prepare("SELECT * FROM records WHERE plate=? ORDER BY date, odo, id").all(plate);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (_q, res) =>
  res.json({ contract: process.env.CONTRACT_ADDRESS || "", chainId: 11155111 }));

// Them moc bao tri
app.post("/api/records", (req, res) => {
  const b = req.body || {};
  const r = {
    plate: norm(b.plate), date: String(b.date || ""), odo: Number.parseInt(b.odo, 10),
    type: String(b.type || "").trim(), description: String(b.description || "").trim(),
    cost: Number.parseInt(b.cost, 10) || 0, garage: String(b.garage || "").trim()
  };
  if (!r.plate || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !Number.isInteger(r.odo) || r.odo < 0 || !r.type)
    return res.status(400).json({ error: "Thieu hoac sai: bien so, ngay, ODO, loai cong viec" });
  const rows = list(r.plate);
  // Chong gian lan ODO: ODO moi khong duoc nho hon moc truoc (theo ngay)
  const before = rows.filter(x => x.date <= r.date).pop();
  if (before && r.odo < before.odo)
    return res.status(409).json({ error: `ODO (${r.odo}) nho hon moc truoc (${before.odo} km, ${before.date})` });
  const after = rows.find(x => x.date > r.date);
  if (after && r.odo > after.odo)
    return res.status(409).json({ error: `ODO (${r.odo}) lon hon moc sau (${after.odo} km, ${after.date})` });
  const last = rows[rows.length - 1];
  r.prev_hash = last ? last.hash : "0x0";
  r.hash = hashOf(r);
  const info = db.prepare(`INSERT INTO records(plate,date,odo,type,description,cost,garage,prev_hash,hash)
    VALUES(@plate,@date,@odo,@type,@description,@cost,@garage,@prev_hash,@hash)`).run(r);
  res.status(201).json({ id: Number(info.lastInsertRowid), hash: r.hash });
});

// Tra cuu + kiem tra toan ven
app.get("/api/vehicles/:plate", (req, res) => {
  const plate = norm(req.params.plate), rows = list(plate);
  if (!rows.length) return res.status(404).json({ error: "Khong tim thay lich su cho bien so " + plate });
  let prev = "0x0", maxOdo = -1, issues = 0;
  const records = rows.map(r => {
    const checks = { hash: hashOf(r) === r.hash, chain: r.prev_hash === prev, odo: r.odo >= maxOdo };
    if (!checks.hash || !checks.chain || !checks.odo) issues++;
    prev = r.hash; maxOdo = Math.max(maxOdo, r.odo);
    return { ...r, checks };
  });
  res.json({ plate, total: rows.length, maxOdo, issues, records });
});

// Luu ma giao dich sau khi neo len Sepolia
app.patch("/api/records/:id/tx", (req, res) => {
  const tx = String((req.body || {}).tx || "");
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) return res.status(400).json({ error: "tx hash khong hop le" });
  const info = db.prepare("UPDATE records SET tx_hash=? WHERE id=?").run(tx, req.params.id);
  info.changes ? res.json({ ok: true }) : res.status(404).json({ error: "Khong thay ban ghi" });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Moto Maintenance Chain: http://localhost:" + port));