# REQ — 图片归档与折叠恢复（Image Archive）

**Issue**: https://github.com/ranxianglei/opencode-acp/issues/478
**Branch**: `2026-10-15_image-archive`
**Status**: in progress

## 背景 / Problem

ACP 会话中用户附带的图片（SDK `FilePart`, `mime: image/*`, `url: data:...`）随消息一起进入上下文。当包含图片的消息范围被 `compress` 折叠后：

1. 图片的原始字节随原消息一起从可见上下文中移除；
2. 折叠摘要里没有任何关于该图片的记录——模型不知道这里曾经有一张图；
3. 若 OpenCode 侧存储随后被原生 compaction 清理，字节永久丢失，`decompress` 也救不回来。

billion-context（同作者的 V2 包）已验证了正确的处理原理（#1995/#2607/#2640）：
**图片不参与摘要、不留在线上，而是提前落盘到宿主可读文件；折叠时把文件路径写进摘要，模型需要像素时用自己的 read 工具重新打开。**

## 方案（owner 已拍板：Option B）

移植 billion-context 的原理到 ACP 1.x 管线：

1. **Eager spill（每轮扫描）**：message-transform 钩子每轮扫描消息中的
   `image/*` data-URL FilePart，解码后写入
   `<storageDir>/images/<sessionDir>/<msgHash>-p<i>-<sha8>.<ext>`（0600）。
   以 raw message ID + part index + 内容哈希命名 → 内容寻址、幂等
   （skip-if-exists），ref 重编号不影响路径。
2. **元数据索引**：`state.imageArchive[rawMessageId] = [{path, mediaType, bytes}]`
   持久化进 session state（只存元数据，不存 base64）。
3. **折叠时注入指针**：range-mode compress 构建摘要时，在受保护附录链末尾追加
   "Images captured in this range were archived to disk..." 指针行，
   模型可按路径自行 read。
4. **TTL 清理**：默认 7 天，best-effort，绝不阻断请求。

### 明确不做（v1 范围外）

- **不做「主动下线未折叠的旧图」**：图片在折叠前保持原位（模型仍可直接看），
  token 释放发生在折叠时刻——与现状（静默丢失）同一时机但严格更好。
  提前下线会让模型在任务中途失去直接视觉，且 billion-context 有反面教训
  （sliding-window stripImages 破坏 prompt cache，已移除）。
- 不处理远程 http(s) URL 图片（无字节可落盘，无法保证可恢复性）。
- 不处理非 image/* mime。
- 不做到达时的有损降采样（那是 billion-context kernel #353 的另一功能域）。

## 配置

```jsonc
"compress": {
    "images": {
        "enabled": true,     // false = 完全回到现状（字节级等价）
        "minBytes": 16384,   // 小于此字节数的图不落盘（图标/emoji 级别）
        "ttlDays": 7         // 归档文件保留天数
    }
}
```

按 `reasoning` 配置模式实现（嵌套对象 + 默认常量 + merge/deepClone/validation/
schema 全链路）。**排除在 per-model override 级联之外**（磁盘副作用是
session 级的，按模型覆盖没有意义）。

## 验收标准

1. 含 ≥minBytes 图片的 data-URL FilePart 在下一轮 transform 后即落盘（0600），
   state 索引记录 path/mediaType/bytes；重复轮次不重复写盘。
2. 折叠包含该图的 range 后，block summary 末尾出现指针附录（含绝对路径）。
3. `enabled: false` 时行为与改动前字节级一致（无文件写入、无附录）。
4. < minBytes、非 image/*、非 data-URL 的 FilePart 一律跳过。
5. TTL 到期文件被清理，空目录删除，索引条目同步移除。
6. 任何 IO 失败只 warn 日志，绝不让 transform 管线抛错。
7. typecheck + build + 定向测试通过；全量回归交 CI。
