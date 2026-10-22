# 0002 设备间加密使用 libsodium，不自创协议

- 状态：提议
- 日期：2026-10-23
- 关联：B27、B28；`docs/c0/design/remote-control.md` §4

## 背景

规格要求群聊、私信、小文档只有可信设备能解密，官方中转只见密文；架构 11 要求「复用成熟加密实现，不自创协议」。

## 决定

- 使用 libsodium（Node 绑定 `sodium-native`，ISC 许可）。
- 设备签名：`crypto_sign`（Ed25519）。设备加密：X25519，`crypto_box_seal` 封装项目内容密钥。
- 内容：`crypto_secretstream_xchacha20poly1305`。
- 私钥存 Electron `safeStorage`（Windows DPAPI / macOS Keychain）。
- 首发设备数少，用「项目密钥 + 逐设备封装」；撤销设备时轮换项目密钥。设备数增长后再评估 MLS（RFC 9420）。

## 后果

- 好：成熟、审计过的原语；跨平台二进制可用。
- 坏：原生模块需要为 Windows x64 与 macOS arm64 分别打包（electron-rebuild）；撤销只保护新内容，旧内容无法收回，UI 必须说明。

## 考虑过的其他方案

- Node 内置 `crypto`：原语齐全，但组合方式需要自己设计，出错面更大。
- 直接用 Paseo relay 的加密：只覆盖传输，不覆盖我们的领域内容和备份恢复。
- MLS：首发规模下复杂度过高。
