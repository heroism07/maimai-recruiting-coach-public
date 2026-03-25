# Legacy Scripts 归档说明

更新时间：2026-03-24

## 目的

`scripts/legacy/` 用于存放 `maintenance/deprecated` 脚本实现，降低主目录复杂度。

## 兼容策略

1. 主目录保留同名 wrapper 文件。
2. 旧命令无需修改，仍可通过原路径调用。
3. 新增或改动维护脚本时，优先修改 `legacy/` 下实现文件。

## 当前归档范围

- `run-online-filter-cycle.js`
- `run-online-candidate-capture.js`
- `run-memory-workflow.js`
- `capture-maimai-auth-state.js`
- `backfill-candidate-attachments.js`
- `upgrade-filter-table-v2.js`
- `prune-filter-table-fields.js`
- `migrate-filter-table-schema.js`

## 治理约束

1. 脚本状态以 `script-registry.json` 为准。
2. `deprecated` 脚本不得新增生产入口命令。
3. 提交前执行 `npm run skill:audit:scripts`。
