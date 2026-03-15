# CLI-CREATOR — 适配器开发完全指南

> 本文档教你（或 AI Agent）如何为 OpenCLI 添加一个新网站的命令。  
> 从零到发布，覆盖 API 发现、方案选择、适配器编写、测试验证全流程。

## 核心流程

```
 ┌─────────────┐     ┌─────────────┐     ┌──────────────┐     ┌────────┐
 │ 1. 发现 API  │ ──▶ │ 2. 选择策略  │ ──▶ │ 3. 写适配器   │ ──▶ │ 4. 测试 │
 └─────────────┘     └─────────────┘     └──────────────┘     └────────┘
   explore             cascade             YAML / TS            run + verify
```

---

## Step 1: 发现 API

### 1a. 自动化发现（推荐）

OpenCLI 内置 Deep Explore，自动分析网站网络请求：

```bash
opencli explore https://www.example.com --site mysite
```

输出到 `.opencli/explore/mysite/`：

| 文件 | 内容 |
|------|------|
| `manifest.json` | 站点元数据、框架检测（Vue2/3、React、Next.js、Pinia、Vuex） |
| `endpoints.json` | 已发现的 API 端点，按评分排序，含 URL pattern、方法、响应类型 |
| `capabilities.json` | 推理出的功能（`hot`、`search`、`feed`…），含置信度和推荐参数 |
| `auth.json` | 认证方式检测（Cookie/Header/无认证），策略候选列表 |

### 1b. 手动抓包验证

Explore 的自动分析可能不完美，用 verbose 模式手动确认：

```bash
# 在浏览器中打开目标页面，观察网络请求
opencli explore https://www.example.com --site mysite -v

# 或直接用 evaluate 测试 API
opencli bilibili hot -v   # 查看已有命令的 pipeline 每步数据流
```

关注抓包结果中的关键信息：
- **URL pattern**: `/api/v2/hot?limit=20` → 这就是你要调用的端点
- **Method**: `GET` / `POST`
- **Request Headers**: Cookie? Bearer? 自定义签名头（X-s、X-t）?
- **Response Body**: JSON 结构，特别是数据在哪个路径（`data.items`、`data.list`）

### 1c. 高阶 API 发现捷径法则 (Heuristics)

在开始死磕复杂的抓包拦截之前，按照以下优先级进行尝试：

1. **后缀爆破法 (`.json`)**: 像 Reddit 这样复杂的网站，只要在其 URL 后加上 `.json`（例如 `/r/all.json`），就能在带 Cookie 的情况下直接利用 `fetch` 拿到极其干净的 REST 数据（Tier 2 Cookie 策略极速秒杀）。
2. **全局状态查找法 (`__INITIAL_STATE__`)**: 许多服务端渲染 (SSR) 的网站（如小红书、Bilibili）会将首页或详情页的完整数据挂载到全局 window 对象上。与其去拦截网络请求，不如直接 `page.evaluate('() => window.__INITIAL_STATE__')` 获取整个数据树。
3. **框架探测与 Store Action 截断**: 如果站点使用 Vue + Pinia，可以使用 `tap` 步骤调用 action，让前端框架代替你完成复杂的鉴权签名封装。
4. **底层 XHR/Fetch 拦截**: 最后手段，当上述都不行时，使用 TypeScript 适配器进行无侵入式的请求抓取。

### 1d. 框架检测

Explore 自动检测前端框架。如果需要手动确认：

```bash
# 在已打开目标网站的情况下
opencli evaluate "(()=>{
  const vue3 = !!document.querySelector('#app')?.__vue_app__;
  const vue2 = !!document.querySelector('#app')?.__vue__;
  const react = !!window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const pinia = vue3 && !!document.querySelector('#app').__vue_app__.config.globalProperties.\$pinia;
  return JSON.stringify({vue3, vue2, react, pinia});
})()"
```

Vue + Pinia 的站点（如小红书）可以直接通过 Store Action 绕过签名。

---

## Step 2: 选择认证策略

OpenCLI 提供 5 级认证策略。使用 `cascade` 命令自动探测：

```bash
opencli cascade https://api.example.com/hot
```

### 策略决策树

```
直接 fetch(url) 能拿到数据？
  → ✅ Tier 1: public（公开 API，不需要浏览器）
  → ❌ fetch(url, {credentials:'include'}) 带 Cookie 能拿到？
       → ✅ Tier 2: cookie（最常见，evaluate 步骤内 fetch）
       → ❌ → 加上 Bearer / CSRF header 后能拿到？
              → ✅ Tier 3: header（如 Twitter ct0 + Bearer）
              → ❌ → 网站有 Pinia/Vuex Store？
                     → ✅ Tier 4: intercept（Store Action + XHR 拦截）
                     → ❌ Tier 5: ui（UI 自动化，最后手段）
```

### 各策略对比

| Tier | 策略 | 速度 | 复杂度 | 适用场景 | 实例 |
|------|------|------|--------|---------|------|
| 1 | `public` | ⚡ ~1s | 最简 | 公开 API，无需登录 | Hacker News, V2EX |
| 2 | `cookie` | 🔄 ~7s | 简单 | Cookie 认证即可 | Bilibili, Zhihu, Reddit |
| 3 | `header` | 🔄 ~7s | 中等 | 需要 CSRF token 或 Bearer | Twitter GraphQL |
| 4 | `intercept` | 🔄 ~10s | 较高 | 请求有复杂签名 | 小红书 (Pinia + XHR) |
| 5 | `ui` | 🐌 ~15s+ | 最高 | 无 API，纯 DOM 解析 | 遗留网站 |

---

## Step 3: 编写适配器

### YAML vs TS？先看决策树

```
你的 pipeline 里有 evaluate 步骤（内嵌 JS 代码）？
  → ✅ 用 TypeScript (src/clis/<site>/<name>.ts)，保存即自动动态注册
  → ❌ 纯声明式（navigate + tap + map + limit）？
       → ✅ 用 YAML (src/clis/<site>/<name>.yaml)，保存即自动注册
```

| 场景 | 选择 | 示例 |
|------|------|------|
| 纯 fetch/select/map/limit | YAML | `v2ex/hot.yaml`, `hackernews/top.yaml` |
| navigate + evaluate(fetch) + map | YAML（评估复杂度） | `zhihu/hot.yaml` |
| navigate + tap + map | YAML ✅ | `xiaohongshu/feed.yaml`, `xiaohongshu/notifications.yaml` |
| 有复杂 JS 逻辑（Pinia state 读取、条件分支） | TS | `xiaohongshu/me.ts`, `bilibili/me.ts` |
| XHR 拦截 + 签名 | TS | `xiaohongshu/search.ts` |
| GraphQL / 分页 / Wbi 签名 | TS | `bilibili/search.ts`, `twitter/search.ts` |

> **经验法则**：如果你发现 YAML 里嵌了超过 10 行 JS，改用 TS 更可维护。

### 方式 A: YAML Pipeline（声明式，推荐）

文件路径: `src/clis/<site>/<name>.yaml`，放入即自动注册。

#### Tier 1 — 公开 API 模板

```yaml
# src/clis/v2ex/hot.yaml
site: v2ex
name: hot
description: V2EX 热门话题
domain: www.v2ex.com
strategy: public
browser: false

args:
  limit:
    type: int
    default: 20

pipeline:
  - fetch:
      url: https://www.v2ex.com/api/topics/hot.json

  - map:
      rank: ${{ index + 1 }}
      title: ${{ item.title }}
      replies: ${{ item.replies }}

  - limit: ${{ args.limit }}

columns: [rank, title, replies]
```

#### Tier 2 — Cookie 认证模板（最常用）

```yaml
# src/clis/zhihu/hot.yaml
site: zhihu
name: hot
description: 知乎热榜
domain: www.zhihu.com

pipeline:
  - navigate: https://www.zhihu.com       # 先加载页面建立 session

  - evaluate: |                            # 在浏览器内发请求，自动带 Cookie
      (async () => {
        const res = await fetch('/api/v3/feed/topstory/hot-lists/total?limit=50', {
          credentials: 'include'
        });
        const d = await res.json();
        return (d?.data || []).map(item => {
          const t = item.target || {};
          return {
            title: t.title,
            heat: item.detail_text || '',
            answers: t.answer_count,
          };
        });
      })()

  - map:
      rank: ${{ index + 1 }}
      title: ${{ item.title }}
      heat: ${{ item.heat }}
      answers: ${{ item.answers }}

  - limit: ${{ args.limit }}

columns: [rank, title, heat, answers]
```

> **关键**: `evaluate` 步骤内的 `fetch` 运行在浏览器页面内，自动携带 `credentials: 'include'`，无需手动处理 Cookie。

#### 进阶 — 带搜索参数

```yaml
# src/clis/zhihu/search.yaml
site: zhihu
name: search
description: 知乎搜索

args:
  keyword:
    type: str
    required: true
    description: Search keyword
  limit:
    type: int
    default: 10

pipeline:
  - navigate: https://www.zhihu.com

  - evaluate: |
      (async () => {
        const q = encodeURIComponent('${{ args.keyword }}');
        const res = await fetch('/api/v4/search_v3?q=' + q + '&t=general&limit=${{ args.limit }}', {
          credentials: 'include'
        });
        const d = await res.json();
        return (d?.data || [])
          .filter(item => item.type === 'search_result')
          .map(item => ({
            title: (item.object?.title || '').replace(/<[^>]+>/g, ''),
            type: item.object?.type || '',
            author: item.object?.author?.name || '',
            votes: item.object?.voteup_count || 0,
          }));
      })()

  - map:
      rank: ${{ index + 1 }}
      title: ${{ item.title }}
      type: ${{ item.type }}
      author: ${{ item.author }}
      votes: ${{ item.votes }}

  - limit: ${{ args.limit }}

columns: [rank, title, type, author, votes]
```

#### Tier 4 — Store Action Bridge（`tap` 步骤，intercept 策略推荐）

适用于 Vue + Pinia/Vuex 的网站（如小红书），无须手动写 XHR 拦截代码：

```yaml
# src/clis/xiaohongshu/notifications.yaml
site: xiaohongshu
name: notifications
description: "小红书通知"
domain: www.xiaohongshu.com
strategy: intercept
browser: true

args:
  type:
    type: str
    default: mentions
    description: "Notification type: mentions, likes, or connections"
  limit:
    type: int
    default: 20

columns: [rank, user, action, content, note, time]

pipeline:
  - navigate: https://www.xiaohongshu.com/notification
  - wait: 3
  - tap:
      store: notification       # Pinia store name
      action: getNotification   # Store action to call
      args:                     # Action arguments
        - ${{ args.type | default('mentions') }}
      capture: /you/            # URL pattern to capture response
      select: data.message_list # Extract sub-path from response
      timeout: 8
  - map:
      rank: ${{ index + 1 }}
      user: ${{ item.user_info.nickname }}
      action: ${{ item.title }}
      content: ${{ item.comment_info.content }}
  - limit: ${{ args.limit | default(20) }}
```

> **`tap` 步骤自动完成**：注入 fetch+XHR 双拦截 → 查找 Pinia/Vuex store → 调用 action → 捕获匹配 URL 的响应 → 清理拦截。  
> 如果 store 或 action 找不到，会返回 `hint` 列出所有可用的 store actions，方便调试。

| tap 参数 | 必填 | 说明 |
|---------|------|------|
| `store` | ✅ | Pinia store 名称（如 `feed`, `search`, `notification`） |
| `action` | ✅ | Store action 方法名 |
| `capture` | ✅ | URL 子串匹配（匹配网络请求 URL） |
| `args` | ❌ | 传给 action 的参数数组 |
| `select` | ❌ | 从 captured JSON 中提取的路径（如 `data.items`） |
| `timeout` | ❌ | 等待网络响应的超时秒数（默认 5s） |
| `framework` | ❌ | `pinia` 或 `vuex`（默认自动检测） |

### 方式 B: TypeScript 适配器（编程式）

适用于需要嵌入 JS 代码读取 Pinia state、XHR 拦截、GraphQL、分页、复杂数据转换等场景。

文件路径: `src/clis/<site>/<name>.ts`。文件将会在运行时被动态扫描并注册（切勿在 `index.ts` 中手动 `import`）。

#### Tier 3 — Header 认证（Twitter）

```typescript
// src/clis/twitter/search.ts
import { cli, Strategy } from '../../registry.js';

cli({
  site: 'twitter',
  name: 'search',
  description: 'Search tweets',
  strategy: Strategy.HEADER,
  args: [{ name: 'keyword', required: true }],
  columns: ['rank', 'author', 'text', 'likes'],
  func: async (page, kwargs) => {
    await page.goto('https://x.com');
    const data = await page.evaluate(`
      (async () => {
        // 从 Cookie 提取 CSRF token
        const ct0 = document.cookie.split(';')
          .map(c => c.trim())
          .find(c => c.startsWith('ct0='))?.split('=')[1];
        if (!ct0) return { error: 'Not logged in' };

        const bearer = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D...';
        const headers = {
          'Authorization': 'Bearer ' + decodeURIComponent(bearer),
          'X-Csrf-Token': ct0,
          'X-Twitter-Auth-Type': 'OAuth2Session',
        };

        const variables = JSON.stringify({ rawQuery: '${kwargs.keyword}', count: 20 });
        const url = '/i/api/graphql/xxx/SearchTimeline?variables=' + encodeURIComponent(variables);
        const res = await fetch(url, { headers, credentials: 'include' });
        return await res.json();
      })()
    `);
    // ... 解析 data
  },
});
```

#### Tier 4 — XHR/Fetch 双重拦截 (Twitter/小红书 通用模式)

```typescript
// src/clis/xiaohongshu/user.ts
import { cli, Strategy } from '../../registry.js';

cli({
  site: 'xiaohongshu',
  name: 'user',
  description: '获取用户笔记',
  strategy: Strategy.INTERCEPT,
  args: [{ name: 'id', required: true }],
  columns: ['rank', 'title', 'likes', 'url'],
  func: async (page, kwargs) => {
    await page.goto(`https://www.xiaohongshu.com/user/profile/${kwargs.id}`);
    await page.wait(5);

    // XHR/Fetch 底层拦截：捕获所有包含 'v1/user/posted' 的请求
    await page.installInterceptor('v1/user/posted');

    // 触发后端 API：模拟人类用户向底部滚动2次
    await page.autoScroll({ times: 2, delayMs: 2000 });

    // 提取所有被拦截捕获的 JSON 响应体
    const requests = await page.getInterceptedRequests();
    if (!requests || requests.length === 0) return [];

    let results = [];
    for (const req of requests) {
      if (req.data?.data?.notes) {
        for (const note of req.data.data.notes) {
           results.push({
             title: note.display_title || '',
             likes: note.interact_info?.liked_count || '0',
             url: `https://explore/${note.note_id || note.id}`
           });
        }
      }
    }

    return results.slice(0, 20).map((item, i) => ({
      rank: i + 1, ...item,
    }));
  },
});
```

> **拦截核心思路**：不自己构造签名，而是利用 `installInterceptor` 劫持网站自己的 `XMLHttpRequest` 和 `fetch`，让网站发请求，我们直接在底层取出解析好的 `response.json()`。

---

## Step 4: 测试

> **⚠️ 构建通过 ≠ 功能正常**。`npm run build` 只验证 TypeScript / YAML 语法，不验证运行时行为。  
> 每个新命令 **必须实际运行** 并确认输出正确后才算完成。

### 必做清单

```bash
# 1. 构建（确认语法无误）
npm run build

# 2. 确认命令已注册
opencli list | grep mysite

# 3. 实际运行命令（最关键！）
opencli mysite hot --limit 3 -v        # verbose 查看每步数据流
opencli mysite hot --limit 3 -f json   # JSON 输出确认字段完整
```

### tap 步骤调试（intercept 策略专用）

> **⚠️ 不要猜 store name / action name**。先用 evaluate 探索，再写 YAML。

#### Step 1: 列出所有 Pinia store

在浏览器中打开目标网站后：

```bash
opencli evaluate "(() => {
  const app = document.querySelector('#app')?.__vue_app__;
  const pinia = app?.config?.globalProperties?.\$pinia;
  return [...pinia._s.keys()];
})()"
# 输出: ["user", "feed", "search", "notification", ...]
```

#### Step 2: 查看 store 的 action 名称

故意写一个错误 action 名，tap 会返回所有可用 actions：

```
⚠  tap: Action not found: wrongName on store notification
💡 Available: getNotification, replyComment, getNotificationCount, reset
```

#### Step 3: 用 network requests 确认 capture 模式

```bash
# 在浏览器打开目标页面，查看网络请求
# 找到目标 API 的 URL 特征（如 "/you/mentions"、"homefeed"）
```

#### 完整流程

```
 ┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌────────┐
 │ 1. navigate  │ ──▶ │ 2. 探索 store │ ──▶ │ 3. 写 YAML   │ ──▶ │ 4. 测试 │
 │    到目标页面  │     │ name/action  │     │    tap 步骤   │     │ 运行验证 │
 └──────────────┘     └──────────────┘     └──────────────┘     └────────┘
```

### Verbose 模式

```bash
# 查看 pipeline 每步的输入输出
opencli bilibili hot --limit 1 -v
```

输出示例：
```
  [1/4] navigate → https://www.bilibili.com
       → (no data)
  [2/4] evaluate → (async () => { const res = await fetch(…
       → [{title: "…", author: "…", play: 230835}]
  [3/4] map (rank, title, author, play, danmaku)
       → [{rank: 1, title: "…", author: "…"}]
  [4/4] limit → 1
       → [{rank: 1, title: "…"}]
```

### 输出格式验证

```bash
# 确认表格渲染正确
opencli mysite hot -f table

# 确认 JSON 可被 jq 解析
opencli mysite hot -f json | jq '.[0]'

# 确认 CSV 可被导入
opencli mysite hot -f csv > data.csv
```

---

## Step 5: 注册 & 发布

### YAML 适配器

放入 `src/clis/<site>/<name>.yaml` 即自动注册，无需额外操作。

### TS 适配器

放入 `src/clis/<site>/<name>.ts` 即自动加载模块，无需在 `index.ts` 中写入 `import`。

### 验证注册

```bash
opencli list                     # 确认新命令出现
opencli validate mysite          # 校验定义完整性
```

### 提交

```bash
git add src/clis/mysite/
git commit -m "feat(mysite): add hot and search adapters"
git push
```

---

## 常见陷阱

| 陷阱 | 表现 | 解决方案 |
|------|------|---------|
| 缺少 `navigate` | evaluate 报 `Target page context` 错误 | 在 evaluate 前加 `navigate:` 步骤 |
| 嵌套字段访问 | `${{ item.node?.title }}` 不工作 | 在 evaluate 中 flatten 数据，不在模板中用 optional chaining |
| 缺少 `strategy: public` | 公开 API 也启动浏览器，7s → 1s | 公开 API 加上 `strategy: public` + `browser: false` |
| evaluate 返回字符串 | map 步骤收到 `""` 而非数组 | pipeline 有 auto-parse，但建议在 evaluate 内 `.map()` 整形 |
| 搜索参数被 URL 编码 | `${{ args.keyword }}` 被浏览器二次编码 | 在 evaluate 内用 `encodeURIComponent()` 手动编码 |
| Cookie 过期 | 返回 401 / 空数据 | 在浏览器里重新登录目标站点 |
| Extension tab 残留 | Chrome 多出 `chrome-extension://` tab | 已自动清理；若残留，手动关闭即可 |
| TS evaluate 格式 | `() => {}` 报 `result is not a function` | TS 中 `page.evaluate()` 必须用 IIFE：`(async () => { ... })()` |
| 页面异步加载 | evaluate 拿到空数据（store state 还没更新） | 在 evaluate 内用 polling 等待数据出现，或增加 `wait` 时间 |
| YAML 内嵌大段 JS | 调试困难，字符串转义问题 | 超过 10 行 JS 的命令改用 TS adapter |

---

## 用 AI Agent 自动生成适配器

最快的方式是让 AI Agent 完成全流程：

```bash
# 一键：探索 → 分析 → 合成 → 注册
opencli generate https://www.example.com --goal "hot"

# 或分步执行：
opencli explore https://www.example.com --site mysite   # 发现 API
opencli synthesize mysite                                # 生成候选 YAML
opencli verify mysite/hot --smoke                        # 冒烟测试
```

生成的候选 YAML 保存在 `.opencli/explore/mysite/candidates/`，可直接复制到 `src/clis/mysite/` 并微调。
