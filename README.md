## xk.mjs — 无锡市第一中学 选修课抢课工具（纯 Node fetch，无浏览器 / 无 CDP）

只用 Node 内置 fetch，自己维护 Cookie；登录后把会话缓存到本地，
下次运行直接复用 —— 不重复登录、不重复发 POST。

### 用法：

**分校请把xk.js中的常量BASE改成"https://yzxs.wxtoo.cn/thxc"或者"https://yzxs.wxtoo.cn/liangxi"**

先在config.json中填写账号信息，`name`是姓名，`id_number`是身份证(string)，示例
```json
{
  "name": "姓名",
  "id_number": "320102201001020304"
}
```
一键暴力模式: `node xk.mjs --concurrency 20 --targets 课程编号(点进选修报名，看地址栏最后的数字),课程编号,课程编号 --at 19:00:00 `
```bash
node xk.mjs --check                        #检查登录态 + 当前已选（不抢课）
node xk.mjs --list                         #列出全部课程（不发任何 POST）
node xk.mjs --targets 16,22 --dry-run      #演练：只打印本来会发什么
node xk.mjs --targets 16,22 --now          #立即抢
node xk.mjs --targets 16,22 --at 20:00:00  #定时抢（提前 10s 开冲，持续 40s）
node xk.mjs --targets 16,22,30 --now --concurrency 3   #3 门课同时开冲（最大并发 3）
node xk.mjs --logout                       #清除本地会话缓存
```
### 参数：
```bash
  --targets 16,22      #目标课程编号，按优先级从高到低
  --type class|grade   #报名类型，默认 class（班级选修）
  --at HH:mm:ss        #开放时刻；--lead 秒提前开冲（默认 10）
  --duration 40        #开放后持续抢多少秒（默认 40，到点即停）
  --burst 1            #抢到一门课后该 slot 连发几次再换（默认 1）
  --concurrency 1      #最大并发：同时在飞的 add_sign 数（默认 1 = 纯串行；别名 --max-concurrency）
  --node-concurrency N #Node 全局 fetch 的连接上限（默认跟随 --concurrency）
  --max-posts 300      #全局 POST 次数硬上限
  --dry-run            #演练，绝不发送 add_sign
  --now                #立即开始
  --ignore-existing    #已选课位冲突时也照抢（默认跳过以省 POST）
  --no-verify          #成功后不回头核对
  --relogin            #忽略本地会话，强制重新登录
```
### 并发（--concurrency）：
**没有轮次、没有发车间隔**（`--interval` 已移除），只有 `--concurrency` 个常驻 worker 各自不停地抢。
停止条件只有：成功 / 已满 / 已选 / 课位冲突 / `--duration` 到点 / `--max-posts` 打满 / `Ctrl+C`。

每个 worker 空闲时抢哪一门：

1. **优先「当前没在飞、且与在飞科目课位不冲突」里优先级最高的那门**（按 `--targets` 顺序）——
   保证任意时刻在飞的科目两两不冲突。
2. **都占满了，就加到优先级最高的在飞科目上** —— 同一门课并行发多发抢同一个名额，
   谁先到服务器谁得（服务器只受理其中一发，其余返回「已选/已满」）。

`--burst` 现在是「这一门连发几次再让出 slot」。同一门课被多发并发时**一门课只认先落地的那一发**：
后到的如果更差（已满、已报名重复）直接丢弃、不再上报；「成功 > 已选 > 可重试 > 已满」，
所以「一发说满、另一发抢成了」一定以成功为准。并发中的一门课不在中途刷结果行，
只在末尾「本次结果」里出现一次，不会先报「已满」又报「成功」。

- 并发不会突破 `--max-posts`：预算是发请求前先占坑（`reservePost`），并发下也不会超发。
- **没有间隔意味着失败重试会打得很快**，`--max-posts` 是唯一的刹车，紧张就调小它；
  想稳一点就把 `--concurrency` 调小（它同时也是 Node 的连接数上限）。
- 也可以写进 `config.json`（命令行优先）：
```json
{
  "name": "姓名",
  "id_number": "320102201001020304",
  "concurrency": 3,
  "node_concurrency": 5
}
```

### Node 全局 fetch 并发上限（--node-concurrency）：
启动时会顺手把 **Node 内置 fetch 的全局连接上限**改成配置值（默认 = `--concurrency`）：

- Node 的 `fetch` 走内置 undici，全局 dispatcher 默认 `connections: null`（等于不设限），
  所以并发只由本工具的 worker 数控制。启动时换成 `new Agent({ connections: N, pipelining: 1 })`，
  **同一台服务器最多 N 个并发连接**——抢课之外的登录 / 列表 / 事后核对也一并受控。
- 全局 dispatcher 挂在 undici 的内部 symbol 上（Node 未公开导出，undici 也不在依赖里），
  实现是 `new Headers()` 触发内置 undici 懒加载 → 借现有 dispatcher 的构造器造一个新的换上。
  万一将来 Node 改了内部实现，取不到就只打一行告警并退回「工具自身限流」，不会崩。
- 实测（本地真服务器统计服务端观察到的并发峰值）：

| 参数 | 服务端并发峰值 |
|---|---|
| `--concurrency 4` | 4 |
| `--concurrency 4 --node-concurrency 2` | 2（全局上限真的生效，请求排队，耗时变长）|
| `--concurrency 4 --node-concurrency 8` | 4（worker 数才是瓶颈）|

- 只想抢一门课的**最高优先级**时用默认 `1`；多门都想试、或单门响应慢怕错过窗口时用 `2~4`。
  想要更大的抢课力度就同时调大两个值（如 `--concurrency 4 --node-concurrency 8`）。

### 接口（探测所得）：
  登录   POST /passport/login    name, id_number       → 303 /user + Set-Cookie

  列表   GET  /user/project                            → HTML

  抢课   POST /user/add_sign     project_id, type      → {"code":100,"msg":"选修报名成功"}
  
  响应码 100 成功 / 102 课位已被自己占用 / 含「已满」满员 / 含「等待开放」可重试

### 省 POST 的设计：
  1) 会话缓存到 state/session.json，重复运行不重复登录
  2) 等待期间只发 GET，不发 POST
  3) 成功 / 已满 / 已报名 / 课位冲突 → 立刻永久停掉该门，不再重试
  4) POST 预算先占坑再发，并发下也不超发
