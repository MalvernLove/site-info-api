# site-info-api

使用方法示例：

```
https://your-domain/api/v1?url=https://xaoxuu.com
> 例如: https://site-info-api.vercel.app/api/v1?url=https://xaoxuu.com
```

如果需要配置到 Stellar 主题中，写法就是：

```yaml
api: https://your-domain/api/v1?url=${href}
```

## 支持 Vercel 部署

1. fork 本仓库
2. 打开 vercel.com，部署该项目
3. 进入 Environment Variables 页面，设置 HOSTS 如下：

| Key | Value |
| :-- | :-- |
| HOSTS | `localhost, xaoxuu.com` |

> 把示例中的最后一个修改为自己网站的 host 部分。
> 逗号分隔，多个 host 之间用英文逗号隔开。

> Node.js 版本由 package.json 的 `engines` 控制（当前为 24.x），部署时 Vercel 会自动使用。

### 可选环境变量

| Key | 默认值 | 说明 |
| :-- | :-- | :-- |
| ALLOW_EMPTY_REFERER | 关闭 | 设为 `1` 允许不带 Referrer 的请求 |
| ALLOW_PRIVATE_HOSTS | 关闭 | 设为 `1` 允许抓取本机/内网地址，仅建议在可信的自部署环境开启 |
| ALLOWED_PORTS | `80, 443` | 允许的端口，逗号分隔；`*` 表示任意端口 |
| REQUEST_TIMEOUT_MS | `5000` | 单次请求整体超时（毫秒） |
| MAX_REDIRECTS | `5` | 最大重定向次数 |
| MAX_RESPONSE_BYTES | `1048576` | 响应体大小上限（字节） |
| CACHE_TTL_MS | `3600000` | 内存缓存有效期（毫秒），`0` 表示不缓存 |
| MAX_CACHE_ENTRIES | `200` | 内存缓存条目上限 |

## 行为与安全说明

- 仅允许 `http://` 和 `https://`，默认端口限定 80/443（可用 `ALLOWED_PORTS` 调整），URL 中不允许携带账号密码。
- 默认阻止 `localhost`、`.local`、`.internal` 以及内网/回环/链路本地地址，DNS 解析结果也会逐地址校验；每个重定向跳转都会重新校验。
- 最多跟随 5 次重定向，存在跳转死循环时直接返回错误。
- 请求 5 秒超时，响应体超过 1 MiB 会中断。
- 成功响应通过 `Vercel-CDN-Cache-Control` 缓存 7 天；错误响应返回对应的 4xx/5xx 状态码且不缓存。
- Referrer 校验失败返回 403；默认拒绝空 Referrer，如需放行设置 `ALLOW_EMPTY_REFERER=1`。

## 图标解析

- `icon` 返回默认图标的绝对 URL，按以下顺序选择首个有效地址：`apple-touch-icon` → `apple-touch-icon-precomposed` → `icon`（含 `shortcut icon`）→ `mask-icon` → `og:image` → `og:image:url` → `twitter:image` → `twitter:image:src` → `msapplication-TileImage`。
- 同类候选按页面顺序尝试，空地址、纯片段、非法 URL、非 HTTP(S) 地址及包含账号密码的地址会跳过。`rel` 按空白分词匹配，不区分大小写；元数据支持 `property` 和 `name`。
- `favicon`：已声明且 URL 路径文件名为 `favicon.ico`（忽略查询参数）→ `32x32` → `48x48` → `16x16` → `180x180` → `192x192` → 链接兜底。
- `appicon`：`192x192` → `180x180` → `512x512` → `48x48` → `32x32` → `16x16` → 链接兜底。
- `favicon` 和 `appicon` 的链接兜底优先选择页面中第一个普通 `icon` 或 Apple 图标，再选择其他 `rel` 包含 `icon` 的链接。只要存在有效的非遮罩图标，`mask-icon` 就不参与文件名、尺寸或链接选择；仅在没有其他图标时使用。
- 图标集合仅内部使用，不返回 `icons`。尺寸匹配使用声明的 `sizes`，支持空白分隔的多个尺寸及大写 `X`；不猜测实际尺寸，同优先级按页面顺序选择。`any` 或未声明尺寸的图标可通过最后的链接兜底选中。
- 相对路径使用重定向后的页面 URL 和有效的 `<base href>` 解析。
- 分享预览图只用于 `icon` 兜底，不用于 `favicon` 和 `appicon`。没有有效候选时省略对应字段。
- 当前仅解析 HTML 声明，不下载图标检查可访问性，不读取 manifest，也不将未声明的 `/favicon.ico` 当作已找到的图标。
