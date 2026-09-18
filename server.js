const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3021);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "data", "db.json");

const initialData = {
  clocks: [
    {
      id: "clock_demo",
      code: "CLK-1890-07",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds: 20,
      note: "怀表机芯，走时偏快",
      createdAt: new Date().toISOString()
    }
  ],
  adjustments: [
    {
      id: "adjustment_demo",
      clockId: "clock_demo",
      currentDailyRateSeconds: 68,
      direction: "慢针方向",
      amount: "游丝快慢针向慢侧微调0.4格",
      note: "初次调校，先保守处理",
      createdAt: new Date().toISOString()
    }
  ],
  retests: [
    {
      id: "retest_demo",
      clockId: "clock_demo",
      adjustmentId: "adjustment_demo",
      testedAt: new Date().toISOString(),
      dailyRateSeconds: 31,
      amplitude: 248,
      qualified: false,
      note: "仍偏快，振幅尚可"
    }
  ],
  corrections: []
};

const routes = [
  "GET /health",
  "GET /clocks",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /clocks/:id/history",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/retests",
  "GET /clocks/:id/latest-retest",
  "GET /adjustments",
  "GET /retests",
  "POST /retests/:id/corrections",
  "GET /retests/:id/corrections",
  "POST /corrections/:id/void",
  "GET /corrections"
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  const db = JSON.parse(await readFile(DB_FILE, "utf8"));
  if (!Array.isArray(db.corrections)) db.corrections = [];
  return db;
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) {
    const error = new Error("钟表不存在");
    error.status = 404;
    throw error;
  }
  return clock;
}

function conflict(message) {
  const error = new Error(message);
  error.status = 409;
  throw error;
}

function correctionsFor(db, retestId) {
  return db.corrections
    .filter((item) => item.retestId === retestId)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

// 原记录保留但不参与当前判断：有效值取最后一条未作废更正，无更正则用原值
function effectiveRetest(db, retest) {
  const corrections = correctionsFor(db, retest.id);
  const active = corrections.filter((item) => !item.voided);
  const last = active[active.length - 1];
  if (!last) return { ...retest, corrected: false, corrections };
  return {
    ...retest,
    dailyRateSeconds: last.dailyRateSeconds,
    amplitude: last.amplitude,
    qualified: last.qualified,
    corrected: true,
    original: {
      dailyRateSeconds: retest.dailyRateSeconds,
      amplitude: retest.amplitude,
      qualified: retest.qualified
    },
    corrections
  };
}

function latestRetest(db, clockId) {
  const retest = db.retests
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0] || null;
  return retest ? effectiveRetest(db, retest) : null;
}

function latestAdjustment(db, clockId) {
  return db.adjustments
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function clockSummary(db, clock) {
  const retest = latestRetest(db, clock.id);
  const adjustment = latestAdjustment(db, clock.id);
  return {
    ...clock,
    latestAdjustment: adjustment,
    latestRetest: retest,
    qualified: retest ? retest.qualified : false
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "clock-escapement-tuning-api", routes });
  }

  if (req.method === "GET" && pathname === "/clocks") {
    const qualified = url.searchParams.get("qualified");
    let data = db.clocks.map((clock) => clockSummary(db, clock));
    if (qualified !== null) {
      const expected = qualified === "true";
      data = data.filter((clock) => clock.qualified === expected);
    }
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/clocks") {
    const body = await parseBody(req);
    required(body, ["code", "escapementType", "balanceFrequency"]);
    const clock = {
      id: makeId("clock"),
      code: body.code,
      escapementType: body.escapementType,
      balanceFrequency: body.balanceFrequency,
      targetDailyRateSeconds: Number(body.targetDailyRateSeconds ?? 30),
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.clocks.push(clock);
    await writeDb(db);
    return send(res, 201, { data: clockSummary(db, clock) });
  }

  if (req.method === "GET" && pathname === "/clocks/not-qualified") {
    const data = db.clocks.map((clock) => clockSummary(db, clock)).filter((clock) => !clock.qualified);
    return send(res, 200, { data });
  }

  const historyMatch = pathname.match(/^\/clocks\/([^/]+)\/history$/);
  if (historyMatch && req.method === "GET") {
    const clock = findClock(db, historyMatch[1]);
    const adjustments = db.adjustments.filter((item) => item.clockId === clock.id);
    const retests = db.retests
      .filter((item) => item.clockId === clock.id)
      .map((item) => effectiveRetest(db, item));
    const corrections = db.corrections.filter((item) => item.clockId === clock.id);
    return send(res, 200, { data: { clock, adjustments, retests, corrections, latestRetest: latestRetest(db, clock.id) } });
  }

  const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (adjustmentMatch && req.method === "POST") {
    const clock = findClock(db, adjustmentMatch[1]);
    const body = await parseBody(req);
    required(body, ["currentDailyRateSeconds", "direction", "amount"]);
    const adjustment = {
      id: makeId("adjustment"),
      clockId: clock.id,
      currentDailyRateSeconds: Number(body.currentDailyRateSeconds),
      direction: body.direction,
      amount: body.amount,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.adjustments.push(adjustment);
    await writeDb(db);
    return send(res, 201, { data: adjustment });
  }

  const retestMatch = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
  if (retestMatch && req.method === "POST") {
    const clock = findClock(db, retestMatch[1]);
    const body = await parseBody(req);
    required(body, ["dailyRateSeconds", "amplitude"]);
    const adjustmentId = body.adjustmentId || latestAdjustment(db, clock.id)?.id || null;
    const qualified = body.qualified !== undefined
      ? Boolean(body.qualified)
      : Math.abs(Number(body.dailyRateSeconds)) <= Number(clock.targetDailyRateSeconds);
    const retest = {
      id: makeId("retest"),
      clockId: clock.id,
      adjustmentId,
      testedAt: body.testedAt || new Date().toISOString(),
      dailyRateSeconds: Number(body.dailyRateSeconds),
      amplitude: Number(body.amplitude),
      qualified,
      note: body.note || ""
    };
    db.retests.push(retest);
    await writeDb(db);
    return send(res, 201, { data: retest, clock: clockSummary(db, clock) });
  }

  const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (latestMatch && req.method === "GET") {
    findClock(db, latestMatch[1]);
    return send(res, 200, { data: latestRetest(db, latestMatch[1]) });
  }

  if (req.method === "GET" && pathname === "/adjustments") {
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/retests") {
    const clockId = url.searchParams.get("clockId");
    const qualified = url.searchParams.get("qualified");
    const data = db.retests
      .map((item) => effectiveRetest(db, item))
      .filter((item) => {
        const matchClock = !clockId || item.clockId === clockId;
        const matchQualified = qualified === null || item.qualified === (qualified === "true");
        return matchClock && matchQualified;
      });
    return send(res, 200, { data });
  }

  const correctionMatch = pathname.match(/^\/retests\/([^/]+)\/corrections$/);
  if (correctionMatch && req.method === "POST") {
    const body = await parseBody(req);
    const retestId = correctionMatch[1];
    const retest = db.retests.find((item) => item.id === retestId);
    if (!retest) {
      if (db.corrections.some((item) => item.id === retestId)) {
        conflict("更正不能指向另一条更正，必须指向原始复测记录");
      }
      conflict("指向的原始复测记录不存在");
    }
    const missing = ["reason", "dailyRateSeconds", "amplitude", "recordedBy"].filter(
      (field) => body[field] === undefined || body[field] === ""
    );
    if (missing.length) conflict(`缺少字段：${missing.join(", ")}`);
    const dailyRateSeconds = Number(body.dailyRateSeconds);
    const amplitude = Number(body.amplitude);
    if (!Number.isFinite(dailyRateSeconds) || !Number.isFinite(amplitude)) {
      conflict("新日差和振幅必须是数字");
    }
    const clock = findClock(db, retest.clockId);
    const correction = {
      id: makeId("correction"),
      retestId: retest.id,
      clockId: retest.clockId,
      reason: body.reason,
      dailyRateSeconds,
      amplitude,
      qualified: body.qualified !== undefined
        ? Boolean(body.qualified)
        : Math.abs(dailyRateSeconds) <= Number(clock.targetDailyRateSeconds),
      recordedBy: body.recordedBy,
      voided: false,
      createdAt: new Date().toISOString(),
      voidedAt: null
    };
    db.corrections.push(correction);
    await writeDb(db);
    return send(res, 201, { data: correction, retest: effectiveRetest(db, retest), clock: clockSummary(db, clock) });
  }

  if (correctionMatch && req.method === "GET") {
    const retest = db.retests.find((item) => item.id === correctionMatch[1]);
    if (!retest) return send(res, 404, { error: "复测记录不存在" });
    return send(res, 200, { data: correctionsFor(db, retest.id) });
  }

  const voidMatch = pathname.match(/^\/corrections\/([^/]+)\/void$/);
  if (voidMatch && req.method === "POST") {
    const correction = db.corrections.find((item) => item.id === voidMatch[1]);
    if (!correction) return send(res, 404, { error: "更正记录不存在" });
    if (correction.voided) conflict("该更正已作废");
    const active = correctionsFor(db, correction.retestId).filter((item) => !item.voided);
    const last = active[active.length - 1];
    if (!last || last.id !== correction.id) conflict("只能作废最后一条有效更正");
    correction.voided = true;
    correction.voidedAt = new Date().toISOString();
    await writeDb(db);
    const retest = db.retests.find((item) => item.id === correction.retestId);
    const clock = findClock(db, retest.clockId);
    return send(res, 200, { data: correction, retest: effectiveRetest(db, retest), clock: clockSummary(db, clock) });
  }

  if (req.method === "GET" && pathname === "/corrections") {
    const clockId = url.searchParams.get("clockId");
    const retestId = url.searchParams.get("retestId");
    const data = db.corrections.filter((item) => {
      const matchClock = !clockId || item.clockId === clockId;
      const matchRetest = !retestId || item.retestId === retestId;
      return matchClock && matchRetest;
    });
    return send(res, 200, { data });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Clock escapement tuning API running at http://127.0.0.1:${PORT}`);
});
