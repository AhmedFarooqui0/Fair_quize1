// ═══════════════════════════════════════════════════
//   FairQuiz v3 — server.js
//   Backend: Node.js + Express + Oracle 11g (oracledb)
// ═══════════════════════════════════════════════════

require('dotenv').config();                  // loads .env file
const express    = require('express');
const oracledb   = require('oracledb');
const cors       = require('cors');
const bodyParser = require('body-parser');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname));          // serves index.html + any CSS/JS files in same folder

// ── Oracle Instant Client ───────────────────────────
// Reads path from .env → ORACLE_CLIENT
try {
  oracledb.initOracleClient({ libDir: process.env.ORACLE_CLIENT });
  console.log('✅ Oracle Instant Client loaded from:', process.env.ORACLE_CLIENT);
} catch (err) {
  console.error('❌ Instant Client load failed:', err.message);
  console.error('   Fix: Check ORACLE_CLIENT path in .env file');
}

// ── Oracle DB Config ────────────────────────────────
// All values come from .env file — never hardcoded here
const DB_CONFIG = {
  user:          process.env.DB_USER,
  password:      process.env.DB_PASS,
  connectString: process.env.DB_STRING
};

// ── Helper: get a DB connection ─────────────────────
async function getConn() {
  return await oracledb.getConnection(DB_CONFIG);
}

// ── Test DB connection on startup ───────────────────
async function testConnection() {
  let conn;
  try {
    conn = await getConn();

    // Simple test query — works on all Oracle versions
    const r = await conn.execute('SELECT 1 FROM DUAL');
    console.log('✅ Oracle 11g connected successfully!');

    // Check if our tables exist
    const tables = await conn.execute(
      `SELECT table_name FROM user_tables WHERE table_name IN ('FQ_USERS','FQ_SCORES')`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const found = tables.rows.map(r => r.TABLE_NAME);
    if (found.includes('FQ_USERS'))  console.log('✅ Table fq_users  — found');
    else                              console.warn('⚠️  Table fq_users  — NOT found. Run setup SQL in SQL*Plus.');
    if (found.includes('FQ_SCORES')) console.log('✅ Table fq_scores — found');
    else                              console.warn('⚠️  Table fq_scores — NOT found. Run setup SQL in SQL*Plus.');

  } catch (err) {
    console.error('❌ Oracle connection failed:', err.message);
    console.error('   Checklist:');
    console.error('   1. Is Oracle 11g service running?  →  net start OracleServiceXE');
    console.error('   2. Is the listener running?        →  lsnrctl start');
    console.error('   3. Check DB_USER / DB_PASS / DB_STRING in .env');
  } finally {
    if (conn) await conn.close();
  }
}

// ════════════════════════════════════════════════════
//  API ROUTES
// ════════════════════════════════════════════════════

// ── POST /api/login ─────────────────────────────────
// Called by index.html → handleLogin()
// If user exists + password matches → login
// If user exists + wrong password   → error
// If user doesn't exist             → auto-register
// ────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  // Basic validation
  if (!username || !password)
    return res.json({ success: false, error: 'Username and password are required.' });
  if (password.length < 4)
    return res.json({ success: false, error: 'Password must be at least 4 characters.' });
  if (username.length < 3)
    return res.json({ success: false, error: 'Username must be at least 3 characters.' });

  let conn;
  try {
    conn = await getConn();

    // Step 1: Check username + password match
    const loginCheck = await conn.execute(
      `SELECT id FROM fq_users WHERE username = :1 AND password = :2`,
      [username, password],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (loginCheck.rows.length > 0) {
      console.log(`[LOGIN]  User "${username}" logged in.`);
      return res.json({ success: true, message: 'Login successful!' });
    }

    // Step 2: Username exists but wrong password
    const userCheck = await conn.execute(
      `SELECT id FROM fq_users WHERE username = :1`,
      [username],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (userCheck.rows.length > 0) {
      return res.json({ success: false, error: 'Incorrect password. Try again.' });
    }

    // Step 3: New user — register them
    await conn.execute(
      `INSERT INTO fq_users (username, password) VALUES (:1, :2)`,
      [username, password]
    );
    await conn.commit();
    console.log(`[REGISTER] New user "${username}" registered.`);
    return res.json({ success: true, message: `Welcome ${username}! Account created.` });

  } catch (err) {
    console.error('[LOGIN ERROR]', err.message);
    return res.json({ success: false, error: 'Database error. Please try again.' });
  } finally {
    if (conn) await conn.close();
  }
});

// ── POST /api/score ─────────────────────────────────
// Called by index.html → finishQuiz()
// Saves quiz result to fq_scores table
// ────────────────────────────────────────────────────
app.post('/api/score', async (req, res) => {
  const { username, subject, difficulty, score, total, pct, violations, hints_used } = req.body;

  // Validate required fields
  if (!username || score === undefined || !total)
    return res.json({ success: false, error: 'Missing required score data.' });

  let conn;
  try {
    conn = await getConn();

    await conn.execute(
      `INSERT INTO fq_scores
         (username, subject, difficulty, score, total, pct, violations, hints_used)
       VALUES (:1, :2, :3, :4, :5, :6, :7, :8)`,
      [username, subject || 'All', difficulty || 'Easy',
       score, total, pct || 0, violations || 0, hints_used || 0]
    );
    await conn.commit();

    console.log(`[SCORE SAVED] ${username} → ${score}/${total} (${pct}%) | ${subject} | ${difficulty}`);
    return res.json({ success: true, message: 'Score saved to Oracle DB.' });

  } catch (err) {
    console.error('[SCORE ERROR]', err.message);
    return res.json({ success: false, error: 'Could not save score.' });
  } finally {
    if (conn) await conn.close();
  }
});

// ── GET /api/leaderboard ────────────────────────────
// Called by index.html → showLeaderboard()
// Returns top 20 scores from Oracle DB
// Uses ROWNUM (Oracle 11g compatible — no FETCH FIRST)
// ────────────────────────────────────────────────────
app.get('/api/leaderboard', async (req, res) => {
  let conn;
  try {
    conn = await getConn();

    const result = await conn.execute(
      `SELECT * FROM (
         SELECT
           username,
           subject,
           difficulty,
           score,
           total,
           pct,
           violations,
           hints_used,
           TO_CHAR(submitted_at, 'DD/MM/YYYY') AS date_str
         FROM fq_scores
         ORDER BY pct DESC, score DESC
       ) WHERE ROWNUM <= 20`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    return res.json({ success: true, data: result.rows });

  } catch (err) {
    console.error('[LEADERBOARD ERROR]', err.message);
    return res.json({ success: false, error: err.message, data: [] });
  } finally {
    if (conn) await conn.close();
  }
});

// ── GET /api/check-attempt ──────────────────────────
// Called by index.html → goToRules()
// Checks if user already attempted this difficulty
// ────────────────────────────────────────────────────
app.get('/api/check-attempt', async (req, res) => {
  const { username, difficulty } = req.query;
  if (!username || !difficulty)
    return res.json({ attempted: false });

  let conn;
  try {
    conn = await getConn();

    const result = await conn.execute(
      `SELECT id FROM fq_scores
       WHERE username = :1 AND difficulty = :2
       AND ROWNUM = 1`,
      [username, difficulty],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    return res.json({ attempted: result.rows.length > 0 });

  } catch (err) {
    console.error('[CHECK ATTEMPT ERROR]', err.message);
    return res.json({ attempted: false });
  } finally {
    if (conn) await conn.close();
  }
});

// ── Serve index.html for all unmatched routes ───────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Start Server ────────────────────────────────────
testConnection().then(() => {
  app.listen(PORT, () => {
    console.log('');
    console.log('═══════════════════════════════════════');
    console.log(`🚀  FairQuiz running at http://localhost:${PORT}`);
    console.log('═══════════════════════════════════════');
    console.log('');
  });
});
