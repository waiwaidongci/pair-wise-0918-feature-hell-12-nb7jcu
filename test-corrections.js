const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = 3399;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(os.tmpdir(), `clock-test-${Date.now()}.json`);

let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ok - ${name}`);
  } else {
    failed++;
    console.log(`  FAIL - ${name}${extra !== undefined ? ` | got: ${JSON.stringify(extra)}` : ""}`);
  }
}

async function api(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}

async function main() {
  const server = spawn("node", [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(PORT), DB_FILE },
    stdio: "inherit"
  });
  try {
    await waitUp();

    console.log("1. 初始状态：demo 复测 31s 不合格");
    let r = await api("GET", "/clocks/clock_demo/latest-retest");
    check("latest-retest 原值 31", r.body.data.dailyRateSeconds === 31 && r.body.data.qualified === false, r.body.data);
    check("corrected 标记为 false", r.body.data.corrected === false);

    console.log("2. 缺项更正 -> 409 且不落库");
    r = await api("POST", "/retests/retest_demo/corrections", { reason: "录错", dailyRateSeconds: 12 });
    check("缺 amplitude/recordedBy 返回 409", r.status === 409, r.status);
    r = await api("POST", "/retests/retest_demo/corrections", { reason: "", dailyRateSeconds: 12, amplitude: 250, recordedBy: "张三" });
    check("空 reason 返回 409", r.status === 409, r.status);
    r = await api("GET", "/corrections?retestId=retest_demo");
    check("失败后不落库", r.body.data.length === 0, r.body.data);
    r = await api("GET", "/clocks/clock_demo/latest-retest");
    check("latest-retest 仍是原值", r.body.data.dailyRateSeconds === 31 && r.body.data.corrected === false, r.body.data);

    console.log("3. 指向无效记录 -> 409");
    r = await api("POST", "/retests/retest_ghost/corrections", { reason: "录错", dailyRateSeconds: 12, amplitude: 250, recordedBy: "张三" });
    check("不存在的复测返回 409", r.status === 409, r.status);

    console.log("4. 合法更正 -> 201，各视图同步为新值");
    r = await api("POST", "/retests/retest_demo/corrections", { reason: "日差录入错误", dailyRateSeconds: 12, amplitude: 252, recordedBy: "张三" });
    check("创建成功 201", r.status === 201, r.status);
    const c1 = r.body.data;
    check("更正按目标重新判定合格", c1.qualified === true, c1);
    r = await api("GET", "/clocks/clock_demo/latest-retest");
    check("latest-retest 生效新值且合格", r.body.data.dailyRateSeconds === 12 && r.body.data.amplitude === 252 && r.body.data.qualified === true, r.body.data);
    check("保留原值 original", r.body.data.original && r.body.data.original.dailyRateSeconds === 31, r.body.data);
    r = await api("GET", "/clocks");
    check("/clocks qualified 同步为 true", r.body.data[0].qualified === true, r.body.data[0].qualified);
    r = await api("GET", "/clocks/not-qualified");
    check("not-qualified 列表已移除", r.body.data.length === 0, r.body.data);
    r = await api("GET", "/retests?clockId=clock_demo&qualified=true");
    check("/retests 按有效值过滤", r.body.data.length === 1 && r.body.data[0].dailyRateSeconds === 12, r.body.data);
    r = await api("GET", "/clocks/clock_demo/history");
    check("history 中复测为有效值且带更正记录", r.body.data.retests[0].dailyRateSeconds === 12 && r.body.data.retests[0].corrections.length === 1, r.body.data.retests[0]);

    console.log("5. 更正不能指向另一条更正 -> 409");
    r = await api("POST", `/retests/${c1.id}/corrections`, { reason: "二次更正", dailyRateSeconds: 5, amplitude: 260, recordedBy: "李四" });
    check("指向更正返回 409", r.status === 409, r.status);

    console.log("6. 同一原始复测第二条更正 -> 只认最后一条");
    r = await api("POST", "/retests/retest_demo/corrections", { reason: "振幅也录错了", dailyRateSeconds: 25, amplitude: 240, recordedBy: "李四" });
    check("第二条更正 201", r.status === 201, r.status);
    const c2 = r.body.data;
    check("第二条按目标判定不合格", c2.qualified === false, c2);
    r = await api("GET", "/clocks/clock_demo/latest-retest");
    check("latest-retest 只认最后一条", r.body.data.dailyRateSeconds === 25 && r.body.data.qualified === false, r.body.data);
    r = await api("GET", "/clocks/not-qualified");
    check("not-qualified 列表同步拉回", r.body.data.length === 1, r.body.data);

    console.log("7. 作废非最后一条 -> 409");
    r = await api("POST", `/corrections/${c1.id}/void`);
    check("作废旧更正返回 409", r.status === 409, r.status);

    console.log("8. 作废最后一条 -> 恢复前一条有效值");
    r = await api("POST", `/corrections/${c2.id}/void`);
    check("作废成功 200", r.status === 200, r.status);
    check("返回体即恢复前一条", r.body.retest.dailyRateSeconds === 12 && r.body.retest.qualified === true, r.body.retest);
    r = await api("GET", "/clocks/clock_demo/latest-retest");
    check("latest-retest 恢复为 12", r.body.data.dailyRateSeconds === 12 && r.body.data.qualified === true, r.body.data);
    r = await api("GET", "/retests/retest_demo/corrections");
    check("作废记录历史仍可查", r.body.data.length === 2 && r.body.data.find((c) => c.id === c2.id).voided === true, r.body.data);
    r = await api("GET", "/clocks/clock_demo/history");
    check("history 顶层 corrections 含作废记录", r.body.data.corrections.length === 2, r.body.data.corrections);

    console.log("9. 重复作废 -> 409；再作废第一条 -> 恢复原值");
    r = await api("POST", `/corrections/${c2.id}/void`);
    check("重复作废返回 409", r.status === 409, r.status);
    r = await api("POST", `/corrections/${c1.id}/void`);
    check("作废第一条 200", r.status === 200, r.status);
    r = await api("GET", "/clocks/clock_demo/latest-retest");
    check("全部作废后恢复原始值 31 且不合格", r.body.data.dailyRateSeconds === 31 && r.body.data.qualified === false && r.body.data.corrected === false, r.body.data);
    r = await api("GET", "/clocks/not-qualified");
    check("not-qualified 同步恢复", r.body.data.length === 1, r.body.data);
    r = await api("GET", "/retests?clockId=clock_demo&qualified=false");
    check("/retests 过滤同步恢复", r.body.data.length === 1 && r.body.data[0].dailyRateSeconds === 31, r.body.data);

    console.log("10. 不存在的更正作废 -> 404；不存在的复测查更正 -> 404");
    r = await api("POST", "/corrections/correction_ghost/void");
    check("作废不存在更正 404", r.status === 404, r.status);
    r = await api("GET", "/retests/retest_ghost/corrections");
    check("查不存在复测的更正 404", r.status === 404, r.status);
  } finally {
    server.kill();
    fs.rmSync(DB_FILE, { force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
