const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) console.warn("WARNING: JWT_SECRET is not set.");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function makeReferralCode() {
  return crypto.randomBytes(5).toString("hex").toUpperCase();
}

function signToken(user) {
  return jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "7d" });
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ ok:false, error:"Login required" });
  try {
    req.auth = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ ok:false, error:"Session expired. Please log in again." });
  }
}

app.get("/api/health", async (req,res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ok:true, service:"TaskMint", database:"connected"});
  } catch {
    res.status(500).json({ok:false, database:"error"});
  }
});

app.post("/api/register", async (req,res) => {
  const { email, password, displayName, referralCode } = req.body || {};
  if (!email || !password || !displayName)
    return res.status(400).json({ok:false,error:"Name, email and password are required."});
  const cleanEmail = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail))
    return res.status(400).json({ok:false,error:"Enter a valid email address."});
  if (String(password).length < 8)
    return res.status(400).json({ok:false,error:"Password must be at least 8 characters."});
  if (String(displayName).trim().length < 2)
    return res.status(400).json({ok:false,error:"Name must be at least 2 characters."});

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const exists = await client.query("SELECT id FROM tm_users WHERE email=$1", [cleanEmail]);
    if (exists.rows.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({ok:false,error:"An account with this email already exists."});
    }

    let referredBy = null;
    if (referralCode) {
      const ref = await client.query("SELECT id FROM tm_users WHERE referral_code=$1 LIMIT 1", [String(referralCode).trim().toUpperCase()]);
      if (ref.rows.length) referredBy = ref.rows[0].id;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    let code;
    for (let i=0;i<5;i++) {
      code = makeReferralCode();
      const check = await client.query("SELECT 1 FROM tm_users WHERE referral_code=$1", [code]);
      if (!check.rows.length) break;
    }

    const result = await client.query(
      `INSERT INTO tm_users(email,password_hash,display_name,referral_code,referred_by)
       VALUES($1,$2,$3,$4,$5)
       RETURNING id,email,display_name,balance,total_earned,referral_code,created_at`,
      [cleanEmail,passwordHash,String(displayName).trim(),code,referredBy]
    );

    await client.query("COMMIT");
    const user = result.rows[0];
    res.status(201).json({ok:true, token:signToken(user), user});
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Register error:", e);
    res.status(500).json({ok:false,error:"Could not create account."});
  } finally { client.release(); }
});

app.post("/api/login", async (req,res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ok:false,error:"Email and password are required."});
  try {
    const r = await pool.query(
      "SELECT id,email,password_hash,display_name,balance,total_earned,referral_code,status,created_at FROM tm_users WHERE email=$1 LIMIT 1",
      [String(email).trim().toLowerCase()]
    );
    if (!r.rows.length) return res.status(401).json({ok:false,error:"Invalid email or password."});
    const user = r.rows[0];
    if (user.status !== "active") return res.status(403).json({ok:false,error:"This account is not active."});
    const ok = await bcrypt.compare(String(password), user.password_hash);
    if (!ok) return res.status(401).json({ok:false,error:"Invalid email or password."});
    delete user.password_hash;
    res.json({ok:true,token:signToken(user),user});
  } catch(e) {
    console.error("Login error:",e);
    res.status(500).json({ok:false,error:"Login failed."});
  }
});

app.get("/api/me", auth, async (req,res) => {
  try {
    const r = await pool.query(
      "SELECT id,email,display_name,balance,total_earned,referral_code,created_at FROM tm_users WHERE id=$1",
      [req.auth.userId]
    );
    if (!r.rows.length) return res.status(404).json({ok:false,error:"User not found"});
    res.json({ok:true,user:r.rows[0]});
  } catch(e) {
    res.status(500).json({ok:false,error:"Could not load account."});
  }
});

app.get("/api/activity", auth, async (req,res) => {
  try {
    const r = await pool.query(
      "SELECT id,type,amount,description,created_at FROM tm_transactions WHERE user_id=$1 ORDER BY id DESC LIMIT 30",
      [req.auth.userId]
    );
    res.json({ok:true,items:r.rows});
  } catch(e) {
    res.status(500).json({ok:false,error:"Could not load activity."});
  }
});

app.post("/api/withdrawals", auth, async (req,res) => {
  const { amount, method, accountNumber, accountName } = req.body || {};
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 50) return res.status(400).json({ok:false,error:"Minimum withdrawal is 50 points."});
  if (!["bkash","nagad"].includes(String(method).toLowerCase())) return res.status(400).json({ok:false,error:"Select bKash or Nagad."});
  if (!/^[0-9]{11}$/.test(String(accountNumber || ""))) return res.status(400).json({ok:false,error:"Enter a valid 11-digit account number."});

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const u = await client.query("SELECT id,balance FROM tm_users WHERE id=$1 FOR UPDATE",[req.auth.userId]);
    if (!u.rows.length) throw new Error("User not found");
    if (Number(u.rows[0].balance) < value) {
      await client.query("ROLLBACK");
      return res.status(400).json({ok:false,error:"Insufficient balance."});
    }
    await client.query(
      `INSERT INTO tm_withdrawals(user_id,amount,method,account_number,account_name)
       VALUES($1,$2,$3,$4,$5)`,
      [req.auth.userId,value,String(method).toLowerCase(),String(accountNumber),String(accountName || "").trim()]
    );
    await client.query("UPDATE tm_users SET balance=balance-$1 WHERE id=$2",[value,req.auth.userId]);
    await client.query(
      `INSERT INTO tm_transactions(user_id,type,amount,description)
       VALUES($1,'withdrawal',-$2,$3)`,
      [req.auth.userId,value,`Withdrawal request via ${String(method).toLowerCase()}`]
    );
    await client.query("COMMIT");
    res.json({ok:true,message:"Withdrawal request submitted."});
  } catch(e) {
    await client.query("ROLLBACK");
    console.error("Withdrawal error:",e);
    res.status(500).json({ok:false,error:"Could not submit withdrawal."});
  } finally { client.release(); }
});

app.get("*",(req,res) => res.sendFile(path.join(__dirname,"public","index.html")));

async function init() {
  const schema = fs.readFileSync(
    path.join(__dirname, "schema.sql"),
    "utf8"
  );

  await pool.query(schema);

  app.listen(PORT, () => {
    console.log(`TaskMint running on port ${PORT}`);
  });
}
