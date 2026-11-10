# Codex 0.167.0 兼容性检查卡

- 日期：2026-11-10T01:30:42.591Z
- initialize 握手：通过
- adapter / transport 契约：通过
- 结论：已验证，建议版本门上界改为 <0.167.1
- 付费模型调用：无；账号读取：无。

```json
{
  "handshake": {
    "schemaVersion": 1,
    "ok": true,
    "startedAt": "2026-11-10T01:30:40.320Z",
    "finishedAt": "2026-11-10T01:30:40.540Z",
    "binary": "/home/runner/work/_temp/codex-latest/node_modules/.bin/codex",
    "version": "0.167.0",
    "userAgent": "ahastation-compat/0.167.0 (Ubuntu 26.4.0; x86_64) unknown (ahastation-compat; 1)",
    "methods": [
      "initialize",
      "initialized"
    ],
    "modelTurn": false,
    "accountRead": false
  },
  "contractPassed": true
}
```
