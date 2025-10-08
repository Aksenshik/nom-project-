import http from "http";
import crypto from "crypto";
import { Pool } from "pg";

// ---- Postgres pool (DATABASE_URL or individual vars) ----
const connectionString = process.env.DATABASE_URL;
const ssl =
  (process.env.PGSSL || "").toLowerCase() === "true"
    ? { rejectUnauthorized: false }
    : false;

const pool = new Pool(
  connectionString
    ? { connectionString, ssl }
    : {
        host: process.env.PGHOST,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE,
        port: Number(process.env.PGPORT) || 5432,
        ssl
      }
);

// ensure table exists
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS consumption_events (
      id        TEXT PRIMARY KEY,
      user_id   TEXT,
      ts        TIMESTAMPTZ NOT NULL,
      item      TEXT NOT NULL,
      amount    DOUBLE PRECISION NOT NULL,
      unit      TEXT NOT NULL CHECK (unit IN ('g','ml','piece','serving')),
      source    TEXT NOT NULL,
      calories  DOUBLE PRECISION,
      notes     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_user_ts ON consumption_events(user_id, ts);
  `);
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET"
  });
  res.end(body);
}

const tools = {
  // Insert many events
  async log_consumption(input) {
    const events = Array.isArray(input?.events) ? input.events : [];
    if (!events.length) return { saved_count: 0 };

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const sql = `
        INSERT INTO consumption_events
          (id, user_id, ts, item, amount, unit, source, calories, notes)
        VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (id) DO UPDATE SET
          user_id=EXCLUDED.user_id,
          ts=EXCLUDED.ts,
          item=EXCLUDED.item,
          amount=EXCLUDED.amount,
          unit=EXCLUDED.unit,
          source=EXCLUDED.source,
          calories=EXCLUDED.calories,
          notes=EXCLUDED.notes
      `;
      for (const e of events) {
        if (!e.timestamp || !e.item || typeof e.amount !== "number" || !e.unit) {
          throw new Error("Invalid event");
        }
        const id = e.id || crypto.randomUUID();
        const userId = e.user_id || "u1";
        await client.query(sql, [
          id,
          userId,
          new Date(e.timestamp),
          e.item,
          e.amount,
          e.unit,
          e.source || "manual",
          e.calories ?? null,
          e.notes ?? null
        ]);
      }
      await client.query("COMMIT");
      return { saved_count: events.length };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  },

  // List by user and optional date range (YYYY-MM-DD)
  async list_consumption(input) {
    const { user_id, from, to } = input || {};
    const where = [];
    const args = [];
    if (user_id) { where.push(`user_id = $${args.length + 1}`); args.push(user_id); }
    if (from)    { where.push(`DATE(ts) >= $${args.length + 1}`); args.push(from); }
    if (to)      { where.push(`DATE(ts) <= $${args.length + 1}`); args.push(to); }

    const { rows } = await pool.query(
      `
      SELECT id, user_id, ts, item, amount, unit, source, calories, notes
      FROM consumption_events
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY ts ASC
      `,
      args
    );

    const events = rows.map(r => ({
      id: r.id,
      user_id: r.user_id,
      timestamp: r.ts.toISOString(),
      item: r.item,
      amount: r.amount,
      unit: r.unit,
      source: r.source,
      calories: r.calories ?? undefined,
      notes: r.notes ?? undefined
    }));

    return { events };
  },

  // Aggregate calories & count
  async summarize_intake(input) {
    const { user_id, from, to } = input || {};
    const where = [];
    const args = [];
    if (user_id) { where.push(`user_id = $${args.length + 1}`); args.push(user_id); }
    if (from)    { where.push(`DATE(ts) >= $${args.length + 1}`); args.push(from); }
    if (to)      { where.push(`DATE(ts) <= $${args.length + 1}`); args.push(to); }

    const { rows } = await pool.query(
      `
      SELECT
        COALESCE(SUM(calories), 0) AS total_calories,
        COUNT(*) AS events_count
      FROM consumption_events
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      `,
      args
    );
    const r = rows[0] || { total_calories: 0, events_count: 0 };
    return {
      total_calories: Number(r.total_calories || 0),
      events_count: Number(r.events_count || 0)
    };
  }
};

const httpServer = http.createServer(async (req, res) => {
  // Healthcheck
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("OK");
  }
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS, GET"
    });
    return res.end();
  }
  // API
  if (req.method === "POST") {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", async () => {
      try {
        await ensureSchema(); // idempotent
        const payload = JSON.parse(body || "{}");
        const name = payload?.tool;
        const input = payload?.input;
        if (!name || !(name in tools)) {
          return sendJson(res, 400, { error: "Unknown or missing tool" });
        }
        const data = await tools[name](input);
        return sendJson(res, 200, data);
      } catch (e) {
        return sendJson(res, 400, { error: String(e.message || e) });
      }
    });
    return;
  }
  sendJson(res, 404, { error: "Not found" });
});

const port = Number(process.env.PORT) || 34115;
httpServer.listen(port, "0.0.0.0", () =>
  console.log(`HTTP server + Postgres on http://0.0.0.0:${port}`)
);
