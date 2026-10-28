# sese-ledger（瑟瑟台账）

入口：`index.ts`。

## 目录

- `core/`：账本存储、填表 SQL、剧情推进、投影、时光机、纪要合并、迁移
- `settings/panel/`：台账工作台各标签页
- `assets/`：标准模板与剧情召回预设

## 依赖

`sese-ledger` 依赖同级的 `../unified-statusbar`：

- `../unified-statusbar/core/server-file-store`
- `../unified-statusbar/core/silly-chat-metadata-host`
- `../unified-statusbar/core/events`
- `../unified-statusbar/core/worldbook-projection`
- `../unified-statusbar/docs/色色灵感数据库模板V3.3.4.json`

因此分享时必须保持 `sese-ledger/` 与 `unified-statusbar/` 同级。

## 说明

源码阅读副本未包含测试、内部设计文档、旧版打包产物与第三方正则资料。
