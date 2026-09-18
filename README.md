# 机械钟表擒纵调校API

纯后端零依赖Node服务，使用 `data/db.json` 持久化钟表档案、调校记录和复测记录。

## 启动

```bash
PORT=3021 node server.js
```

## 主要接口

- `GET /health`
- `GET /clocks`
- `POST /clocks`
- `GET /clocks/not-qualified`
- `GET /clocks/:id/history`
- `POST /clocks/:id/adjustments`
- `POST /clocks/:id/retests`
- `GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=`
- `GET /retests?clockId=&qualified=`
- `POST /retests/:id/corrections`
- `GET /retests/:id/corrections`
- `POST /corrections/:id/void`
- `GET /corrections?clockId=&retestId=`

## 复测更正闭环

复测录错后只能追加更正记录，原记录保留但不参与当前判断：

- 更正必须指向原始复测记录，并填全 `reason`（原因）、`dailyRateSeconds`（新日差）、`amplitude`（振幅）、`recordedBy`（记录人）；缺项或指向无效记录（含指向另一条更正）返回 409 且不落库。
- 同一原始复测可有多条更正，只有最后一条未作废的更正参与合格判断；更正之间不能互相更正。
- `POST /corrections/:id/void` 只能作废最后一条有效更正，作废后自动恢复前一条有效值（无更早更正则恢复原值）；作废记录保留，历史仍可查。
- `/retests`、`/clocks/:id/history`、`/clocks/:id/latest-retest`、`/clocks`、`/clocks/not-qualified` 均按有效值同步；被更正的复测带 `corrected: true` 和 `original` 原值。

## 闭环示例

```bash
curl http://127.0.0.1:3021/clocks/not-qualified
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":12,"amplitude":252,"note":"复测进入目标范围"}'
```

## 更正闭环示例

```bash
# 对录错的复测追加更正（缺项或指向无效记录返回 409）
curl -X POST http://127.0.0.1:3021/retests/retest_demo/corrections \
  -H 'Content-Type: application/json' \
  -d '{"reason":"日差录入错误","dailyRateSeconds":12,"amplitude":252,"recordedBy":"张三"}'

# 查看某条复测的全部更正（含已作废）
curl http://127.0.0.1:3021/retests/retest_demo/corrections

# 作废最后一条有效更正，自动恢复前一条有效值
curl -X POST http://127.0.0.1:3021/corrections/<correction_id>/void
```
