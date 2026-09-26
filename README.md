## xk.mjs — 无锡市第一中学 选修课抢课工具（纯 Node fetch，无浏览器 / 无 CDP）

只用 Node 内置 fetch，自己维护 Cookie；登录后把会话缓存到本地，
下次运行直接复用 —— 不重复登录、不重复发 POST。

### 用法：
先在config.json中填写账号信息，`name`是姓名，`id_number`是身份证(string)，示例
```json
{
  "name": "姓名",
  "id_number": "320102201001020304"
}
```
  node xk.mjs --check                        检查登录态 + 当前已选（不抢课）
  node xk.mjs --list                         列出全部课程（不发任何 POST）
  node xk.mjs --targets 16,22 --dry-run      演练：只打印本来会发什么
  node xk.mjs --targets 16,22 --now          立即抢
  node xk.mjs --targets 16,22 --at 20:00:00  定时抢（提前 10s 开冲，持续 40s）
  node xk.mjs --logout                       清除本地会话缓存
  
### 参数：
  --targets 16,22      目标课程编号，按优先级从高到低
  --type class|grade   报名类型，默认 class（班级选修）
  --at HH:mm:ss        开放时刻；--lead 秒提前开冲（默认 10）
  --duration 40        开放后持续抢多少秒（默认 40）
  --interval 1000      每轮间隔 ms（默认 1000，±20% 抖动）
  --burst 1            每门每轮发几次（默认 1，建议保持）
  --max-posts 300      全局 POST 次数硬上限
  --min-gap 400        两次 POST 之间的最小间隔 ms
  --dry-run            演练，绝不发送 add_sign
  --now                立即开始
  --ignore-existing    已选课位冲突时也照抢（默认跳过以省 POST）
  --no-verify          成功后不回头核对
  --relogin            忽略本地会话，强制重新登录

### 接口（探测所得）：
  登录   POST /passport/login    name, id_number       → 303 /user + Set-Cookie
  列表   GET  /user/project                            → HTML
  抢课   POST /user/add_sign     project_id, type      → {"code":100,"msg":"选修报名成功"}
  响应码 100 成功 / 102 课位已被自己占用 / 含「已满」满员 / 含「等待开放」可重试

### 省 POST 的设计：
  1) 会话缓存到 state/session.json，重复运行不重复登录
  2) 等待期间只发 GET，不发 POST
  3) 每门每轮只发 1 次；成功后立即停止该门及所有课位冲突目标
  4) 已满 / 已报名 / 课位冲突 → 永久停止，不做无意义重试
  5) --min-gap 与 --max-posts 双重硬限制