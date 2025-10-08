import http from "http";
import crypto from "crypto";

const db = []; // временное хранилище в памяти

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
  async log_consumption(input) {
    const events = Array.isArray(input?.events) ? input.events : [];
    for (const e of events) {
      if (!e.timestamp || !e.item || typeof e.amount !== "number" || !e.unit) {
        throw new Error("Invalid event");
      }
      db.push({
        id: crypto.randomUUID(),
        user_id: e.user_id || "u1",
        timestamp: e.timestamp,
        item: e.item,
        amount: e.amount,
        unit: e.unit,
        source: e.source || "manual",
        calories: e.calories ?? null
      });
    }
    return { saved_count: events.length };
  },

  async list_consumption(input) {
    const { user_id, from, to } = input || {};
    const iso = s => (s || "").slice(0, 10);
    const events = db.filter(e => {
      if (user_id && e.user_id !== user_id) return false;
      const d = iso(e.timestamp);
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
    return { events };
  },

  async summarize_intake(input) {
    const { user_id, from, to } = input || {};
    const { events } = await this.list_consumption({ user_id, from, to });
    const total = events.reduce((s, e) => s + (e.calories || 0), 0);
    return { total_calories: total, events_count: events.length };
  }
};

const server = http.createServer(async (req, res) => {
  // Healthcheck (Render будет счастлив)
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
    req.on("data", chunk => (body += chunk));
    req.on("end", async () => {
      try {
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
server.listen(port, "0.0.0.0", () =>
  console.log(`HTTP server listening on http://0.0.0.0:${port}`)
);

      
