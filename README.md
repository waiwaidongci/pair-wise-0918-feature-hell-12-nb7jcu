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
- `POST /corrections/:id/void`
- `GET /corrections?clockId=&retestId=&status=`

## 更正闭环

复测录错后不能改原记录，只能追加更正：

- 更正必须指向原始复测，并填全 `reason`（原因）、`dailyRateSeconds`（新日差）、`amplitude`（振幅）、`recordedBy`（记录人）；缺项、数值非法、指向不存在的记录或指向另一条更正，均返回 409 且不落库。
- 原复测记录保留，但不再参与当前合格判断；同一复测有多条更正时只有最后一条生效。
- `POST /corrections/:id/void` 作废最后一条生效更正后，自动恢复前一条有效值（无更早更正则恢复原记录）；已作废记录仍可通过 `GET /corrections?status=voided` 查询。
- 复测列表、钟表历史和最新复测结论均按生效值输出，被更正的记录附带 `original` 原始值与 `correction` 生效更正。

```bash
# 对 retest_demo 追加更正
curl -X POST http://127.0.0.1:3021/retests/retest_demo/corrections \
  -H 'Content-Type: application/json' \
  -d '{"reason":"日差抄录错误","dailyRateSeconds":12,"amplitude":250,"recordedBy":"王师傅"}'

# 作废最后一条生效更正，恢复前一条有效值
curl -X POST http://127.0.0.1:3021/corrections/<correctionId>/void
```

## 闭环示例

```bash
curl http://127.0.0.1:3021/clocks/not-qualified
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":12,"amplitude":252,"note":"复测进入目标范围"}'
```
