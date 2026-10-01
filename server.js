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
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const AD_REWARD = 0.50;
const DAILY_BONUS = 1.00;
const REFERRAL_REWARD = 5.00;
const MIN_WITHDRAW = 50.00;

const DAILY_AD_LIMIT = 30;

if (!JWT_SECRET) {
  console.warn("WARNING: JWT_SECRET is not set.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));


/* =========================================================
   HELPERS
========================================================= */

function makeReferralCode() {
  return crypto.randomBytes(5).toString("hex").toUpperCase();
}

function signToken(user) {
  return jwt.sign(
    { userId: user.id },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function signAdminToken() {
  return jwt.sign(
    {
      admin: true,
      email: ADMIN_EMAIL
    },
    JWT_SECRET,
    { expiresIn: "12h" }
  );
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";

  const token = header.startsWith("Bearer ")
    ? header.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({
      ok: false,
      error: "Login required"
    });
  }

  try {
    req.auth = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({
      ok: false,
      error: "Session expired. Please log in again."
    });
  }
}

function adminAuth(req, res, next) {
  const header = req.headers.authorization || "";

  const token = header.startsWith("Bearer ")
    ? header.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({
      ok: false,
      error: "Admin login required."
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    if (!decoded.admin) {
      return res.status(403).json({
        ok: false,
        error: "Admin access denied."
      });
    }

    req.admin = decoded;
    next();

  } catch {
    return res.status(401).json({
      ok: false,
      error: "Admin session expired."
    });
  }
}


/* =========================================================
   HEALTH
========================================================= */

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      service: "TaskMint",
      database: "connected"
    });

  } catch (e) {
    console.error("Health error:", e);

    res.status(500).json({
      ok: false,
      database: "error"
    });
  }
});


/* =========================================================
   REGISTER
========================================================= */

app.post("/api/register", async (req, res) => {

  const {
    email,
    password,
    displayName,
    referralCode
  } = req.body || {};

  if (!email || !password || !displayName) {
    return res.status(400).json({
      ok: false,
      error: "Name, email and password are required."
    });
  }

  const cleanEmail = String(email).trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({
      ok: false,
      error: "Enter a valid email address."
    });
  }

  if (String(password).length < 8) {
    return res.status(400).json({
      ok: false,
      error: "Password must be at least 8 characters."
    });
  }

  if (String(displayName).trim().length < 2) {
    return res.status(400).json({
      ok: false,
      error: "Name must be at least 2 characters."
    });
  }

  const client = await pool.connect();

  try {

    await client.query("BEGIN");

    const exists = await client.query(
      "SELECT id FROM tm_users WHERE email=$1",
      [cleanEmail]
    );

    if (exists.rows.length) {

      await client.query("ROLLBACK");

      return res.status(409).json({
        ok: false,
        error: "An account with this email already exists."
      });
    }

    let referredBy = null;

    if (referralCode) {

      const ref = await client.query(
        `SELECT id
         FROM tm_users
         WHERE referral_code=$1
         LIMIT 1`,
        [String(referralCode).trim().toUpperCase()]
      );

      if (ref.rows.length) {
        referredBy = ref.rows[0].id;
      }
    }

    const passwordHash = await bcrypt.hash(
      String(password),
      12
    );

    let code;

    for (let i = 0; i < 10; i++) {

      code = makeReferralCode();

      const check = await client.query(
        "SELECT 1 FROM tm_users WHERE referral_code=$1",
        [code]
      );

      if (!check.rows.length) break;
    }

    const result = await client.query(
      `INSERT INTO tm_users
       (
         email,
         password_hash,
         display_name,
         referral_code,
         referred_by
       )
       VALUES($1,$2,$3,$4,$5)
       RETURNING
         id,
         email,
         display_name,
         balance,
         total_earned,
         referral_code,
         created_at`,
      [
        cleanEmail,
        passwordHash,
        String(displayName).trim(),
        code,
        referredBy
      ]
    );

    const newUser = result.rows[0];

    /* Referral reward */
    if (referredBy) {

      await client.query(
        `UPDATE tm_users
         SET
           balance=balance+$1,
           total_earned=total_earned+$1
         WHERE id=$2`,
        [
          REFERRAL_REWARD,
          referredBy
        ]
      );

      await client.query(
        `INSERT INTO tm_transactions
         (
           user_id,
           type,
           amount,
           description
         )
         VALUES($1,'referral',$2,$3)`,
        [
          referredBy,
          REFERRAL_REWARD,
          `Referral reward for ${String(displayName).trim()}`
        ]
      );
    }

    await client.query("COMMIT");

    res.status(201).json({
      ok: true,
      token: signToken(newUser),
      user: newUser
    });

  } catch (e) {

    await client.query("ROLLBACK");

    console.error("Register error:", e);

    res.status(500).json({
      ok: false,
      error: "Could not create account."
    });

  } finally {
    client.release();
  }
});


/* =========================================================
   LOGIN
========================================================= */

app.post("/api/login", async (req, res) => {

  const {
    email,
    password
  } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({
      ok: false,
      error: "Email and password are required."
    });
  }

  try {

    const r = await pool.query(
      `SELECT
         id,
         email,
         password_hash,
         display_name,
         balance,
         total_earned,
         referral_code,
         status,
         created_at
       FROM tm_users
       WHERE email=$1
       LIMIT 1`,
      [
        String(email).trim().toLowerCase()
      ]
    );

    if (!r.rows.length) {
      return res.status(401).json({
        ok: false,
        error: "Invalid email or password."
      });
    }

    const user = r.rows[0];

    if (user.status !== "active") {
      return res.status(403).json({
        ok: false,
        error: "This account is not active."
      });
    }

    const ok = await bcrypt.compare(
      String(password),
      user.password_hash
    );

    if (!ok) {
      return res.status(401).json({
        ok: false,
        error: "Invalid email or password."
      });
    }

    delete user.password_hash;

    res.json({
      ok: true,
      token: signToken(user),
      user
    });

  } catch (e) {

    console.error("Login error:", e);

    res.status(500).json({
      ok: false,
      error: "Login failed."
    });
  }
});


/* =========================================================
   CURRENT USER
========================================================= */

app.get("/api/me", auth, async (req, res) => {

  try {

    const r = await pool.query(
      `SELECT
         id,
         email,
         display_name,
         balance,
         total_earned,
         referral_code,
         created_at
       FROM tm_users
       WHERE id=$1`,
      [req.auth.userId]
    );

    if (!r.rows.length) {
      return res.status(404).json({
        ok: false,
        error: "User not found"
      });
    }

    res.json({
      ok: true,
      user: r.rows[0]
    });

  } catch (e) {

    console.error("Me error:", e);

    res.status(500).json({
      ok: false,
      error: "Could not load account."
    });
  }
});


/* =========================================================
   ACTIVITY
========================================================= */

app.get("/api/activity", auth, async (req, res) => {

  try {

    const r = await pool.query(
      `SELECT
         id,
         type,
         amount,
         description,
         created_at
       FROM tm_transactions
       WHERE user_id=$1
       ORDER BY id DESC
       LIMIT 30`,
      [req.auth.userId]
    );

    res.json({
      ok: true,
      items: r.rows
    });

  } catch (e) {

    console.error("Activity error:", e);

    res.status(500).json({
      ok: false,
      error: "Could not load activity."
    });
  }
});


/* =========================================================
   DAILY BONUS
========================================================= */

app.get("/api/daily-bonus/status", auth, async (req, res) => {

  try {

    const r = await pool.query(
      `SELECT EXISTS(
        SELECT 1
        FROM tm_transactions
        WHERE user_id=$1
          AND type='daily_bonus'
          AND created_at>=CURRENT_DATE
          AND created_at<CURRENT_DATE+INTERVAL '1 day'
      ) AS claimed`,
      [req.auth.userId]
    );

    res.json({
      ok: true,
      claimed: r.rows[0].claimed,
      reward: DAILY_BONUS
    });

  } catch (e) {

    console.error("Daily status error:", e);

    res.status(500).json({
      ok: false,
      error: "Could not check daily bonus."
    });
  }
});


app.post("/api/daily-bonus", auth, async (req, res) => {

  const client = await pool.connect();

  try {

    await client.query("BEGIN");

    const user = await client.query(
      `SELECT id,balance
       FROM tm_users
       WHERE id=$1
       FOR UPDATE`,
      [req.auth.userId]
    );

    if (!user.rows.length) {

      await client.query("ROLLBACK");

      return res.status(404).json({
        ok: false,
        error: "User not found."
      });
    }

    const already = await client.query(
      `SELECT id
       FROM tm_transactions
       WHERE user_id=$1
         AND type='daily_bonus'
         AND created_at>=CURRENT_DATE
         AND created_at<CURRENT_DATE+INTERVAL '1 day'
       LIMIT 1`,
      [req.auth.userId]
    );

    if (already.rows.length) {

      await client.query("ROLLBACK");

      return res.status(400).json({
        ok: false,
        error: "Daily bonus already claimed today."
      });
    }

    await client.query(
      `UPDATE tm_users
       SET
         balance=balance+$1,
         total_earned=total_earned+$1
       WHERE id=$2`,
      [
        DAILY_BONUS,
        req.auth.userId
      ]
    );

    await client.query(
      `INSERT INTO tm_transactions
       (
         user_id,
         type,
         amount,
         description
       )
       VALUES($1,'daily_bonus',$2,'Daily bonus')`,
      [
        req.auth.userId,
        DAILY_BONUS
      ]
    );

    const updated = await client.query(
      `SELECT balance,total_earned
       FROM tm_users
       WHERE id=$1`,
      [req.auth.userId]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      message: "Daily bonus claimed successfully.",
      reward: DAILY_BONUS,
      balance: updated.rows[0].balance,
      totalEarned: updated.rows[0].total_earned
    });

  } catch (e) {

    await client.query("ROLLBACK");

    console.error("Daily bonus error:", e);

    res.status(500).json({
      ok: false,
      error: "Could not claim daily bonus."
    });

  } finally {
    client.release();
  }
});


/* =========================================================
   ADS
========================================================= */

app.get("/api/ad-status", auth, async (req, res) => {

  try {

    const r = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM tm_transactions
       WHERE user_id=$1
         AND type='ad_reward'
         AND created_at>=CURRENT_DATE
         AND created_at<CURRENT_DATE+INTERVAL '1 day'`,
      [req.auth.userId]
    );

    const count = Number(
      r.rows[0].count || 0
    );

    res.json({
      ok: true,
      watched: count,
      limit: DAILY_AD_LIMIT,
      remaining: Math.max(
        0,
        DAILY_AD_LIMIT - count
      ),
      reward: AD_REWARD
    });

  } catch (e) {

    console.error("Ad status error:", e);

    res.status(500).json({
      ok: false,
      error: "Could not load ad status."
    });
  }
});


app.post("/api/ad-reward", auth, async (req, res) => {

  const provider = String(
    req.body?.provider || ""
  ).toLowerCase();

  if (!["monetag", "gigapub"].includes(provider)) {
    return res.status(400).json({
      ok: false,
      error: "Invalid ad provider."
    });
  }

  const client = await pool.connect();

  try {

    await client.query("BEGIN");

    const user = await client.query(
      `SELECT id,balance,total_earned
       FROM tm_users
       WHERE id=$1
       FOR UPDATE`,
      [req.auth.userId]
    );

    if (!user.rows.length) {

      await client.query("ROLLBACK");

      return res.status(404).json({
        ok: false,
        error: "User not found."
      });
    }

    const countResult = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM tm_transactions
       WHERE user_id=$1
         AND type='ad_reward'
         AND created_at>=CURRENT_DATE
         AND created_at<CURRENT_DATE+INTERVAL '1 day'`,
      [req.auth.userId]
    );

    const todayCount = Number(
      countResult.rows[0].count || 0
    );

    if (todayCount >= DAILY_AD_LIMIT) {

      await client.query("ROLLBACK");

      return res.status(400).json({
        ok: false,
        error:
          `Daily ad limit reached. Maximum ${DAILY_AD_LIMIT} ads per day.`
      });
    }

    await client.query(
      `UPDATE tm_users
       SET
         balance=balance+$1,
         total_earned=total_earned+$1
       WHERE id=$2`,
      [
        AD_REWARD,
        req.auth.userId
      ]
    );

    await client.query(
      `INSERT INTO tm_transactions
       (
         user_id,
         type,
         amount,
         description
       )
       VALUES($1,'ad_reward',$2,$3)`,
      [
        req.auth.userId,
        AD_REWARD,
        `${provider === "monetag"
          ? "Monetag"
          : "GigaPub"} ad reward`
      ]
    );

    const updated = await client.query(
      `SELECT balance,total_earned
       FROM tm_users
       WHERE id=$1`,
      [req.auth.userId]
    );

    await client.query("COMMIT");

    const newCount = todayCount + 1;

    res.json({
      ok: true,
      provider,
      reward: AD_REWARD,
      watched: newCount,
      limit: DAILY_AD_LIMIT,
      remaining: Math.max(
        0,
        DAILY_AD_LIMIT - newCount
      ),
      balance: updated.rows[0].balance,
      totalEarned: updated.rows[0].total_earned,
      message: `+$${AD_REWARD.toFixed(2)} added.`
    });

  } catch (e) {

    await client.query("ROLLBACK");

    console.error("Ad reward error:", e);

    res.status(500).json({
      ok: false,
      error: "Could not add ad reward."
    });

  } finally {
    client.release();
  }
});


/* =========================================================
   TASKS
========================================================= */

/*
  Public task list.
  Only active tasks are shown.
*/

app.get("/api/tasks", auth, async (req, res) => {

  try {

    const r = await pool.query(
      `SELECT
         id,
         title,
         description,
         reward,
         task_type,
         provider,
         provider_task_id,
         icon,
         daily_limit,
         created_at
       FROM tm_tasks
       WHERE active=true
       ORDER BY id DESC`
    );

    res.json({
      ok: true,
      tasks: r.rows
    });

  } catch (e) {

    console.error("Tasks error:", e);

    res.status(500).json({
      ok: false,
      error: "Could not load tasks."
    });
  }
});


/*
  Single task details
*/

app.get("/api/tasks/:id", auth, async (req, res) => {

  const taskId = Number(req.params.id);

  if (!Number.isInteger(taskId)) {
    return res.status(400).json({
      ok: false,
      error: "Invalid task ID."
    });
  }

  try {

    const r = await pool.query(
      `SELECT
         id,
         title,
         description,
         reward,
         task_type,
         provider,
         provider_task_id,
         icon,
         daily_limit,
         created_at
       FROM tm_tasks
       WHERE id=$1
         AND active=true
       LIMIT 1`,
      [taskId]
    );

    if (!r.rows.length) {
      return res.status(404).json({
        ok: false,
        error: "Task not found."
      });
    }

    res.json({
      ok: true,
      task: r.rows[0]
    });

  } catch (e) {

    console.error("Task details error:", e);

    res.status(500).json({
      ok: false,
      error: "Could not load task."
    });
  }
});


/*
  Start a task.

  IMPORTANT:
  Starting a task does NOT give money.
  It creates a pending completion.
*/

app.post("/api/tasks/:id/start", auth, async (req, res) => {

  const taskId = Number(req.params.id);

  if (!Number.isInteger(taskId)) {
    return res.status(400).json({
      ok: false,
      error: "Invalid task ID."
    });
  }

  const client = await pool.connect();

  try {

    await client.query("BEGIN");

    const taskResult = await client.query(
      `SELECT
         id,
         title,
         reward,
         task_type,
         provider,
         provider_task_id,
         daily_limit
       FROM tm_tasks
       WHERE id=$1
         AND active=true
       FOR UPDATE`,
      [taskId]
    );

    if (!taskResult.rows.length) {

      await client.query("ROLLBACK");

      return res.status(404).json({
        ok: false,
        error: "Task is not available."
      });
    }

    const task = taskResult.rows[0];

    /*
      Prevent a user from repeatedly starting
      the same task while an earlier completion exists.
    */

    const existing = await client.query(
      `SELECT
         id,
         status,
         reward,
         started_at,
         completed_at
       FROM tm_task_completions
       WHERE user_id=$1
         AND task_id=$2
       ORDER BY id DESC
       LIMIT 1`,
      [
        req.auth.userId,
        taskId
      ]
    );

    if (existing.rows.length) {

      const previous = existing.rows[0];

      if (
        previous.status === "pending" ||
        previous.status === "completed"
      ) {

        await client.query("ROLLBACK");

        return res.status(400).json({
          ok: false,
          error:
            previous.status === "completed"
              ? "You have already completed this task."
              : "You already started this task. It is waiting for verification.",
          completion: previous
        });
      }
    }

    /*
      Optional daily task limit.
    */

    if (task.daily_limit) {

      const today = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM tm_task_completions
         WHERE task_id=$1
           AND created_at>=CURRENT_DATE
           AND created_at<CURRENT_DATE+INTERVAL '1 day'`,
        [taskId]
      );

      const used = Number(
        today.rows[0].count || 0
      );

      if (used >= Number(task.daily_limit)) {

        await client.query("ROLLBACK");

        return res.status(400).json({
          ok: false,
          error: "This task has reached its daily limit."
        });
      }
    }

    const completion = await client.query(
      `INSERT INTO tm_task_completions
       (
         user_id,
         task_id,
         reward,
         status,
         started_at
       )
       VALUES($1,$2,$3,'pending',CURRENT_TIMESTAMP)
       RETURNING
         id,
         task_id,
         reward,
         status,
         started_at`,
      [
        req.auth.userId,
        taskId,
        task.reward
      ]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      message:
        "Task started. Complete the activity and wait for verification.",
      task,
      completion: completion.rows[0]
    });

  } catch (e) {

    await client.query("ROLLBACK");

    console.error("Start task error:", e);

    res.status(500).json({
      ok: false,
      error: "Could not start task."
    });

  } finally {
    client.release();
  }
});


/*
  Current user's task history
*/

app.get("/api/my-tasks", auth, async (req, res) => {

  try {

    const r = await pool.query(
      `SELECT
         c.id,
         c.task_id,
         c.reward,
         c.status,
         c.provider_reference,
         c.started_at,
         c.completed_at,
         c.created_at,
         t.title,
         t.description,
         t.task_type,
         t.icon
       FROM tm_task_completions c
       JOIN tm_tasks t
         ON t.id=c.task_id
       WHERE c.user_id=$1
       ORDER BY c.id DESC
       LIMIT 50`,
      [req.auth.userId]
    );

    res.json({
      ok: true,
      items: r.rows
    });

  } catch (e) {

    console.error("My tasks error:", e);

    res.status(500).json({
      ok: false,
      error: "Could not load your tasks."
    });
  }
});


/* =========================================================
   ADMIN LOGIN
========================================================= */

app.post("/api/admin/login", async (req, res) => {

  const {
    email,
    password
  } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({
      ok: false,
      error: "Email and password are required."
    });
  }

  if (
    String(email).trim().toLowerCase() !==
    String(ADMIN_EMAIL || "").trim().toLowerCase()
  ) {
    return res.status(401).json({
      ok: false,
      error: "Invalid admin credentials."
    });
  }

  if (
    String(password) !==
    String(ADMIN_PASSWORD || "")
  ) {
    return res.status(401).json({
      ok: false,
      error: "Invalid admin credentials."
    });
  }

  res.json({
    ok: true,
    token: signAdminToken()
  });
});


/* =========================================================
   ADMIN TASK MANAGEMENT
========================================================= */


/*
  Get all tasks for admin
*/

app.get("/api/admin/tasks", adminAuth, async (req, res) => {

  try {

    const r = await pool.query(
      `SELECT
         id,
         title,
         description,
         reward,
         task_type,
         provider,
         provider_task_id,
         icon,
         active,
         daily_limit,
         created_at
       FROM tm_tasks
       ORDER BY id DESC`
    );

    res.json({
      ok: true,
      tasks: r.rows
    });

  } catch (e) {

    console.error("Admin tasks error:", e);

    res.status(500).json({
      ok: false,
      error: "Could not load admin tasks."
    });
  }
});


/*
  Create new task
*/

app.post("/api/admin/tasks", adminAuth, async (req, res) => {

  const {
    title,
    description,
    reward,
    taskType,
    provider,
    providerTaskId,
    icon,
    dailyLimit,
    active
  } = req.body || {};

  const cleanTitle = String(
    title || ""
  ).trim();

  const cleanDescription = String(
    description || ""
  ).trim();

  const rewardValue = Number(reward);

  const cleanType = String(
    taskType || "task"
  ).trim().toLowerCase();

  const cleanProvider = String(
    provider || "internal"
  ).trim();

  const cleanProviderTaskId = String(
    providerTaskId || ""
  ).trim() || null;

  const cleanIcon = String(
    icon || "🎯"
  ).trim();

  const limitValue =
    dailyLimit === null ||
    dailyLimit === undefined ||
    dailyLimit === ""
      ? null
      : Number(dailyLimit);

  if (!cleanTitle) {
    return res.status(400).json({
      ok: false,
      error: "Task title is required."
    });
  }

  if (
    !Number.isFinite(rewardValue) ||
    rewardValue <= 0
  ) {
    return res.status(400).json({
      ok: false,
      error: "Reward must be greater than 0."
    });
  }

  if (
    limitValue !== null &&
    (
      !Number.isInteger(limitValue) ||
      limitValue <= 0
    )
  ) {
    return res.status(400).json({
      ok: false,
      error: "Daily limit must be a positive integer."
    });
  }

  try {

    const r = await pool.query(
      `INSERT INTO tm_tasks
       (
         title,
         description,
         reward,
         task_type,
         provider,
         provider_task_id,
         icon,
         daily_limit,
         active
       )
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        cleanTitle,
        cleanDescription || null,
        rewardValue,
        cleanType,
        cleanProvider,
        cleanProviderTaskId,
        cleanIcon,
        limitValue,
        active !== false
      ]
    );

    res.status(201).json({
      ok: true,
      message: "Task created successfully.",
      task: r.rows[0]
    });

  } catch (e) {

    console.error("Create task error:", e);

    res.status(500).json({
      ok: false,
      error: "Could not create task."
    });
  }
});


/*
  Update task
*/

app.patch("/api/admin/tasks/:id", adminAuth, async (req, res) => {

  const taskId = Number(req.params.id);

  if (!Number.isInteger(taskId)) {
    return res.status(400).json({
      ok: false,
      error: "Invalid task ID."
    });
  }

  const {
    title,
    description,
    reward,
    taskType,
    provider,
    providerTaskId,
    icon,
    dailyLimit,
    active
  } = req.body || {};

  try {

    const existing = await pool.query(
      `SELECT *
       FROM tm_tasks
       WHERE id=$1`,
      [taskId]
    );

    if (!existing.rows.length) {
      return res.status(404).json({
        ok: false,
        error: "Task not found."
      });
    }

    const old = existing.rows[0];

    const newTitle =
      title !== undefined
        ? String(title).trim()
        : old.title;

    const newDescription =
      description !== undefined
        ? String(description).trim()
        : old.description;

    const newReward =
      reward !== undefined
        ? Number(reward)
        : Number(old.reward);

    const newType =
      taskType !== undefined
        ? String(taskType).trim().toLowerCase()
        : old.task_type;

    const newProvider =
      provider !== undefined
        ? String(provider).trim()
        : old.provider;

    const newProviderTaskId =
      providerTaskId !== undefined
        ? (
            String(providerTaskId).trim() || null
          )
        : old.provider_task_id;

    const newIcon =
      icon !== undefined
        ? String(icon).trim()
        : old.icon;

    let newDailyLimit = old.daily_limit;

    if (dailyLimit !== undefined) {

      newDailyLimit =
        dailyLimit === null ||
        dailyLimit === ""
          ? null
          : Number(dailyLimit);

      if (
        newDailyLimit !== null &&
        (
          !Number.isInteger(newDailyLimit) ||
          newDailyLimit <= 0
        )
      ) {
        return res.status(400).json({
          ok: false,
          error: "Invalid daily limit."
        });
      }
    }

    const newActive =
      active !== undefined
        ? Boolean(active)
        : old.active;

    if (!newTitle) {
      return res.status(400).json({
        ok: false,
        error: "Task title is required."
      });
    }

    if (
      !Number.isFinite(newReward) ||
      newReward <= 0
    ) {
      return res.status(400).json({
        ok: false,
        error: "Reward must be greater than 0."
      });
    }

    const r = await pool.query(
      `UPDATE tm_tasks
       SET
         title=$1,
         description=$2,
         reward=$3,
         task_type=$4,
         provider=$5,
         provider_task_id=$6,
         icon=$7,
         daily_limit=$8,
         active=$9
       WHERE id=$10
       RETURNING *`,
      [
        newTitle,
        newDescription || null,
        newReward,
        newType,
        newProvider,
        newProviderTaskId,
        newIcon,
        newDailyLimit,
        newActive,
        taskId
      ]
    );

    res.json({
      ok: true,
      message: "Task updated successfully.",
      task: r.rows[0]
    });

  } catch (e) {

    console.error("Update task error:", e);

    res.status(500).json({
      ok: false,
      error: "Could not update task."
    });
  }
});


/*
  Delete task
*/

app.delete("/api/admin/tasks/:id", adminAuth, async (req, res) => {

  const taskId = Number(req.params.id);

  if (!Number.isInteger(taskId)) {
    return res.status(400).json({
      ok: false,
      error: "Invalid task ID."
    });
  }

  try {

    const r = await pool.query(
      `DELETE FROM tm_tasks
       WHERE id=$1
       RETURNING id`,
      [taskId]
    );

    if (!r.rows.length) {
      return res.status(404).json({
        ok: false,
        error: "Task not found."
      });
    }

    res.json({
      ok: true,
      message: "Task deleted successfully."
    });

  } catch (e) {

    console.error("Delete task error:", e);

    res.status(500).json({
      ok: false,
      error: "Could not delete task."
    });
  }
});


/*
  Activate / deactivate task
*/

app.patch("/api/admin/tasks/:id/status", adminAuth, async (req, res) => {

  const taskId = Number(req.params.id);

  const active =
    req.body?.active === true;

  if (!Number.isInteger(taskId)) {
    return res.status(400).json({
      ok: false,
      error: "Invalid task ID."
    });
  }

  try {

    const r = await pool.query(
      `UPDATE tm_tasks
       SET active=$1
       WHERE id=$2
       RETURNING id,title,active`,
      [
        active,
        taskId
      ]
    );

    if (!r.rows.length) {
      return res.status(404).json({
        ok: false,
        error: "Task not found."
      });
    }

    res.json({
      ok: true,
      task: r.rows[0]
    });

  } catch (e) {

    console.error("Task status error:", e);

    res.status(500).json({
      ok: false,
      error: "Could not update task status."
    });
  }
});


/* =========================================================
   ADMIN TASK COMPLETIONS
========================================================= */

/*
  Admin can see pending task completions.
*/

app.get(
  "/api/admin/task-completions",
  adminAuth,
  async (req, res) => {

    try {

      const r = await pool.query(
        `SELECT
           c.id,
           c.user_id,
           c.task_id,
           c.reward,
           c.status,
           c.provider_reference,
           c.started_at,
           c.completed_at,
           c.created_at,
           u.display_name,
           u.email,
           t.title,
           t.task_type
         FROM tm_task_completions c
         JOIN tm_users u
           ON u.id=c.user_id
         JOIN tm_tasks t
           ON t.id=c.task_id
         ORDER BY c.id DESC
         LIMIT 200`
      );

      res.json({
        ok: true,
        items: r.rows
      });

    } catch (e) {

      console.error(
        "Admin task completions error:",
        e
      );

      res.status(500).json({
        ok: false,
        error: "Could not load task completions."
      });
    }
  }
);


/*
  Admin verifies a task.

  THIS is where the reward is actually credited.
*/

app.post(
  "/api/admin/task-completions/:id/approve",
  adminAuth,
  async (req, res) => {

    const completionId =
      Number(req.params.id);

    if (!Number.isInteger(completionId)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid completion ID."
      });
    }

    const client = await pool.connect();

    try {

      await client.query("BEGIN");

      const c = await client.query(
        `SELECT
           c.id,
           c.user_id,
           c.task_id,
           c.reward,
           c.status,
           t.title
         FROM tm_task_completions c
         JOIN tm_tasks t
           ON t.id=c.task_id
         WHERE c.id=$1
         FOR UPDATE`,
        [completionId]
      );

      if (!c.rows.length) {

        await client.query("ROLLBACK");

        return res.status(404).json({
          ok: false,
          error: "Task completion not found."
        });
      }

      const completion = c.rows[0];

      if (completion.status !== "pending") {

        await client.query("ROLLBACK");

        return res.status(400).json({
          ok: false,
          error:
            `Completion is already ${completion.status}.`
        });
      }

      /*
        Credit user balance
      */

      await client.query(
        `UPDATE tm_users
         SET
           balance=balance+$1,
           total_earned=total_earned+$1
         WHERE id=$2`,
        [
          completion.reward,
          completion.user_id
        ]
      );

      /*
        Transaction record
      */

      await client.query(
        `INSERT INTO tm_transactions
         (
           user_id,
           type,
           amount,
           description
         )
         VALUES($1,'task_reward',$2,$3)`,
        [
          completion.user_id,
          completion.reward,
          `Completed task: ${completion.title}`
        ]
      );

      /*
        Mark completion
      */

      await client.query(
        `UPDATE tm_task_completions
         SET
           status='completed',
           completed_at=CURRENT_TIMESTAMP
         WHERE id=$1`,
        [completionId]
      );

      const user = await client.query(
        `SELECT balance,total_earned
         FROM tm_users
         WHERE id=$1`,
        [completion.user_id]
      );

      await client.query("COMMIT");

      res.json({
        ok: true,
        message: "Task approved and reward credited.",
        reward: completion.reward,
        balance: user.rows[0].balance,
        totalEarned: user.rows[0].total_earned
      });

    } catch (e) {

      await client.query("ROLLBACK");

      console.error(
        "Approve task error:",
        e
      );

      res.status(500).json({
        ok: false,
        error: "Could not approve task."
      });

    } finally {
      client.release();
    }
  }
);


/*
  Admin rejects a task completion
*/

app.post(
  "/api/admin/task-completions/:id/reject",
  adminAuth,
  async (req, res) => {

    const completionId =
      Number(req.params.id);

    if (!Number.isInteger(completionId)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid completion ID."
      });
    }

    try {

      const r = await pool.query(
        `UPDATE tm_task_completions
         SET status='rejected'
         WHERE id=$1
           AND status='pending'
         RETURNING id`,
        [completionId]
      );

      if (!r.rows.length) {
        return res.status(400).json({
          ok: false,
          error:
            "Completion not found or already processed."
        });
      }

      res.json({
        ok: true,
        message: "Task completion rejected."
      });

    } catch (e) {

      console.error(
        "Reject task error:",
        e
      );

      res.status(500).json({
        ok: false,
        error: "Could not reject task."
      });
    }
  }
);


/* =========================================================
   WITHDRAWALS
========================================================= */

app.post("/api/withdrawals", auth, async (req, res) => {

  const {
    amount,
    method,
    accountNumber,
    accountName
  } = req.body || {};

  const value = Number(amount);

  if (
    !Number.isFinite(value) ||
    value < MIN_WITHDRAW
  ) {
    return res.status(400).json({
      ok: false,
      error:
        `Minimum withdrawal is $${MIN_WITHDRAW.toFixed(2)}.`
    });
  }

  if (
    !["bkash", "nagad"].includes(
      String(method).toLowerCase()
    )
  ) {
    return res.status(400).json({
      ok: false,
      error: "Select bKash or Nagad."
    });
  }

  if (
    !/^[0-9]{11}$/.test(
      String(accountNumber || "")
    )
  ) {
    return res.status(400).json({
      ok: false,
      error:
        "Enter a valid 11-digit account number."
    });
  }

  const client = await pool.connect();

  try {

    await client.query("BEGIN");

    const u = await client.query(
      `SELECT id,balance
       FROM tm_users
       WHERE id=$1
       FOR UPDATE`,
      [req.auth.userId]
    );

    if (!u.rows.length) {

      await client.query("ROLLBACK");

      return res.status(404).json({
        ok: false,
        error: "User not found."
      });
    }

    if (
      Number(u.rows[0].balance) < value
    ) {

      await client.query("ROLLBACK");

      return res.status(400).json({
        ok: false,
        error: "Insufficient balance."
      });
    }

    await client.query(
      `INSERT INTO tm_withdrawals
       (
         user_id,
         amount,
         method,
         account_number,
         account_name
       )
       VALUES($1,$2,$3,$4,$5)`,
      [
        req.auth.userId,
        value,
        String(method).toLowerCase(),
        String(accountNumber),
        String(accountName || "").trim()
      ]
    );

    await client.query(
      `UPDATE tm_users
       SET balance=balance-$1
       WHERE id=$2`,
      [
        value,
        req.auth.userId
      ]
    );

    await client.query(
      `INSERT INTO tm_transactions
       (
         user_id,
         type,
         amount,
         description
       )
       VALUES($1,'withdrawal',$2,$3)`,
      [
        req.auth.userId,
        -value,
        `Withdrawal request via ${String(method).toLowerCase()}`
      ]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      message: "Withdrawal request submitted."
    });

  } catch (e) {

    await client.query("ROLLBACK");

    console.error(
      "Withdrawal error:",
      e
    );

    res.status(500).json({
      ok: false,
      error: "Could not submit withdrawal."
    });

  } finally {
    client.release();
  }
});


/* =========================================================
   ADMIN WITHDRAWALS
========================================================= */

app.get(
  "/api/admin/withdrawals",
  adminAuth,
  async (req, res) => {

    try {

      const r = await pool.query(
        `SELECT
           w.id,
           w.user_id,
           w.amount,
           w.method,
           w.account_number,
           w.account_name,
           w.status,
           w.created_at,
           w.processed_at,
           u.display_name,
           u.email,
           u.balance
         FROM tm_withdrawals w
         JOIN tm_users u
           ON u.id=w.user_id
         ORDER BY w.id DESC
         LIMIT 200`
      );

      res.json({
        ok: true,
        items: r.rows
      });

    } catch (e) {

      console.error(
        "Admin withdrawals error:",
        e
      );

      res.status(500).json({
        ok: false,
        error: "Could not load withdrawals."
      });
    }
  }
);


app.post(
  "/api/admin/withdrawals/:id/approve",
  adminAuth,
  async (req, res) => {

    const withdrawalId =
      Number(req.params.id);

    if (!Number.isInteger(withdrawalId)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid withdrawal ID."
      });
    }

    const client = await pool.connect();

    try {

      await client.query("BEGIN");

      const r = await client.query(
        `SELECT
           id,
           user_id,
           amount,
           status
         FROM tm_withdrawals
         WHERE id=$1
         FOR UPDATE`,
        [withdrawalId]
      );

      if (!r.rows.length) {

        await client.query("ROLLBACK");

        return res.status(404).json({
          ok: false,
          error: "Withdrawal not found."
        });
      }

      const withdrawal = r.rows[0];

      if (withdrawal.status !== "pending") {

        await client.query("ROLLBACK");

        return res.status(400).json({
          ok: false,
          error:
            `Withdrawal is already ${withdrawal.status}.`
        });
      }

      await client.query(
        `UPDATE tm_withdrawals
         SET
           status='approved',
           processed_at=CURRENT_TIMESTAMP
         WHERE id=$1`,
        [withdrawalId]
      );

      await client.query("COMMIT");

      res.json({
        ok: true,
        message:
          "Withdrawal approved successfully."
      });

    } catch (e) {

      await client.query("ROLLBACK");

      console.error(
        "Approve withdrawal error:",
        e
      );

      res.status(500).json({
        ok: false,
        error:
          "Could not approve withdrawal."
      });

    } finally {
      client.release();
    }
  }
);


app.post(
  "/api/admin/withdrawals/:id/reject",
  adminAuth,
  async (req, res) => {

    const withdrawalId =
      Number(req.params.id);

    if (!Number.isInteger(withdrawalId)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid withdrawal ID."
      });
    }

    const client = await pool.connect();

    try {

      await client.query("BEGIN");

      const r = await client.query(
        `SELECT
           id,
           user_id,
           amount,
           status,
           method
         FROM tm_withdrawals
         WHERE id=$1
         FOR UPDATE`,
        [withdrawalId]
      );

      if (!r.rows.length) {

        await client.query("ROLLBACK");

        return res.status(404).json({
          ok: false,
          error: "Withdrawal not found."
        });
      }

      const withdrawal = r.rows[0];

      if (withdrawal.status !== "pending") {

        await client.query("ROLLBACK");

        return res.status(400).json({
          ok: false,
          error:
            `Withdrawal is already ${withdrawal.status}.`
        });
      }

      await client.query(
        `UPDATE tm_users
         SET balance=balance+$1
         WHERE id=$2`,
        [
          withdrawal.amount,
          withdrawal.user_id
        ]
      );

      await client.query(
        `UPDATE tm_withdrawals
         SET
           status='rejected',
           processed_at=CURRENT_TIMESTAMP
         WHERE id=$1`,
        [withdrawalId]
      );

      await client.query(
        `INSERT INTO tm_transactions
         (
           user_id,
           type,
           amount,
           description
         )
         VALUES($1,'withdrawal_refund',$2,$3)`,
        [
          withdrawal.user_id,
          withdrawal.amount,
          `Withdrawal rejected - ${withdrawal.method}`
        ]
      );

      await client.query("COMMIT");

      res.json({
        ok: true,
        message:
          "Withdrawal rejected and balance refunded."
      });

    } catch (e) {

      await client.query("ROLLBACK");

      console.error(
        "Reject withdrawal error:",
        e
      );

      res.status(500).json({
        ok: false,
        error:
          "Could not reject withdrawal."
      });

    } finally {
      client.release();
    }
  }
);

    
/* =========================================================
   DATABASE INITIALIZATION / MIGRATION
========================================================= */

async function init() {

  try {

    console.log("Starting database initialization...");


    /* =====================================================
       1. DATABASE CONNECTION
    ===================================================== */

    await pool.query("SELECT 1");

    console.log("Database connection OK.");


    /* =====================================================
       2. LOAD SCHEMA
    ===================================================== */

    const schemaPath = path.join(
      __dirname,
      "schema.sql"
    );

    if (!fs.existsSync(schemaPath)) {

      throw new Error(
        "schema.sql was not found."
      );

    }

    const schema = fs.readFileSync(
      schemaPath,
      "utf8"
    );

    if (schema.trim()) {

      await pool.query(schema);

    }

    console.log(
      "Database schema loaded."
    );


    /* =====================================================
       3. VERIFY REQUIRED TABLES
    ===================================================== */

    const tables = await pool.query(`
      SELECT
        to_regclass('public.tm_users') AS users,
        to_regclass('public.tm_transactions') AS transactions,
        to_regclass('public.tm_withdrawals') AS withdrawals,
        to_regclass('public.tm_tasks') AS tasks,
        to_regclass('public.tm_task_completions') AS completions,
        to_regclass('public.tm_daily_claims') AS daily_claims
    `);

    const dbTables = tables.rows[0];

    if (!dbTables.users) {
      throw new Error(
        "tm_users table does not exist."
      );
    }

    if (!dbTables.transactions) {
      throw new Error(
        "tm_transactions table does not exist."
      );
    }

    if (!dbTables.withdrawals) {
      throw new Error(
        "tm_withdrawals table does not exist."
      );
    }

    if (!dbTables.tasks) {
      throw new Error(
        "tm_tasks table does not exist."
      );
    }

    if (!dbTables.completions) {
      throw new Error(
        "tm_task_completions table does not exist."
      );
    }

    if (!dbTables.daily_claims) {
      throw new Error(
        "tm_daily_claims table does not exist."
      );
    }

    console.log(
      "Required database tables confirmed."
    );


    /* =====================================================
       4. TASK TABLE MIGRATION
    ===================================================== */

    console.log(
      "Running task database migration..."
    );


    await pool.query(`
      ALTER TABLE tm_tasks
      ADD COLUMN IF NOT EXISTS provider VARCHAR(80)
    `);


    await pool.query(`
      ALTER TABLE tm_tasks
      ADD COLUMN IF NOT EXISTS provider_task_id VARCHAR(255)
    `);


    await pool.query(`
      ALTER TABLE tm_tasks
      ADD COLUMN IF NOT EXISTS icon VARCHAR(20)
    `);


    await pool.query(`
      ALTER TABLE tm_tasks
      ADD COLUMN IF NOT EXISTS daily_limit INTEGER
    `);


    await pool.query(`
      ALTER TABLE tm_tasks
      ADD COLUMN IF NOT EXISTS active BOOLEAN
    `);


    await pool.query(`
      ALTER TABLE tm_tasks
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMP
    `);


    /* =====================================================
       5. TASK COMPLETION MIGRATION
    ===================================================== */

    await pool.query(`
      ALTER TABLE tm_task_completions
      ADD COLUMN IF NOT EXISTS provider_reference VARCHAR(255)
    `);


    await pool.query(`
      ALTER TABLE tm_task_completions
      ADD COLUMN IF NOT EXISTS status VARCHAR(20)
    `);


    await pool.query(`
      ALTER TABLE tm_task_completions
      ADD COLUMN IF NOT EXISTS started_at TIMESTAMP
    `);


    await pool.query(`
      ALTER TABLE tm_task_completions
      ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP
    `);


    await pool.query(`
      ALTER TABLE tm_task_completions
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMP
    `);


    /* =====================================================
       6. FIX OLD DATA
    ===================================================== */

    await pool.query(`
      UPDATE tm_tasks
      SET provider = 'internal'
      WHERE provider IS NULL
    `);


    await pool.query(`
      UPDATE tm_tasks
      SET icon = '🎯'
      WHERE icon IS NULL
    `);


    await pool.query(`
      UPDATE tm_tasks
      SET active = true
      WHERE active IS NULL
    `);


    await pool.query(`
      UPDATE tm_task_completions
      SET status = 'pending'
      WHERE status IS NULL
    `);


    /* =====================================================
       7. VERIFY PROVIDER COLUMN
    ===================================================== */

    const providerCheck = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'tm_tasks'
        AND column_name = 'provider'
    `);


    if (!providerCheck.rows.length) {

      throw new Error(
        "Migration failed: tm_tasks.provider column was not created."
      );

    }


    console.log(
      "tm_tasks.provider column confirmed."
    );


    /* =====================================================
       8. VERIFY OTHER TASK COLUMNS
    ===================================================== */

    const taskColumns = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'tm_tasks'
        AND column_name IN (
          'provider',
          'provider_task_id',
          'icon',
          'daily_limit',
          'active'
        )
      ORDER BY column_name
    `);


    console.log(
      "Task columns available:",
      taskColumns.rows
        .map(row => row.column_name)
        .join(", ")
    );


    /* =====================================================
       9. CREATE DEFAULT WATCH & EARN TASK
    ===================================================== */

    const adTask = await pool.query(`
      SELECT id
      FROM tm_tasks
      WHERE task_type = 'ad'
      ORDER BY id ASC
      LIMIT 1
    `);


    if (!adTask.rows.length) {

      await pool.query(`
        INSERT INTO tm_tasks
        (
          title,
          description,
          reward,
          task_type,
          provider,
          provider_task_id,
          icon,
          daily_limit,
          active
        )
        VALUES
        (
          'Watch & Earn',
          'Watch an eligible sponsored activity and receive the verified reward.',
          $1,
          'ad',
          'internal',
          NULL,
          '🎬',
          $2,
          true
        )
      `, [
        AD_REWARD,
        DAILY_AD_LIMIT
      ]);


      console.log(
        "Default Watch & Earn task created."
      );

    } else {

      console.log(
        "Watch & Earn task already exists."
      );

    }


    /* =====================================================
       10. CREATE DEFAULT APP TASK
    ===================================================== */

    const appTask = await pool.query(`
      SELECT id
      FROM tm_tasks
      WHERE task_type = 'app'
      ORDER BY id ASC
      LIMIT 1
    `);


    if (!appTask.rows.length) {

      await pool.query(`
        INSERT INTO tm_tasks
        (
          title,
          description,
          reward,
          task_type,
          provider,
          provider_task_id,
          icon,
          active
        )
        VALUES
        (
          'Daily App Task',
          'Complete the available activity according to the task instructions.',
          1.00,
          'app',
          'internal',
          NULL,
          '📱',
          true
        )
      `);


      console.log(
        "Default App task created."
      );

    }


    /* =====================================================
       11. CREATE DEFAULT GAME TASK
    ===================================================== */

    const gameTask = await pool.query(`
      SELECT id
      FROM tm_tasks
      WHERE task_type = 'game'
      ORDER BY id ASC
      LIMIT 1
    `);


    if (!gameTask.rows.length) {

      await pool.query(`
        INSERT INTO tm_tasks
        (
          title,
          description,
          reward,
          task_type,
          provider,
          provider_task_id,
          icon,
          active
        )
        VALUES
        (
          'Game Offer',
          'Complete the game offer requirements to receive the verified reward.',
          2.00,
          'game',
          'internal',
          NULL,
          '🎮',
          true
        )
      `);


      console.log(
        "Default Game task created."
      );

    }


    /* =====================================================
       12. CREATE DEFAULT SURVEY TASK
    ===================================================== */

    const surveyTask = await pool.query(`
      SELECT id
      FROM tm_tasks
      WHERE task_type = 'survey'
      ORDER BY id ASC
      LIMIT 1
    `);


    if (!surveyTask.rows.length) {

      await pool.query(`
        INSERT INTO tm_tasks
        (
          title,
          description,
          reward,
          task_type,
          provider,
          provider_task_id,
          icon,
          active
        )
        VALUES
        (
          'Survey',
          'Complete an eligible survey and wait for verification.',
          1.50,
          'survey',
          'internal',
          NULL,
          '📝',
          true
        )
      `);


      console.log(
        "Default Survey task created."
      );

    }


    /* =====================================================
       13. FINAL DATABASE CHECK
    ===================================================== */

    const finalCheck = await pool.query(`
      SELECT
        id,
        title,
        reward,
        task_type,
        provider,
        active
      FROM tm_tasks
      ORDER BY id ASC
    `);


    console.log(
      `Task database check: ${finalCheck.rows.length} task(s) found.`
    );


    /* =====================================================
       14. DATABASE READY
    ===================================================== */

    console.log(
      "Database migration completed."
    );

    console.log(
      "Database ready."
    );


    /* =====================================================
       15. SPA FALLBACK
    ===================================================== */

    app.get("/{*splat}", (req, res) => {

      res.sendFile(
        path.join(
          __dirname,
          "public",
          "index.html"
        )
      );

    });


    /* =====================================================
       16. START SERVER
    ===================================================== */

    app.listen(
      PORT,
      () => {

        console.log(
          `TaskMint running on port ${PORT}`
        );

      }
    );


  } catch (e) {

    console.error(
      "========== STARTUP ERROR =========="
    );

    console.error(e);

    if (e.stack) {
      console.error(e.stack);
    }

    process.exit(1);

  }

}


/* =========================================================
   START
========================================================= */

init();
