import { Server } from "@modelcontextprotocol/sdk/server";
import Ajv from "ajv";
import { customAlphabet } from "nanoid";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);
const db = [];

const schema = {
  type: "object",
  required: ["timestamp", "item", "amount", "unit", "source"],
  properties: {
    id: { type: "string" },
    user_id: { type: "string" },
    timestamp: { type: "string" },
    item: { type: "string" },
    amount: { type: "number" },
    unit: { type: "string", enum: ["g", "ml", "piece", "serving"] },
    source: { type: "string" }
  }
};

const ajv = new Ajv({ strict: false });
const validate = ajv.compile(schema);

const iso = s => s.slice(0, 10);
function list(uid, from, to) {
  return db.filter(e => {
    if (uid && e.user_id !== uid) return false;
    const d = iso(e.timestamp);
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });
}

const server = new Server({
  name: "NOM Nutrition MCP",
  version: "0.1.0",
  resources: [
    {
      name: "consumption-events",
      uriTemplate: "mcp://consumption/events/{userId}/{date}",
      handler: async ({ params }) => {
        const { userId, date } = params;
        const events = list(userId, date, date);
        return {
          ok: true,
          mimeType: "application/json",
          body: JSON.stringify({ user_id: userId, date, events }, null, 2)
        };
      }
    }
  ]
});

server.tool("log_consumption", {
  description: "Сохраняет события потребления",
  inputSchema: {
    type: "object",
    properties: { events: { type: "array", items: schema, minItems: 1 } },
    required: ["events"]
  },
  outputSchema: { type: "object", properties: { saved_count: { type: "integer" } } },
  handler: async ({ input, user }) => {
    const uid = user?.id || "u1";
    input.events.forEach(e => {
      if (!validate(e)) throw new Error("Invalid event");
      e.id = e.id || nanoid();
      e.user_id = e.user_id || uid;
      db.push(e);
    });
    return { saved_count: input.events.length };
  }
});

server.tool("list_consumption", {
  description: "Показывает события за период",
  inputSchema: {
    type: "object",
    properties: { user_id: { type: "string" }, from: { type: "string" }, to: { type: "string" } }
  },
  outputSchema: { type: "object", properties: { events: { type: "array", items: schema } } },
  handler: async ({ input }) => ({ events: list(input.user_id, input.from, input.to) })
});

server.tool("summarize_intake", {
  description: "Суммирует калории за период",
  inputSchema: {
    type: "object",
    properties: { user_id: { type: "string" }, from: { type: "string" }, to: { type: "string" } }
  },
  outputSchema: {
    type: "object",
    properties: {
      total_calories: { type: "number" },
      events_count: { type: "integer" }
    }
  },
  handler: async ({ input }) => {
    const ev = list(input.user_id, input.from, input.to);
    const total = ev.reduce((sum, e) => sum + (e.calories ?? 0), 0);
    return { total_calories: total, events_count: ev.length };
  }
});

const port = process.env.PORT || 34115;
server.listen({ port }).then(() => console.log(`MCP server on ${port}`));
