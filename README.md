# 提瓦特在线 · Teyvat Online

一个原神风格的开放世界动作 RPG。前端 Three.js 实时 3D，后端 Fastify 权威模拟，
PostgreSQL 持久化 + Redis 缓存与在线状态，支持单机与多人在线同场景战斗。

**没有任何美术资源文件**：全部角色、怪物、地形、植被、建筑、武器、特效与音效
都在运行时用代码生成（程序化建模 + 程序化合成音频）。整个仓库里没有一张贴图、
没有一个模型文件。

这份 README 只讲**项目本身**：怎么跑、有哪些系统、有哪些接口、还有哪些已知限制。
每一处缺陷是怎么被拍下来、量出来、改掉并留下证据的，在
**[docs/开发日志.md](docs/开发日志.md)**（72 轮，按时间排）。

---

## 快速开始

```bash
# 依赖（根 / server / client 三处）
npm run install:all

# 建表（Postgres 必须先起来）
npm run db:init

# 开发模式：Vite :5173 + Fastify :8787，Vite 代理 /api 与 /ws
npm run dev
```

打开 http://localhost:5173 ，点「游客试玩」即可进游戏，不需要注册。

### 后台常驻

开发服务器直接 `npm run dev` 会随终端一起死掉。用守护脚本把两个进程
`setsid nohup` 完全脱离当前会话，关掉终端或编辑器都不影响：

```bash
./tools/daemon.sh start            # 起 client + server
./tools/daemon.sh status
./tools/daemon.sh log server 80    # 看日志
./tools/daemon.sh restart server   # 改了 shared/ 或 server/ 之后必须重启
./tools/daemon.sh stop
```

PID 与日志写在 `.run/`。`shared/` 是服务端和客户端共用的，服务端在启动时 import
它，所以改了 `shared/src/data/zones.js` 这类文件要 `restart server`；只改客户端
代码的话 Vite 自己热更新。

### 单端口生产模式

```bash
npm run build      # 产出 client/dist
npm start          # Fastify 同时提供 API、WebSocket 和静态页面
```

`server/src/config.js` 里 `staticDir` 指向 `../client/dist`，存在就自动挂载，
于是 http://localhost:8787 就是完整的游戏。

### 环境变量

| 变量 | 默认值 |
| --- | --- |
| `PORT` / `HOST` | `8787` / `0.0.0.0` |
| `DATABASE_URL` | `postgres://postgres:postgres@127.0.0.1:5432/super_agent` |
| `REDIS_URL` | `redis://127.0.0.1:6379` |
| `JWT_SECRET` | `teyvat-dev-secret-change-me`（上线务必改） |
| `STATIC_DIR` | `../client/dist` |
| `NODE_ENV` | 非 `production` 即开发模式 |

表都建在 `teyvat` schema 下，和同一个库里的其他东西不冲突。

### 部署到 AWS

在线地址：**https://d28onkne6sxzvr.cloudfront.net** （us-east-1，CloudFront 默认域名 +
AWS 自带证书，点「游客试玩」直接进）。

```
CloudFront（HTTPS，默认 *.cloudfront.net 域名）
  ├── /            → S3 私有桶（OAC 读）        ← Vite 打出来的 bundle
  └── /api/* /ws*  → ALB :80 → Fargate 任务 :8787 ← REST + WebSocket 网关 + 权威世界模拟
Fargate 任务（公有子网 + 公网 IP，不开 NAT）→ RDS Postgres 17.6 + ElastiCache Redis 7.1（私有子网）
```

客户端**一行都没改**：`client/src/net/socket.js` 的 `url()` 用 `location.host` 拼
`wss://…/ws`，REST 也是同源 `/api`，所以一个分发既发页面又当网关——没有 CORS，
没有混合内容，也没有第二个域名要配证书。

```bash
./deploy/deploy.sh              # 全套：网络 → 数据 → 镜像 → ALB → CDN → 服务 → 前端 → 冒烟
./deploy/deploy.sh redeploy     # 只换服务端：新镜像 → 新任务定义 → 滚任务
./deploy/deploy.sh web          # 只换前端：npm build → s3 sync → 失效边缘缓存
./deploy/deploy.sh smoke        # 从外面验一遍（deploy/smoke.mjs，24 条断言）
./deploy/deploy.sh logs         # 服务端的 CloudWatch 日志
CONFIRM=yes ./deploy/deploy.sh down
```

用的是 AWS CLI 一个资源一个资源建，**不是 CloudFormation**。每个 id 追加写进
`deploy/.aws-state`，每一步先查这个文件再决定要不要建——这就是让脚本可以反复跑的
全部机制。手动删了那个文件就等于忘了自己建过什么（`down` 读的是同一个文件）。

几件不是随手选的事：

- **只有一个任务**（`desiredCount: 1`，部署策略 `minimumHealthyPercent 0 / maximumPercent 100`）。
  世界模拟是权威的、活在进程里的（`server/src/world/manager.js` 把 zone 实例拿在内存
  里），两个任务就是两个世界，被分到不同任务的玩家会互相看不见。代价是每次部署约 1 分钟
  不可用——这是单写者模拟该付的价钱。要横向扩容得先把实例搬出进程。
- **不开 NAT 网关**。任务在公有子网、带公网 IP（它就靠这个去拉 ECR 镜像、读 Secrets
  Manager、写 CloudWatch），Postgres 和 Redis 在私有子网、没有任何出 VPC 的路由。
  NAT 网关一个月 ~32 USD，只为那三个调用。
- **ALB 只放 CloudFront 进来**：安全组入站是 AWS 托管前缀列表
  `com.amazonaws.global.cloudfront.origin-facing`（`pl-3b927c52`），所以没人能绕开边缘
  （和那个 HTTPS 跳转）去直接打 ALB 的域名。
- **ALB 空闲超时 300 s**。快照是 10 Hz，在线的连接永远不空闲，但停在菜单里的客户端是空闲
  的——默认 60 s 会把它的 socket 剪断。
- **不配 `CustomErrorResponses`**。「403/404 → /index.html 200」是 SPA 的常规配方，但它对
  *每一个* behavior 生效，包括两个 ALB 的，于是每个 API 的 401/404 都会变成一张状态码 200
  的 HTML。客户端只有 `/` 一个页面、没有前端路由，本来就不需要这条改写。
- **密码只在容器里拼**。任务定义里放的是 `DB_HOST/DB_PORT/DB_NAME/DB_USER` 加一条
  Secrets Manager 注入的 `DB_PASSWORD`，`DATABASE_URL` 由 `deploy/entrypoint.sh` 在启动时
  组装——`DescribeTaskDefinition` 的返回里不会印出口令。
- **月账单 ≈ 56 USD**（us-east-1）：ALB 16 + Fargate 0.5 vCPU/1 GB ARM 14 + RDS
  db.t4g.micro 14 + ElastiCache cache.t4g.micro 12，S3 与 CloudFront 在这个量级下几乎为零。

镜像是 arm64（Fargate ARM 便宜 ~20%），构建上下文是仓库根目录，因为
`server/package.json` 用 `file:../shared` 依赖 `shared/`；`deploy/Dockerfile` 里不装
client bundle，服务端的静态目录本来就有 `fs.existsSync` 守卫。标签是时间戳、从不用
`latest`：任务定义必须**变**，ECS 才会去起新任务。

---

## 仓库结构

```
shared/          前后端同构：数据表 + 战斗数学 + 协议常量
  src/data/      characters, enemies, items, recipes, quests, zones, elements
  src/sim/       formulas（伤害/元素反应/词条）, loot, rng（可复现随机）
  src/world/     zoneInstance（20 Hz 权威 tick）, entity, actions —— 服务端和单机共用
  src/protocol.js  C2S / S2C 消息名、ACTION 枚举、序列化字段序

server/
  sql/schema.sql   12 张表，幂等
  src/db/          pg 连接池、redis、repo（全部 SQL 都在这里）、init
  src/services/    playerCache（Redis 镜像）、progression（升级/任务/奖励）
  src/world/       manager（分区实例、shard 分配）
  src/ws/          gateway：握手、输入、广播、组队、秘境
  src/routes/      auth, player, gacha, world

client/
  src/engine/      renderer：渲染管线、bloom、FXAA、画质档位
  src/gfx/         terrain, sky, props, humanoid, enemies, weapons, toon, animator, skin, solid
  src/game/        game（主循环）, world（场景流式加载）, actors, camera, input, localPlayer, vfx, overlay
  src/ui/          hud, panels, mapview（含秘境地面镶嵌的矢量重绘）, portrait（角色面板的实时 3D 立绘）, login, style.css
  src/net/         api（REST）, socket（WebSocket + 插值）, localSocket（单机：浏览器内的权威模拟）
  src/audio/       程序化合成的 BGM 与音效

tools/           daemon.sh + 一批无头验证脚本
deploy/          部署脚本（AWS CLI，无 CloudFormation）+ 线上冒烟测试
docs/            开发日志.md —— 每一轮缺陷的读数、修法与证据
```

---

## 已实现的系统

**角色与战斗**
14 名可用角色（莉拉/伊格纳/瑟莉丝/凯伦/沃尔特/忒拉/奥蕾尔/妮克丝/
皮拉/娜依达/西尔薇/泽菲拉/戈兰/艾莉拉），七元素（炎水冰雷风岩光）加物理，
每个元素至少两人、且不同武器，所以八条**元素共鸣**都能真的凑出来，
普攻连段、重击、下落攻击、元素战技、元素爆发、冲刺、跳跃、攀爬、滑翔、游泳。
四人小队实时切换，切人有冷却。伤害走 `shared/src/sim/formulas.js`：攻击力、
暴击率/暴击伤害、元素精通、抗性、等级差、防御力减伤，元素附着与反应
（蒸发/融化/超载/感电/冻结/超导/扩散/结晶）各有自己的倍率和内置冷却。

**养成**
角色升级、突破、天赋（三条），15 把武器可强化到 Lv.70/90 并精炼到 5 阶，
5 部位圣遗物 + 8 套套装效果，主词条/副词条随机化，一键最优装备，材料合成与分解。

**树脂与秘境掉落**
圣遗物原来只有一个来源：宝箱。而宝箱是**一次性**的（`world_progress` 记着开过哪个 POI），
所以 5 部位 × 8 套的圣遗物系统在地图掏空的那一刻就断了供——想凑一套只能等运气，
凑不齐也没有第二次机会。现在秘境（`abyssTrial` / `frostCavern` / `goldenHall`，
见 `zones.js` 的 `domain`）**每次通关都掉**：每个秘境有自己的两三个套装和三种材料池，
第六层起一次掉两件，40 级以上保证 5★（低于 40 级出 5★ 是个 4 级空壳，副词条还不如它
替换掉的那件 4★）。可重复就必须有闸，闸用的是**树脂**：`players.resin` 早就在库里、
早就 8 分钟回 1 点上限 160、HUD 早就画着，却没有任何地方花得掉它。一趟 20 点
（`DOMAIN_RESIN`），满树脂 8 趟，之后一天再回 9 趟。

分界线在**哪一半收费**：星数是进度，按新拿到的星付一次，免费；掉落是刷，每次通关都给，
收树脂。所以树脂买的是掉落而不是进度，树脂空了照样能拿星、拿记录、拿经验，只是没有掉落
（客户端会明说是这两者中的哪一种，`resin.short`）。

这一改把 `grantChamberClear` 合成了一个函数。网关（`world/manager.js`）和 REST
（`POST /api/world/chamber`，单机走这条）两条路径本来各写一份，已经跑偏过两次：
路由那边无条件付星数奖励，于是一场战斗付两遍；而它从来不碰 Redis 排行榜，
单机玩家的深境星数要等到下一次击杀才会出现在实时榜上。同时 `game.js` 在联机模式下
**也**发了一次 `api.chamberResult`——星数奖励有 `stars > prev` 挡着所以一直没暴露，
但一趟收 20 树脂之后这就是收两次钱掉两份东西。现在路由跟 `POST /api/world/kill` 一样
带 `livePos` 守卫（连着网关就回 409 `use_socket`），客户端那次调用删掉了。

顺带修掉一个会让整个闸门漏光的坑：`regenResin` 在满树脂时直接 return，**不推进
`resinAt`**。一个一周前建的号在 160 点上、`resinAt` 是一周前，那么第一次花掉的 20 点
会被下一次 `getPlayer` 原样退回来——还剩 1260 点「回复」排着队。满了就得把时钟锚回**现在**。
（但不能顺手把 `resin` 夹到 160：浓缩树脂是故意允许溢到 200 的。）

**圣遗物强化**
秘境会下雨一样地掉圣遗物，掉出来却只能看和卖——`POST /api/inventory/salvage` 把多余的一件
换成摩拉，于是刷一整条树脂只是换了一袋钱，从来换不到**一件更好的**。强化是让刷有意义的
那另一半：掉落决定套装、部位和主词条，吃掉的那些决定你把它带到多高。
`POST /api/inventory/enhance { uid, fodder[] }`，素材就是别的圣遗物。

数值不是在旁边另写一份，而是**钉在 `generateArtifact` 上**的（所以它们在同一个文件里）：
强化到 +N 的一件必须和直接**掉落**在 +N 的一件等价，否则两个来源对「一级」的含义就
各说各话。主词条按部位自己的表乘上生成器那个 `0.2 + 0.8 * level/20`；每 4 级给**每条**
副词条加一次 roll（生成器给每条副词条 `1 + floor(level/4)` 次）；每 6 级解锁一条新副词条、
最多 4 条，而且按当前级数的完整 roll 数生成，不会一出生就先天不足。跑 300 件对比过：
自然掉落和强化上来的，每条副词条平均 5.100 / 5.099 次 roll。

价格也是从**一句话**推出来的，而不是第二张表：**一件 +0 的同稀有度圣遗物 × 8 = 从 0 满级**。
每级的步进、跨稀有度的兑换率、摩拉全都由此得出（`ARTIFACT_CLIMB_FODDER`）。所以 5★ 满级
要 16000 强化经验 = 8 件 +0 的 5★ = 16 件 +0 的 4★，摩拉按 1.5/点收（满级 24000，
和一次突破同量级）。喂回去的一件按「基础值 + 已投入的 80%」计价——那 20% 的手续费是
为了让 A 喂 B、B 再喂 A 无利可图，否则圣遗物就成了无损的经验银行。
这条「常数不要写在超线性曲线旁边、要从曲线里算出来」是这个项目所有平衡缺陷的同一个病根，
[开发日志](docs/开发日志.md)里 `balance-check` 那一节有完整的账。

**只消耗吃得下的那几件**：素材按顺序走，累计经验一旦够到满级就停手，所以拿 10 件去喂一个
+19 的，只会掉 1 件、剩 9 件还在背包里。客户端自己算不出这个停手点（除非把成本曲线抄一遍，
而抄一遍就会跑偏），所以由服务端决定并回报 `consumed` / `xpSpent` / `xpWasted`；摩拉也按
**实际花掉**的经验收，不按端上来的。

顺带把一个空头承诺补成了真的：`locked` 从圣遗物和武器第一次生成起就在字段里，
`salvage` 和 `enhance` 都不碰锁着的东西——但**没有任何地方能把它设上**。
现在有 `POST /api/inventory/lock`，面板上是「锁定/解锁」，格子上是一把 🔒。
强化一次吃一把圣遗物，留着凑套装的那件得是**点不动**的，而不是「记得别点」。

面板（B 键 → 圣遗物）选中一件会先告诉你下一级要多少、满级还差多少，点「强化」之后整个格子
变成素材选择器：目标是金框，被选中要吃掉的是压暗加一个红 ✕（不是「选中」那种高亮——它要读起来
像即将消失，而不是像被挑中），左侧实时预览会到 +几、花多少摩拉。

**武器强化与精炼**
`enemyStatAtLevel` 从一开始就是把怪物血量按玩家**两条**成长曲线的乘积定价的：角色等级
× 武器等级。但游戏里只有一条能动——`makeWeapon` 一律铸在 Lv.1，没有任何接口能把它升上去。
所以一支 90 级的队伍拿着 1 级武器，真实攻击力只有审计以为的 **76%**（1/20/50/80/90 级各为
1.000/0.866/0.798/0.767/0.760），`balance-check` 报的每一条击杀余量都虚高了约四分之一。
同一片区域里还躺着另外两个空头承诺：`refinement` 从第一天就在武器字段里、README 写着
「可精炼」，却没有任何代码读它；`buildCharacterStats` 算出来的 `weaponPassive` 也没有任何
地方消费，于是 15 把武器的 `desc` 描述的全是游戏里不存在的效果。而四种矿石
（铁块/白铁块/水晶块/星银）不进任何配方、不当任何突破材料——挖矿是**带计数器的风景**。
一次改动把这四件事接成了一条：矿石就是武器的经验。

`POST /api/inventory/weapon/levelup { uid, ore }`、
`POST /api/inventory/weapon/refine { uid, fodder[] }`。

价格照样只**写死一句话**：一把 3★ 武器从 1 级满到顶 = **120 块铁块**。别的全是推出来的——
矿石阶梯复用稀有度阶梯（一档抵两块下一档，和 `ARTIFACT_FODDER_XP` 同一个 `RARITY_STEP`），
每级的步进直接借 `xpForLevel` 的**形状**（所以 `enemyStatAtLevel` 那两条曲线是按构造同步爬的，
不是靠调参凑齐的），摩拉按 `levelUpCharacter` 给经验书的同一个 0.2/点收，等级上限是
`min(稀有度天花板, arCap(冒险等阶))`——3★ 到 70，4★/5★ 到 90，冒险等阶不够就先卡在
`arCap` 上（面板会明说是这两种上限中的哪一种，这两句话读起来完全不同：一句是「这把武器到顶了」，
另一句是「等你等阶上来再回来」）。

**零碎的矿石不会白费**：一块铁块 1000 点经验，而 30 级往后一级就要好几千，所以经验**存在武器上**
（`equipment.data` 是 JSONB，加个 `xp` 字段不用迁移）。路由从最便宜的矿石开始花、累计够到上限
就停手，摩拉按**实际花掉**的经验收，多带的矿石留在包里——和圣遗物强化那一条同样的规矩。
`api-check` 里对应的断言是**经验守恒**：`weaponXpToLevel(level) + xp` 必须等于升级前的同一个量
加上端上去的经验，不管这一次是升了级还是全存下来了。

精炼吃**同名武器**（装备中和锁定的不算，一把加一阶，最多 5 阶），被动效果按
`refineMul` 从 1 阶到 5 阶线性翻一倍。它够得着不是靠运气：3★ 池里只有 5 把武器而大多数抽卡出 3★，
所以一发十连基本必出重复（实测 `travelersBlade×3 huntersBow×5`）。
**一次能端上去几把，由消耗上限之外的东西决定。** 请求体的 `fodder` 曾经被校验成
`max(4)`——四把确实是从 1 阶到 5 阶最多**吃掉**的数量，但面板上那颗
「精炼（N 把同名武器）」按钮端的是背包里所有同名武器，而锁定／装备中的那几把是
**跳过、不计数**的；于是攒到 5 把重复的玩家一点就是 `invalid_input`，按钮直接失效。
上限现在是 20，**封顶那件事交给循环**（够到 5 阶就 break、只扣用到的那几把），
schema 只负责别让数组离谱。这一轮同时把 15 条被动里
**6 条无条件的**（`normalDmg` / `chargedDmg` / `aimedDmg` / `skillDmg` / `burstDmg` / `healBonus` /
`em` / `elementalDmg`）接进了 `buildCharacterStats`，所以精炼在面板上是**看得见**的。
剩下 9 条是有触发条件的（`onSkillAtk`、`onKillAtk` 叠层、`onHitDef`、`onBurstSpeed`、
`vsFrozen`、`headshotCritDmg`、`skillBurst`、`teamEm`、`energyOnCrit`），**故意没有**当成常驻
加成先算进去：一个有条件的加成被无条件计入比它缺席更糟，因为它会悄悄抬高 `balance-check`
报的每一个数字。

它们现在挂在 `shared/src/world/procs.js` 上——**有条件那一半装备**的唯一一层。
`buildCharacterStats` 只能折进永远成立的数（「重击伤害提升 15%」加进 `typeBonus.charged` 就完事），
而 15 条武器被动里的 9 条、8 套套装里的 6 套、8 个角色天赋里的 5 个都不是这种形状：
施放战技后、击败敌人后、受到伤害后、瞄准命中弱点、对被冻结的敌人、触发反应时、治疗队友后。
这些 key 本来就不在 `ZERO()` 里，`addStat` 会直接丢掉，于是它们长期是**写在 `desc` 里、没有任何
代码读的承诺**——没有消费者的承诺不会失败，所以仓库里每一条门禁都是绿的。
一层而不是按装备种类分三层是故意的：`vsFrozen` 同时长在霜羽长弓和霜华之帷上，
`onSkillAtk` 同时长在御风之刃和炽焰之冠上，戴齐了就该两份都吃到；按种类拆层才会让这种重叠意外互斥。
三个入口分别对应三种形状：`fireProcs`（事件发生 → 压一条限时 buff / 给能量 / 给全队）、
`liveStats`（把限时 buff 折到当前面板上）、`hitMods`（只对**这一次命中**成立的条件：目标被冻结、
命中弱点、这次是什么反应）。条件本身写成**数据**（`fourIf.weaponType`、`onReactions`）而不是引擎里的
`if`，这样 tooltip 的文字和真正被检查的条件没法各自漂移——角斗士只对单手剑/双手剑/长柄武器生效、
导电体质只在感电/超导回能，都是这么落地的。限时 buff 复用食物 buff 那条 `S2C.BUFF` 通路
（`kind: 'gear'`），HUD 上就是同一种带倒计时的小牌子，多层显示 `×N`。
妮克丝的移动速度是唯一由客户端拥有的数（`localPlayer` 管人物运动，离线也得跟手），
所以它照样以 buff 的形式广播，浏览器侧把它加到 `maxSpeed` 上。

审计那边也补上了对应的闸（`balance-check` 第 8 节）：它一直用 `weaponLevel = level` 建队，
现在这个默认值必须由世界的**产出**兑现——一趟矿（26+ 个矿点、按 `rollGather` 的均值每点 2 块算）
要付得起该等阶上限下四把武器的账。实测蒙德一趟 4.24×、加上龙脊 10.04×、加上璃月 8.02×；
一整支 3★/4★/5★ 队伍从 1 级满到顶分别是 0.82 / 1.63 / 3.27 趟全图（矿点 6 小时长回来）。

**世界**
6 个场景：蒙德平原、龙脊雪山、璃月群峰（三个开放世界，420/380/440 m）与
深渊试炼场、冰封洞窟、黄金屋遗迹（三个室内秘境）。地形是多层 fBm + 脊线噪声
在 GPU 里着色的：生物群系混合、陡坡岩层、雪线、室内地面的石板与镶嵌纹样。
植被、岩石、水晶、遗迹按密度以单元格流式加载，全部实例化。
宝箱（四档）、元素解谜、七天神像、传送锚点、采集点、NPC 对话、
14 个秘境间（有计时和三星评价）、天气（雨/雪/暴雪）、龙脊雪山与冰封洞窟的严寒机制。

**解谜是一圈方碑，不是一次点击。** `poi.kind`/`poi.count` 曾经是**没有消费者的数据**：
三种谜题（元素方碑／霜封碎片／古老石灯）写在地区表里，客户端却只按 `type === 'puzzle'`
放一个可点物件，点一下就整个解开并付钱。现在 `puzzleNodes(zone, poi)` 用
`zone.seed ^ hashStr(poi.id)` 推出一圈（半径按 `kind` 6.5～9 m）方碑的**确定性**位置——
和采集点同一套推导，所以两端算出来的是同一批 id 和同一批坐标，服务端才敢把每一次点击
当成一次可验证的交互：`POST /api/world/puzzle` 收 `{zone, poiId, nodeId}`，
逐个方碑校验区域、14 m 距离与「这一座是不是已经亮了」，写 `p:<nodeId> = {lit:true}`，
**只有最后一座**才写 `{solved:true}` 并付 2000 摩拉 + 5 原石、推进任务。
成就里的「解谜数」数的是 `solved` 那一行，所以一圈三座仍然算一个谜题；
老存档（只有 `{solved}`、没有 `p:` 行）进图时整圈直接点亮。

**「亮了」这件事得看得见。** 上面那一整套规则都是服务端的，玩家能感知的只有方碑本身：
一枚 12 cm 的纹章从死石头换成自发光、顶上多一颗元素球。这条反馈链上曾经**每一环都是坏的**，
而且没有任何测试会红——`tools/puzzle-check.mjs`（浏览器探针，见「验证工具」）是拿像素把它们
一个个逼出来的：纹章原来是一枚**平放**的圆环，比它要贴的六边形柱面还宽，看起来就是一枚已经
在发光的圆盘悬在方碑旁边（未解的谜题长得像已解的）；顶上那颗球放在 y 2.62，而顶冠从 2.5 收到
2.92、在 2.62 处石头还有 0.15 宽——**球整个埋在石头里**，`visible`、发光、还在上下浮动，
但谁都没见过（探针在那块矩形上量到 96.8 → 95.1，等于没变化，这就是「画了却被遮住」的读数），
现在浮在塔尖之上 y 3.18；提示条那一半更隐蔽：`_updatePrompt` 原来只在**换了目标**时重建，
于是站着点亮一座方碑之后，脚下那行字会一直停在「共鸣元素方碑 · 风之试炼 0/3」——偏偏计数
就是这一步的全部反馈，现在改成**文案变了就重建**（一次 switch 加三个节点的扫描，只在范围内跑）。
最后是解谜奖励本身：解开后被解锁的宝箱只有一条锚在**宝箱位置**的飘字，而 `overlay.note` 在
目标不在屏幕里时什么都不画——从三座方碑里的哪一座解开都大概率看不见，所以现在同时发一条
「N 个宝箱已解锁」的 toast。

**一根直锥体没有任何东西给明暗分层。** 纹章和元素球都修好之后，`prop-cam` 的全身照里方碑
本体还是一支灰铅笔：台阶 + 一段从半径 0.34 收到 0.20 的 loft + 一个小尖顶，全部一种
`MATS.stone()`。单看每个数字都没错，问题是**形上没有东西可以让光断开**——cel ramp 只吃
「换面」或者「换材质」，而一段匀速收细的六棱柱两样都不给：轮廓从台座到塔尖是一条直线，
三个可见面各自从下到上一个色调。现在是一件石作：底下三层（深色底座 / 中调台阶 / 淡色把方
台转成六棱的过渡层）、柱身两道**菱形剖面**的雕带（先外扩再收回，上斜面吃光、下缘压出一条硬
阴影线——只换材质的平贴带子在游戏距离上是看不见的，得同时换面）、一圈比柱身宽的挑檐，
以及纹章沉进去的那块深色**匾额**。匾额的 z 是逐段给的（`oz` 跟着 `faceZ(y)` 走）：贴在一个
带锥度的面上却只用一个 z，下端会埋进石头、上端会浮在外面。纹章也不再是「记住的 0.232」，
而是 `faceZ(1.6) + 0.026`，柱身改比例时装饰跟着走。合并后仍然是三个 draw call（`Parts`
按材质批），三角面数量可以忽略。

**`requires` 是真锁。** 三个秘境尽头的华丽宝箱写着 `requires: 'clear'`，
蒙德那口写着 `requires: 'puzzle:mond_puzzle1'`——这两条以前**谁都没在执行**，
于是进图就能开，等于三份华丽宝箱的原石白送。现在 `POST /api/world/chest`
自己查 `chamber_records`（每一层都要有星）和 `world_progress`（那个谜题要 solved），
**认不出来的 `requires` 形状一律 403**（fail closed），提示条上也照实写
「需通关秘境 3/8」「需先解开谜题」。

**上面这三个洞是同一道门禁抓出来的。** `shared/src/data/zones.js` 是仓库里最大的一份
作者数据（6 个地区、上百个 POI、几十组 props 参数），而作者数据会**两头腐烂**：
写了没人读（`props.trees.minH` 声明在三个地区上、`_recipes` 里从来没读过，树线该退开的
岸边照样长树），或者读了没人写／写错（`ruins.kind` 打错一个字母，只有加载到那个地区时才崩）。
所以有了 `zoneGateReport()`（`shared/src/data/zoneGate.js`），和成就的
`achGateReport()`、任务的 `questGateReport()` 是同一个套路：`PROP_GROUPS` 给每一组 props
声明**认领它的消费者文件**和每个 key 的用途，`POI_PROPS` 给每种 POI 声明它的模型，
`POI_GATES` 给每种 `requires` 声明**执行它的那条路由**；然后两个方向都查——
没声明的 key、声明了但消费者文件里搜不到的 key、没有执行者的 `requires`、
只有室内地区能用的 `enclosure` 写到开放世界上、方碑环互相叠在一起（< 2.4 m）、
三星阈值不降序、`sheerCold` 没有取暖点（或取暖点没有 `sheerCold`）、
出口落点在墙外……都是 FAIL。它还跨到客户端：把 `client/src/gfx/props.js` 的
`SCATTER_KINDS`/`SINGLE_KINDS` 端进来对撞，**地区要的每种 prop 都得有 builder、
每个 builder 都得有地区要它**（31 种 = 25 实例化 + 6 单体，两边都不许多也不许少）。
`props.js` 在模块顶层不碰任何浏览器全局，所以这一条在 Node 里就能验，不用开浏览器。

**同一道门禁往 `terrain` 里伸了一次，一次就捞出三件死数据。** props 那半边只管
`z.props`，而地形是 zones.js 里更大的一半：`TERRAIN_KEYS`（21 个 key）、`BIOME_KEYS`
（7 个）、`ARENA_KEYS`（2 个）现在也各自声明**认领它的消费者**（`zones.js#rawHeight/heightAt`
决定形状，`gfx/terrain.js` 决定表面，`ui/mapview.js` 烘小地图，`game/world.js#_recipes`
喂植被），两个方向照样查。捞出来的三件：

- `snowLine`／`snowBlend`／`snowColor` —— 三个**着色器输入有默认值、六个地区一个都没写**，
  所以 `gfx/terrain.js` 里那整条雪地分支（顺风向的雪垄、天蓝色的垄沟、近景的闪点）
  在这个游戏里**从来没执行过**。症状是可以量的：龙脊雪山近地面 luma 209.6 std 10.0，
  是全游戏唯一一块没有纹理的地表，而且**比它自己的天空（197.1）还亮**，地平线整条化开。
  现在雪线写 2 m（不是峰高：这张图内部 -8 → 46 m，中位数 18.6，雪线放到中位数等于让下半张图
  留白并且在雪原中间画一条等高线），配 14 m 过渡，雪的 albedo 从 0xeef4fb（luma 244）
  压到 0xd4e2f0 —— 244 那个值会把雪垄的 ±5% 和闪点的 +0.34 一起顶到 tonemap 的肩部以上，
  也就是纹理算了、然后被裁掉了。
- `grassColorA/B` —— 三个开放地区都写了、**没有任何人读**，`props.js` 里硬编码着四支
  Mondstadt 的绿草叶，于是雪山的雪原和深渊里长的是同一种草原绿。现在 `world.js#_recipes`
  把它们当 `color`/`colorB` 传进 `SCATTER.grassTuft`，亮叶与枯叶**从 A 推导**
  （亮叶朝淡黄绿 26%，枯叶是 75% 稻草色 + 25% 本地色，所以雪原的枯草偏冷、璃月的偏暖），
  一个地区只需要维护两个颜色而不是四个。`protoKey` 同时加上 `colorB` —— 少这一步，
  proto 缓存会把第一个地区的草叶发给后面每一个地区。龙脊雪山的那对颜色也改了：
  原来写的 0xe8f2fb 比它脚下的雪还亮，跟上面那条 albedo 错误是同一个错。
- `biomes[].rough` —— 24 个 biome 全都写了粗糙度，**没有一个着色器采样过它**：
  冰（0.15）和草地（0.9）拿到的高光完全一样（都是没有）。现在它取反成 `uGloss`，
  用**和 albedo 同一套 splat 权重**混合（不需要第二张遮罩），并且平方后再乘，
  所以草是真的哑光（0.1² × 0.5 ≈ 0.005）而冰有一片真的高光叶（0.8² × 0.5 = 0.32），
  高光指数也跟着 gloss 从 20 收到 110。落到画面上：雪山的冰湖 0.75、雪境洞窟的
  ice/deepIce 0.80/0.85、深渊的符文地 0.70、黄金屋的金饰带 0.70 都亮了起来，
  六个地区的草地一个都没动。

顺手删掉的一件：`terrain.waterLevel` 六个地区都写了，唯一的读者是门禁里
「它必须等于 `water.level`」那条断言 —— 一个只为了被断言等于另一个键而存在的键，
按同样的标准是死的，所以键和断言一起删了，水位只剩 `water.level` 一个来源。
配对规则也写进门禁：雪的三个键**要么齐全要么都别写**（只写 `snowLine` 会让雪垄跑在
0xeef4fb 的默认白里，正是上面那个 bug），`grassColorA/B` 必须成对且该地区要有
`props.grass`，`inlayColor/inlayStrength` 必须有 `indoor` + `terrain.arena`
（否则 `uArenaR` 是 0，整条镶嵌分支不跑），biome 最多 4 个（splat 是 vec4，
第五个颜色是够不着的数据），每个 biome 都**必须**写 `rough`。
七个变异体逐个验过：加一个没人读的键、删掉 `snowColor`、删掉 `grassColorB`、
把 `rough` 抹成 undefined、把 `inlayStrength` 写到室外地区、加第五个 biome、
以及**把三个雪键全部删掉（也就是一小时前这个仓库的真实状态）** —— 七个全部 FAIL。

**`SKY_KEYS`：同一张表往 `sky` 里再伸一次，捞出的是全帧最要紧的那个数。**
`sky.exposure` —— 六个地区全都写了（1.0 / 1.05 / 1.08 / 1.1 / 1.12 / 1.2），
`Renderer` 从头到尾没读过，`toneMappingExposure` 一直钉死在 1.0。也就是说
**整条 ACES 曲线的工作点是一份没人读的作者数据**，而龙脊雪山正好是那个「整帧都是一种亮材质」
的地区：雪的 albedo 0.87 × 0.8 的太阳 + 环境光落在 1.0 附近，正是曲线肩部最平的一段，
量出来近地面 rgb [192,209,227]、p5..p95 只有 204..213 —— 一条 9 个色阶的带子里塞着雪垄、
闪点、坡面明暗和角色的蓝影，全都算完了、然后被色调映射抹平；地面和它自己的天空同值，
地平线消失。降 albedo 治不了（0.48 的雪只是把地面和站在上面的一切一起推向灰：luma 192、
std 仍然 3.6），因为错的不是材质而是**曲线上的位置**。现在 `Renderer#setExposure` 在
`new World` 之前按 `zdef.sky.exposure` 设好（免得新地区第一帧还用着上一个地区的曝光），
龙脊雪山写 0.58：地面 210 → 167，天顶 225 → 179，地面第一次低于天空，雪垄、
蓝影和远山的形状全部出来了。另外五个地区保持它们原来写的值。
`sunIntensity` 顺手也测清楚了一件事：它只驱动 DirectionalLight（道具、角色、阴影贴图），
`gfx/terrain.js` 把 `sunColor` 直接当光照项、**从不乘它**，所以拿它去压过曝的雪原
移动了 0 个色阶（[189,206,224] 改前改后一模一样）—— 这条已经写进 `SKY_KEYS` 的注释里。
19 个 sky key 也一样两头钉：`vaultColor/vaultGlow` 必须是室内地区、室内地区必须写
`vaultColor`、`fogFar > fogNear`、`exposure ∈ (0.35, 1.7)`（这一个乘的是整帧，
写错一个 12 就是满屏白纸），`zenithColor/horizonColor/stars/night` 四个是
「sky.js 里有 `??` 兜底、暂时没人写」，声明出来是为了别人写的时候不会被当成拼写错误，
豁免的代价是照样被 grep 证明读者存在。

**任务**
14 个任务：主线链、支线、每日。阶段化推进，事件驱动（击杀/采集/开箱/对话/到达）。

**祈愿**
常驻池与限定池，标准原神概率：5★ 基础 0.6% + 74 抽后软保底、90 硬保底，
4★ 10 抽保底，限定 50/50。9000 抽统计验证：实际 5★ 1.60%、4★ 12.62%、
平均间隔 62.4 抽、最大 84 抽、限定占 5★ 的 64.6%。重复角色转命座，
重复武器进背包，抽卡记录入库。

**多人**
WebSocket 20 Hz 权威 tick。远端玩家与怪物按 120 ms 延迟做快照插值，
本地角色在本地即时模拟、由服务端裁定命中与掉落。同场景最多 8 人，
共享怪物与伤害数字，组队、复活、聊天、表情、地图标点，
Redis 维护在线名单，四个排行榜（冒险经验/深境星数/最高伤害/讨伐数）。
断线不掉线：状态在 Redis 里镜像，重连直接续上。

**好友与联机同行**
联机里除了好友全是临时的：`/api/online` 是这一秒还连着的人，小队活在
`WorldManager.parties` 里、进程一死就没了，区域聊天刷过去就找不回来。所以以前想和
某个人一起玩，只能碰巧在同一个 shard 里、还得知道对方的数字 id。现在有一套持久的
好友系统（`/api/social/*`）：按昵称或 id 申请、同意/拒绝/删除、双方一致的列表、
上限 50 人，好友表按**一段友谊两行**存（见 `repo.friendsOf`），所以「谁是我的好友」
是一次 `player_id` 上的索引查询，代价一次性付在写入那侧的事务里。
面板（U 键）把三种可操作状态分成三栏——已成为好友、收到的申请、已发送的申请，
在线的好友直接显示所在场景。
真正的联机入口是 `JOIN_ZONE { follow }`：这是网关唯一接受客户端指定 shard 的地方，
所以门槛也在这里——必须是已互相同意的好友，对方必须在线，公共 shard 谁都可以跟随；
私有实例（秘境）只有**同一支小队**的人能跟进去，声明了单机的人谁都跟不进去
（都答 `friend_is_solo`）。好友列表里的 `joinable` 因此不是一行数据的属性而是一次
关于观察者的判断，网关和面板用的是同一条规则——见
[开发日志](docs/开发日志.md)「三个秘境只装得下一个人」那一节。
区域由**服务端**按对方此刻的位置决定而不是照抄客户端传来的那个：好友列表是一次 REST
快照，对方两秒前换了区域的话，照抄只会把人丢进旧区域的空 shard 里，看起来就像功能坏了。
落点是对方身旁 2.5 m，而不是区域入口。

**单机**
不连 WebSocket 也能玩，而且不是缩水版：`单机` 模式下**浏览器自己托管权威模拟**——
`shared/src/world` 里那个 20 Hz 的 `ZoneInstance`、同一套怪物 AI、同一套
`handleAttack / handleSkill / handleBurst`（连反作弊位移检查和冷却节流都在跑），
所以单机和联机的伤害数字逐位相同。`client/src/net/localSocket.js` 继承 `Socket`
只替换两端（`connect` / `send`），本地事件照样喂给 `_route()`，快照缓冲、
120 ms 插值、时钟平滑、`stale` 判定全都不变——上层的 `game.js` 分不出自己连的是
网关还是自己。唯一不在浏览器里算的是**会变成存档的东西**：掉落、经验、任务进度、
秘境奖励一律由 REST 结算（`POST /api/world/kill`、`POST /api/world/chamber`），
等级按区域刷怪表夹死、战利品在服务端 roll。所以「单机」是**不需要网关**，
不是不需要服务器：存档还在 Postgres 里，杀了怪也得报上去才有奖励。

**画面**
卡通渲染（分级色阶 + 边缘光 + 描边），2048 阴影贴图，bloom + FXAA，程序化天空
（Rayleigh 梯度 + Mie 光晕 + 两层视差云 + 星空）与室内穹顶着色器，
风吹草浪、水面波动与深度着色、岸线湿痕与泡沫、指数雾、元素粒子特效。画质四档（低/中/高/极高），
每档限制渲染分辨率上限、阴影贴图尺寸、bloom 强度和实时点光源数量。

设置里选的那一档是**上限**而不是承诺：`engine/perf.js` 的 QualityGovernor 盯着渲染器
每 500 ms 结算一次的帧时间，机器扛不住就自动往下掉档，帧率稳定了再往上调回选定的那一档
（设置里「自动画质」可以关）。判据用的是多秒窗口的**中位数**而不是单帧，所以一次着色器编译
或一次串流卡顿不会误判；降档比升档快得多（3 s vs 12 s，阈值 25 fps vs 53 fps，中间留出
任何稳态都落不进去的空档），失败过的档位先冷却 60 s、第二次失败之后本次会话不再尝试——
来回抖档比卡在低档更糟，`World.setQuality` 会把所有已驻留的散布 cell 全部重建。
还有一条：降了一档但帧时间没变好，说明瓶颈不在渲染档位（CPU 卡、浏览器完全没有硬件加速），
这时会锁住不再继续降，否则会把画面扒光还是 25 fps。这套逻辑是纯算术、不碰 THREE，
所以 `node tools/quality-check.mjs` 用虚拟时钟直接验它收敛且不抖。

地表着色器分四层噪声（区域 / 中景 / 草簇 / 颗粒）加近景条纹，斜坡上的岩层带倾斜、
分粗细两级并随距离淡出（程序化噪声没有 mipmap，远处会闪），岩面有矿脉冷暖色偏和台阶亮边，
岩草边界由噪声扰动而不是纯坡度阈值——否则山坡上会画出一条等高线。雪地有风向雪垄、
低处偏蓝、近处闪点。植被用 `instanceColor` 给每株做明度与冷暖抖动，
所以同一批实例不会是复制粘贴；草叶材质带根部渐变（`rootDark`）来模拟草丛内部的遮蔽。
树冠同理（`foliageTone`）：一棵树的树冠是十几个光滑着色的近似球，单靠光照每个球都是
一半亮一半暗，整片树冠看起来像一堆气球；真实树冠缺的是**深度**——丛的底面和树冠内部
几乎没有光，顶部的叶子被晒得偏黄。这些都跟光的方向无关，所以烘进顶点色。针叶树的
渐变方向不同：一层枝叶是个圆锥，锥尖被上面一层压住、锥底才是暴露在外的针尖，
所以梯度要沿半径往外走（`radial`），按 y 轴算会正好把最没光的地方点亮，
另外整棵树从下往上再叠一层，最底下的裙层在白天几乎是黑的。
烘的这层遮蔽有个陷阱：它会和光照里的遮蔽重复计算。灌木原来同时吃 `foliageTone` 的 AO 和
0.95 m 的 `rootDark`，两者相乘，还没打光就只剩 albedo 的 0.48；而 `toon.js` 的色阶是
`lit = N·L * 0.5 + 0.5` 分两档，偏离太阳 130° 以上的面 ramp 恰好等于 0，也就是只剩阴影色，
连一点漫反射都没有——球状叶团的整个底面都在这个区间里。实测隔离出来的灌木：受光的顶部
luma 114、旁边的草 117（顶部是对的），下半部 40 只有 17、p95 43，也就是整片近黑而不是"暗"。
所以植被材质多了一个 `rampFloor`（最暗那档的下限，0.14），石头等不透光物体保持 0：
巨石的背光面本来就该读作没光。修完下半部是 40，p5 16 / p95 92——有梯度了。
这里也踩过一次：`rampFloor` 先试的 0.26 把底面推到 74、顶部从 114 涨到 131（比草还亮），
因为平面着色的叶团落在最暗档里的面远不止底面，把这档抬到全光的 43% 不是提亮暗部而是抹掉色阶。
光靠顶点色只能救明暗，救不了轮廓：一个光滑的椭球在任何角度上边缘都是正圆，而正圆不像树叶。
所以树冠和灌木的每个叶团（`leafClump`）沿自身法线做三层径向扰动，最粗那层在一米的叶团上大约
是 40 cm 的起伏，重算法线之后色阶会在一个叶团内部跨好几次分界，明暗也就跟着碎成叶片状而不是
一道平滑渐变——顶点数和它替换掉的 `blob` 一样。扰动之外还有一件更省的事：叶团原来被缩放成
(1.10, 0.94, 1.10)，那是个绕 Y 的旋转体，横向任何角度看轮廓都是同一个圆，而它当初是用
`rand.angle()` 绕自己的旋转轴摆放的——按定义改不了轮廓。改成每个叶团有各自的 x/z 半轴和一个
倾角之后，五到七个叶团在同一视角下给出的是五到七个不同的椭圆（长焦实拍：从一个暗圆盘变成有
凹凸的团块）。代价是零三角形，但叶团成了椭球，裙叶的落点得按方向算半径（`lr / |n/s|`），
否则长轴那侧的表面在 1.34 lr 处、按 0.94 lr 埋进去的叶子永远露不出来，就又变回光头球。
针叶树的裙层从 6-8 层加到 8-10 层、上层长度
不再收到 0.10h：十米外拍出来，中部以上每两层之间都能看见天光，因为那里层间距（0.11h）已经
超过了裙长，而云杉是不透光的。
石头把色调烘进顶点色（`stoneTone`）：巨石是光滑着色的多面体，侧面法线朝向相近，
色阶再分多级也只给得出两个色调（实测受光面 sRGB 188、旁边的面 60，中间是空的），
所以变化必须放在 albedo 而不是光照里，同时压暗贴地的那一圈、提亮朝天的冠部。
顶点色到不了的那一档（10-50 cm，六米的巨石每 80 cm 才有一个顶点）由片元着色器补
（`toon.js` 的 `uMottle`）：三层世界空间值噪声，偏重细的那两层，18 m 之后淡出——程序化噪声
没有 mipmap，留着远处只会变成一层爬动的薄膜。再叠一层 3 cm 的稀疏亮点当云母，9 m 之后淡出。
中间试过用脊线噪声画"裂缝"，两次都失败：把一个光滑标量场卡阈值取出来的是它的等值线，
而等值线是一族宽度均匀的闭合曲线，拍出来是一张等高线迷宫；石头在这个尺度上没有线条，只有颗粒。
另外场景散布的分组种子原来取的是组名长度，而 'trees' 和 'rocks' 都是五个字母：两组抽到完全
一样的候选坐标序列，于是每个单元格里第一块石头正好长在第一棵树里。改成 `hashStr` 哈希整个
名字（`shared/src/sim/rng.js`），NPC 外观和原型种子同理。

**商店：摩拉的出口**
一个 42 级的存档上躺着 254,182 摩拉，而全游戏唯一花钱的地方是祈愿——祈愿收的是原石。
摩拉只进不出，于是每一次掉落里的摩拉都是噪声。现在有五家店（`shared/src/data/shop.js`）：
万有铺（食材/料理，每日）、铁匠铺（矿石 + 五把三星精炼料，每周）、万民堂前市集（仙家吃食
与大英雄的经验，每日/每周）、派蒙的十日谈（原石换浓缩树脂与相遇之缘）、深渊商人
（只做**以物易物**：混沌核心换智识之冕碎片，每月一次）。

三条规则写死在目录里：

1. **摩拉永远买不到高级货币。** 摩拉买消耗品、矿石、精炼料和食材——都是「走一趟/打一场」
   本来就能拿到的东西；原石买树脂和祈愿。要是摩拉能换原石，整条养成曲线会塌成「刷摩拉」。
   `api-check` 直接遍历目录断言这一条，而不是靠人记着。
2. **限购声明的是「周期」，不是「刷新时间」。** 存一个 `resets_at` 时间戳等于让时钟有两个
   来源，它们会在旧版本写的行、跨过边界的离线玩家、两个进程各自的小时数上分叉。
   `shared/src/sim/clock.js` 反过来做：**计数带着它所属周期的键**（`'2026-09-05'` /
   `'w2953'` / `'2026-09'`），键不等于当前键的计数读作 0。于是刷新是**推出来的**，
   不需要定时任务，不会漏，也不可能只刷了一半。边界是 04:00（UTC+8），不是宿主的本地午夜——
   服务端和每个客户端必须同意同一个时刻，而它们不在同一个时区。
3. **以物易物就是普通购买。** `cost` 是一张 `{itemId: 数量}` 的表，而摩拉本身就是一件
   物品，所以深渊商人收 20 个混沌核心走的是和收摩拉完全一样的那条代码路径，没有第二套机制。

买入**夹紧而不报错**（和 `/api/player/cook` 一致）：要 5 件只买得起 2 件就买 2 件并如实回报。
客户端的算术总会落后一帧，和别处的花费撞上时应该让玩家少买一点，而不是弹一个错误框。
兑换率 `GEM_PER_WISH = 160` 从 shop.js 导出，祈愿路由的「原石不够自动折算」也 import 它——
两处报不同的价钱不是特性，是套利漏洞。

顺带补上了两个**只有作者、没有读者的键**：NPC 的 `role`（`'forge'` / `'guild'`）过去被原样
打进对话框标题，凯瑟琳会自我介绍成「凯瑟琳 · guild」；而 `dialogue: 'welcome'` 没有任何
地方读，所以全游戏每个 NPC 说的都是「……」。现在 `role` 过一张中文表，NPC 有真的
`lines`，并且新增的 `shop` 键把摊主和店铺连起来：走到瓦格纳面前对话，弹出的是**铁匠铺**
那一栏而不是第一栏。键盘 N 或面板顶栏也能直接进店。

**邮件：奖励的落点**
在此之前每一份奖励都是**当场**给的：宝箱给开箱的那只手，秘境在结算界面给，商店隔着柜台给。
这套办法一直管用，直到第一份「时刻是钟点、不是点击」的奖励出现——每日签到、每周排行榜结算、
一次补偿发放——它们没有地方可以落。信箱就是那个地方，也是奖励唯一可以**等一个不在线的玩家**
的地方（`shared/src/data/mail.js`）。三条规则：

1. **周期邮件是推出来的，不是定时发的。** 每行带一个 `dedupe` 键，写明它是什么、属于哪个周期
   （`login:2026-09-05`、`board:w2953`），`(player_id, dedupe)` 上的**部分唯一索引**让
   「没有就插一条」成为整个 cron。于是**打开信箱这个动作本身**才生成今天那封信。离线一周的
   玩家回来不会收到七封：那六个键从来没有人去要，他只拿今天这封。和商店的限购计数是同一个
   套路（`sim/clock.js`），理由也一样——定时任务是关于时钟的第二个真相来源，而且它就是那个
   会在进程恰好在错误的一分钟重启时出错的东西。
2. **附件是一张物品表。** `{itemId: 数量}`，正好是 `repo.addItems` 吃的形状、也是商店 `cost`
   用的形状，所以领取一封信是一次调用，摩拉/原石（列）和材料（行）之外没有第二套特例。
3. **过期是读的时候过滤，不是扫。** 超过 30 天的信不再列出，没有任何东西按时删它。

**删除是软删除，这一条是承重墙**，不是整洁：那一行**就是**「今天的礼物已经发过」这件事的凭据。
硬 DELETE 把凭据删掉，下一次 GET 就会把礼物重新铸出来——「删除已读」会变成一台原石印钞机。
这个 bug 是 `tools/api-check.mjs` 里那句「deleting a claimed gift does not re-mint it」
当场抓住的，写断言的时候我以为它只是在描述显然成立的事。只有**已过期**的行才真的被删掉
（`purgeExpiredMail`），因为周期键永不重复：`login:2026-09-05` 再也不会被欠一次。
反方向的守卫同样在 SQL 里：`claimed=false` 写在 UPDATE 的 WHERE 上，两次点击只付一次；
带着未领附件的信不允许删——一个悄悄扔掉未开奖励的「清空」是这个模块唯一不可逆的错误。

登录礼是**七天轮换，按日历日索引，不是按连续登录天数**：连胜需要存一个计数器，那是关于同一个
时钟的第二份状态，玩家第一次跨边界离线时两者就会分叉（漏掉的那天算不算断？重置跑了没有？）。
排行榜结算是第一处**为**排行榜付钱的地方——没人因此拿到钱的榜只是个计分板；奖励按名次分档，
有分数的人都有份（前 50 之外是参与奖），信里写着「第 N 位」，`api-check` 就用这个 N 反查
分档表，而不是抄一遍数字。信箱在**开局就抓取一次**（不是等玩家按 I），所以 HUD 右上角那个
✉ 徽标会自己出现——一份要玩家自己去找的奖励不算奖励。徽标数的是**可领取**而不是未读：
一封没有附件的通知读完就该消失，一个读了也不走的红点是噪声。

**每日委托：按周期键翻页，没有定时任务也没有重置按钮**
四条每日委托原来靠 `POST /api/quest/dailies/reset` 重新武装，也就是说：**没有人 POST 就永远不刷新，
而 POST 一次就再发一次奖励**。两半都是错的。一个 04:00 时不在线的玩家永远拿不到新的一天；
而一条已完成的每日行**就是「今天这 20 原石已经发过」的凭据**，把它翻回 active 等于把奖励再铸一遍
（和信箱那条「删除是软删除」是同一个 bug 的两种写法）。
现在没有路由、也没有 cron：`quest_progress.updated_at` 落在哪个周期键上，这一行就属于哪一天，
键不是今天的键就**是**昨天的行（`quests.dailiesToRoll` + `sim/clock.js` 的 04:00/UTC+8）。
翻页因此是幂等的、追溯的、离线也算的，并且不存在关于时钟的第二份状态——和商店限购、每日登录邮件
同一条规则。触发点是**读**：`advanceQuests`（让这次击杀落在正确的一天）和 `GET /api/quests`
（让面板在玩家还没动手时就显示新的一天）。面板底部那行「每日委托 4小时28分后刷新」只用来渲染，
从不参与判定——判定永远只看键。

**成就：读状态，不收事件**
成就的常规做法是每个成就一个计数器，在事情发生的地方 `+1`。那是八个新调用点、八次可能多加
或漏加的机会，以及一份数据库早就存着的数字的第二个副本——`leaderboard.kills` 和
`chamber_records` 从第一个 commit 起就在数了，而一列新的 `ach_kills` 对所有已存在的账号都从
0 开始。所以这里的规则是：**一个成就是一个统计量上的阈值，而一个统计量是一次查询**
（`shared/src/data/achievements.js`，25 个成就 / 77 档 / 1650 原石）。三条规则：

1. **进度是推导出来的，唯一存下来的行是「付过钱到第几档」。** `GET /api/achievements` 用一次
   SQL 往返（`repo.achSnapshot`，把 `players` / `leaderboard` / `world_progress` /
   `chamber_records` / `player_characters` / `equipment` / `wish_history` 的聚合拼成一张快照）
   和 `ACH_STATS` 对齐，没有任何东西在进度发生时被写。于是**进度是追溯的**：这个文件出现之前
   的存档一上线就显示自己真实的数字，一个新建的游客账号已经欠着两档（两名角色、五件圣遗物）；
   也**没有可以跑偏的东西**，因为没有需要同步的第二份状态。分档表在 `shared/`，
   所以面板算出来的数字和服务端付钱用的数字是同一个函数（`achState` / `achSummary`）。
2. **每个统计量必须单调。** 一个会变小的数字会把一个尚未领取的成就**取消掉**，所以当前余额
   （摩拉、树脂、背包数量）故意不在表里，而两个真的会回退的东西被单独处理：**每日委托不计入
   `quests`**（`resetDailies` 每天早上把它们翻回 active），**好友是终身累计而不是
   `count(friends)`**（删好友会让它变小）。
3. **确实推导不出来的，才进 `players.stats` 这个终身累计袋**（烹饪、采集、对话、结识——没人
   记一盘菜或一句话，采集点还会在自己的进度行上重新长出来）。增量在 SQL 里做
   （`jsonb_set` + `COALESCE(...)+$3`），所以同一 tick 里两次事件不会丢一次计数。

**事件必须由验证过动作的那条路由产生，这一条是承重墙。** 累计袋挂在
`progression.advanceQuests` 这个所有玩法事件都流过的漏斗上。曾经还有一条
`POST /api/quest/event`，`{kind,target,count}` **来自请求体**——它是给「模拟跑在浏览器里」的
单机客户端上报用的，代价是脚本 POST 一串 `{kind:'cook',count:99}` 就能印原石（成就按档付钱），
也能凭空完成任务领 20–120 原石。查下去发现它**根本没有调用者**：每一种 stage 等待的事件都已经
有一条会先验证动作的路由（宝箱必须是当前地区里没开过的 POI、敌人必须在这个地区里且过速率限制、
菜谱必须付得起材料），单机的击杀也是走 `POST /api/world/kill`。所以这条路由**删掉了**，
`QUEST_EVENT_SOURCES` 记下每种 kind 由哪条路由产生，`questGateReport()` 双向检查——
少一个产生者就意味着某条任务链会永远卡住，多一个没人等待的产生者就是死代码，两个方向都报错。
`advanceQuests(player, event, { trusted = true } = {})` 的开关保留着（跨进程事件源以后还会用到）。

分档奖励由 `TIER_GEMS`（10/20/30/60）定价，领取的 UPDATE 带着
`WHERE tier < $3`——**这就是连点两次只付一次的原因**，而不是客户端的按钮禁用。
HUD 右上角那个 ★ 徽标和信箱同一个套路：开局自己抓一次，数的是**可领取的档数**而不是已达成的
成就数（一个领了也不消失的红点是噪声）。数据只有作者写的键、没有消费者时最容易腐烂，所以
`achGateReport()` 双向检查（每个成就的 `stat` 必须已声明、每个声明的统计量必须有成就读它、
每个 `lifetime` 必须有写入者），`tools/api-check.mjs` 再额外断言**服务端快照的键集合等于
`Object.keys(ACH_STATS)`**，两个方向都比。

**交互**
纯鼠标可玩：左键点地移动、点怪锁定攻击、点 NPC/宝箱交互，
右键拖动转视角，滚轮拉近拉远。键盘 WASD + 空格 + Shift + E/Q 同时有效。

**声音**
BGM 与 **34 条音效**全是 WebAudio 现场合成的，没有音频文件：三条总线（music / sfx / master），
每个场景有自己的和弦进行与配器，战斗中会切到紧张段落。音效覆盖挥剑/重击、跳跃、落地
（音量按下落速度）、冲刺、脚步、命中与暴击、受伤、治疗、敌人挥击、死亡与 boss 死亡、
技能与爆发、切人、开箱、掉落、采集、解锁、解谜、任务、升级、突破、胜负、秘境开场、
祈愿（含五星）、UI 点击/开关面板、操作被拒、传送。**敌人和其他玩家的声音按距离衰减**，
约 71 米归零（流式半径 130 米）。词表 `SFX_CUES` 逐条声明「哪个文件该放它」，
由 `tools/audio-check.mjs` 双向对账——这一条的来龙去脉见[开发日志](docs/开发日志.md)「挥剑、起跳、落地都没有声音」。

---

## 接口

REST（`Authorization: Bearer <jwt>`，除注册/登录/游客外都要）：

```
POST /api/register  /api/login  /api/guest
GET  /api/player/state          POST /api/player/save  /api/player/party  /api/player/cook
POST /api/char/levelup  /ascend  /talent  /equip  /unequip  /autoequip
POST /api/inventory/use  /salvage  /enhance  /lock  /weapon/levelup  /weapon/refine
GET  /api/quests                （没有上报事件的路由，也没有重置每日的路由，见「每日委托」）
GET  /api/wish/pools  /api/wish/history        POST /api/wish/pull
GET  /api/zones  /api/leaderboard  /api/online  /api/chat/recent
GET  /api/social/friends       POST /api/social/request  /accept  /remove
GET  /api/shop                  POST /api/shop/buy
GET  /api/mail                  POST /api/mail/claim  /api/mail/seen  /api/mail/delete
GET  /api/achievements          POST /api/achievements/claim   （不带 id = 全部领取）
POST /api/world/chest  /puzzle  /unlock  /gather  /teleport  /talk  /chamber  /kill
GET  /api/health  /api/stats
```

这一整套接口由 `node tools/api-check.mjs` 逐条验过（见「验证工具」）。

WebSocket `ws://host/ws?token=<jwt>`，消息名见 `shared/src/protocol.js`
（`C2S`：hello / joinZone（可带 `follow`：加入某个好友所在的 shard）/ input / attack / skill / burst / switchChar / interact /
chat / party* / revive / startChamber / emote / mark；`S2C`：welcome / zoneState /
snapshot / damage / enemy* / playerAction / loot / party / questUpdate / chamber /
buff / …）。

数据表：`accounts` `players` `player_characters` `inventory` `equipment`
`quest_progress` `world_progress` `chamber_records` `wish_history` `friends`
`chat_log` `leaderboard` `shop_purchases` `mail` `achievements`
（`achievements` 是整个 schema 里最小的一张表：`(player_id, ach_id, tier)`，
只存「付过钱到第几档」，因为那是唯一一件聚合查询复现不出来的事）。

---

## 验证工具

这台机器上没有显示器，所以所有画面验证都是无头跑的：
Puppeteer + Firefox + Xvfb + llvmpipe（软件 WebGL）。

```bash
Xvfb :99 -screen 0 1400x900x24 &
node tools/check-all.mjs               # 一条命令跑完 43 个探针，逐个写日志，exit 0 不算证据
node tools/check-all.mjs --group data,http   # 只跑不开浏览器的那一半（约 13 秒，664 条）
node tools/check-all.mjs --only death,mp     # 按名字子串挑；--skip 反过来；--list 只打印计划
DISPLAY=:99 node tools/play.mjs        # 开一局，跑一遍主要交互，收集 console 错误
DISPLAY=:99 node tools/shot.mjs        # 截图
DISPLAY=:99 node tools/scene-probe.mjs # 场景统计：draw call、三角面、fps
DISPLAY=:99 node tools/prop-cam.mjs oak  # 自由相机对着某个植被/岩石拍四张特写
DISPLAY=:99 node tools/prop-cam.mjs abyssArch abyssTrial  # 固定数量的装饰（遗迹/灯/副本墙体）也能拍
DISPLAY=:99 node tools/prop-cam.mjs monument mondstadt     # POI 上那些单件（宝箱/神像/方碑/取暖点）也能拍
DISPLAY=:99 node tools/prop-check.mjs   # 六个区域里每一种 prop 的像素门禁：藏起来再拍一张，差集就是它自己
DISPLAY=:99 node tools/prop-check.mjs abyssTrial frostCavern # 只跑指定区域（这时覆盖率那两条会 SKIP）
DISPLAY=:99 node tools/vault-cam.mjs    # 三个副本抬头看顶：有没有顶、有没有形体、比地板暗、不是雾色
DISPLAY=:99 node tools/inlay-cam.mjs    # 同三个副本压头看地板花纹：关掉 uInlayMix 的差集就是花纹本身
DISPLAY=:99 node tools/tour.mjs         # 六个场景各转一圈四张图，回归门禁（默认钉在 high 画质）
DISPLAY=:99 node tools/tour.mjs --tier low   # 同上，但钉在最低档：用来量降档到底牺牲了多少
DISPLAY=:99 node tools/tour.mjs --adaptive   # 交回自动画质：问的是「governor 能不能撑住这个场景」
DISPLAY=:99 node tools/shop-check.mjs   # 商店面板：真浏览器点购买，验钱包/库存/限购标签一起动
DISPLAY=:99 node tools/mail-check.mjs   # 信箱：HUD 徽标自己出现、领取入账、删除已读后重开不会重发
DISPLAY=:99 node tools/ach-check.mjs    # 成就：★ 徽标自己出现、进度条按数字画、领取入账、重开不再重发
DISPLAY=:99 node tools/quest-check.mjs  # 任务：委托与魔神任务都在、阶段条是真几何、每日刷新倒计时在
DISPLAY=:99 node tools/puzzle-check.mjs # 解谜：鼠标点亮一圈方碑，量点亮前后的纹章/元素球像素
node tools/quality-check.mjs           # 自动降档控制器的收敛/抗抖单测，虚拟时钟，不需要浏览器
node tools/gamut-check.mjs             # 调色板过一遍 ACES，查有没有通道被 clamp 掉
node tools/pixstd.mjs a.png x,y,w,h,标签  # 量某块矩形的均值/标准差，判断“有没有细节”
DISPLAY=:99 node tools/grade-ab.mjs abyssTrial # 同一机位跑多套后处理参数，逐块对比像素
DISPLAY=:99 node tools/nan-scan.mjs    # 六个区域逐个流式载入，扫每条顶点属性有没有非有限值（25 条）
node tools/humanoid-check.mjs          # 检查人物骨架比例与蒙皮权重，以及衣服不能读成裸皮
DISPLAY=:99 node tools/npc-cam.mjs     # 逐个村民正面特写，从屏幕反解上衣 albedo 与皮肤的差
DISPLAY=:99 node tools/enemy-cam.mjs   # 服务端真刷出来的那只怪：弱点看不看得见、出场特效、粒子透视
DISPLAY=:99 node tools/audio-check.mjs # 声音：34 条效果的词表双向门禁、离线合成、真页面按键驱动
node tools/audio-check.mjs --no-browser # 同上但只跑前两节（词表 + 假 AudioContext），不需要显示器
node tools/mp-check.mjs                # 两个客户端的联机端到端检查，不需要显示器
DISPLAY=:99 node tools/mp-view.mjs     # 联机的像素证据：真浏览器里另一个玩家看不看得见（43 条）
node tools/build-check.mjs             # 升级/换装/编队有没有真的进到正在跑的战斗里，不需要显示器
DISPLAY=:99 node tools/solo-check.mjs  # 拦掉网关 WebSocket，验证单机模式真能玩
DISPLAY=:99 node tools/social-check.mjs # 好友面板 + 「前往好友世界」，点着走一遍
DISPLAY=:99 node tools/bag-check.mjs   # 背包面板 + 圣遗物强化/锁定，点着走一遍
node tools/proc-check.mjs              # 有条件的武器被动/套装/天赋真的会触发吗，不需要显示器
node tools/api-check.mjs               # 整个 REST 接口的端到端检查，不需要显示器
node tools/balance-check.mjs           # 战斗与养成数值审计：内容到底打不打得过，不需要显示器
node tools/balance-check.mjs --curve   # 玩家输出 vs 怪物血量的成长曲线对照表
node tools/balance-check.mjs --finale  # 最终 boss 按队伍等级逐档的难度扫描
node tools/balance-check.mjs --stars   # 按实测通关时间反推每层的三星门槛与限时
node tools/chamber-check.mjs           # 秘境波次与地脉异常有没有真的改变战斗，不需要显示器
DISPLAY=:99 node tools/chamber-ui.mjs  # 在浏览器里真打两层秘境，验横幅/计时块/地脉行/换波 toast
node tools/resonance-check.mjs         # 元素共鸣：八条共鸣的词表双向门禁 + 真的进到了战斗数值里
node tools/char-check.mjs              # 十四人名册：技能字段的双向门禁、可获得性、发型词表、强度对照
node tools/char-check.mjs --verbose    # 逐人打印 skill/burst/combo dps、起爆时间、治疗量
DISPLAY=:99 node tools/party-ui.mjs    # 队伍面板的共鸣行（亮/灭两态量像素）+ 十四个人真的建成模型
DISPLAY=:99 node tools/resonance-ui.mjs # 同一块面板，但用真账号真点击：默认视口里看不看得见、点掉角色行会不会灭
node tools/food-check.mjs --no-browser # 料理/食物：效果字段的双向门禁 + 拒绝矩阵 + 真实例里吃一口
DISPLAY=:99 node tools/food-check.mjs  # 同上再加浏览器：真采集真烹饪，满血按钮为什么是灰的，buff 芯片倒计时
node tools/wish-check.mjs              # 祈愿：20 万抽对着解析曲线、软/硬保底、50/50 与大保底、真账号花钱
DISPLAY=:99 node tools/wish-check.mjs  # 同上再加浏览器：面板印的每个数都是服务端发的数，含星辉/星尘（122 条）
DISPLAY=:99 node tools/tutorial-check.mjs # 新手引导：真键真鼠标走完 11 步、卡片像素、reload 后进度还在（75 条）
DISPLAY=:99 node tools/questnav-check.mjs # 任务导航：29 个阶段 × 5 个区域都解析得出位置，箭头/小地图/大地图/面板四处像素与坐标（77 条）
DISPLAY=:99 node tools/questend-check.mjs # 任务结算：真的打完序章读结算卡，奖励对着钱包核，下一章当场接上（55 条）
DISPLAY=:99 node tools/death-check.mjs # 倒下与复苏：锚点门禁两个方向、真死一次、倒计时、地图上的 🔒（106 条）
DISPLAY=:99 node tools/mouse-check.mjs # 鼠标全套手势：点地面/双击冲刺+标记/按住蓄力/左右中键拖动/滚轮/点敌人打死它/点宝箱走过去开/面板吞点击（85 条）
DISPLAY=:99 node tools/react-check.mjs # 元素反应：11 个反应各拍一张对着 default 分支比，外加一次服务端真打出来的端到端反应（170 条）
node tools/react-check.mjs --no-browser # 同上只跑词表与接线两节，不需要显示器
DISPLAY=:99 node tools/react-check.mjs --no-catalogue # 只跑端到端那一节（附着→切人→触发，四相位）
```

**探针本身会撒谎，而且撒得很有说服力。** `/tmp` 是 tmpfs（写满了 suite 会「停住」而不是变红）、
llvmpipe 默认把画质档位启到 `low`、第二个页面会让 Firefox 把 rAF 节流到 2 fps、
一帧刚换场的画面还在收敛——这些坑每一个都曾经让一个绿色的探针在看一张没人会看到的画面。
它们的来龙去脉，连同 72 轮修复各自的读数和突变测试，都在
**[docs/开发日志.md](docs/开发日志.md)** 里。那份文档是施工记录，这份 README 是项目说明。

---

## 已知限制

- **玩家被冻结不会真的被冻住。** `p.aura.isFrozen()` 现在没有任何读者：
  水 + 冰 打在玩家身上会正确产出 `freeze` 反应、正确记 `frozenUntil`，
  但服务端不拦移动、客户端也没有对应的锁和 HUD（怪那一侧是 `e.frozen` 走
  `updateEnemy` 的早退）。这是[开发日志](docs/开发日志.md)「元素反应」那一族缺陷里同一类的最后一个洞，
  需要客户端输入锁 + HUD 提示，单独一轮做。
- ~~联机秘境的通关收据是**第一层、2★**~~ —— 已解决：`tools/deep-check.mjs` 把八层全打完了
  （**116 / 0**），1★/2★/3★ 三条时间带、五种地脉异变、两个 Boss 的相位与护盾、
  以及分账都有收据。见[开发日志](docs/开发日志.md)「秘境打深」那一节。剩下的仍然是「探针够不够强」这件事本身：
  三次跑下来 3★ 出现在第 **1、2、3、4、7、8** 层，**第 5、6 层没有被证明可达**。
  第五层差得不多（最快 37.2 秒 vs 35 秒的线，四次读数在 37–62 秒之间摆），
  第六层差得远（深渊使徒 217–250 秒 vs 120 秒的线）。所以门线是「八层里每一档都被打到过」，
  不是「每层都 3★」——后者会把「探针的配装和打法够不够好」写成产品门禁。
- 同一支探针的耗时读数**方差很大**（第五层 37–62 秒、第六层 217–250 秒）：星级断言本身是
  自洽的（读的是服务器自己的时钟，再按 `chamberStars` 判档），但任何拿「秒数」当门线的
  新断言都会是间歇红的。
- 草不投射阴影：太阳的 shadow map 是 2048 texel 覆盖 156 m，一个 texel 7.6 cm，
  3 cm 宽的草叶根本落不进去，开了也看不出区别。草丛内部的明暗改用材质里的
  根部渐变（`gfx/toon.js` 的 `rootDark`）做，不依赖 texel 大小，也不花开销。
  草仍然接收阴影，树影和角色影子照到的草会暗下去。这个 7.6 cm 现在被 `shadow-check` 当作
  回归围栏钉着（≤ 9 cm），并且同一份日志证明它压得出 46-53% 的落差。
- `shadow-check` 只在**蒙德的露天草地**上量，投射者只有角色和树两种。别的区域的地表反射率、
  雪地/岩地的接收效果、以及**模型自遮挡**（斗篷落在腿上）都还没有门禁；室内厅堂本来就没有
  太阳阴影，不在它的范围里。
- llvmpipe 上没有硬件 GPU，帧率数字只能横向比较，不能当作真实性能。
- 三个厅的地板花纹现在都由 `tools/inlay-cam.mjs` 量着（环的位置、与旁边石头的色差、
  纹理有没有被抹平、强度两头有界）。仍然没有门禁的是**中心徽章**：它在 0.075R 以内，
  机位站在 0.34R 上看不到整枚，只能靠环和辐条代表它。
- 一块方砖内部（60 cm 见方，落在一块砖正中间不含砖缝）仍然是 std 2.8-3.3。抛光石面本来
  就该比草地平，而那条经验值是拿地形校准的，所以这一条按「可接受」记下来而不是继续推幅度。
- 龙脊雪山四张里最低那张是 5.4，压在 6.0 的门线下面；判定取中位数（6.8）所以是绿的，
  但这个区域的余量比另外五个薄。
- 雾改暗之后冰封洞窟的明暗跨度变大了：冰地板 166-182，天花 48。这一轮把顶（`vault-cam`）和
  地板（`inlay-cam`）的同一批帧摊开看过之后，判定这是画面方向而不是缺陷：亮地板是冰的 albedo，
  「读成室外」这件事已经由另外两条门禁挡着（顶线落差 > 8，以及室内雾 ≤ 穹顶）。
  也没有再加「地面不许比自己的顶亮 N 倍」那条比例门禁——三个厅摊开是 3.4× / 4.4× / 1.3×，
  任何一条三个都能过的门线都是免费的门线。地板本身仍然是全游戏最亮的地表（草地是 132）。
- 动作有 `motion-check`（24 个剪辑的剪影 + 词表双向 + 攀爬），但它拍的是**手动摆到某个
  phase 的单帧**。「脚有没有滑步」这一条现在由 `gait-check` 补上了（把 14 个角色推着走，
  量支撑脚的世界位移、步频、骨盆起伏、腾空高度，8 个速度覆盖两个档位边界）；
  仍然没有门禁的是**缓入缓出的形状**和**连段之间的衔接**——攻击/受击/技能这些非 `paced`
  剪辑没有「身体走了多远」这个外部参照，所以没有类似的推导量可以钉。
- `prop-check` 只拍每个区域**离出生点最近的那一个** instance，
  同一种 prop 的其它随机变体（`rand` 抽出来的高度/偏移）不在门禁里。
- `prop-check` 的方位角锚在出生点方向，所以它量的是「玩家从场地里看这一面」。
  prop 的背面、以及被别的 prop 挡住时的样子，仍然只有 `prop-cam` 手工看。
- ~~`enemy-cam` 的**远处火花大小比**（门线 8-30×）会飘~~ —— 已解决，但不是按当时写的办法解决的：
  钉住取景是治不了的，因为飘的原因是**背景**（additive sprite 过 tone map 之后，压在亮天空上
  柔边被吃掉）。现在这一节把世界和主角都藏掉、在黑底上拍，量直径比对上实测距离比，
  九种敌人两遍都是声明值的 100-102%，噪声地板 0 px。见[开发日志](docs/开发日志.md)「要钉的不是取景，是背景」那一节。
- ~~**霜狼背面机位有一块 2.17% 的白斑**~~ —— 已解决，而且当时写的病因是错的：那块白斑在轮廓
  **里面 32 px**（Chebyshev 距离变换），fresnel 边光（`1 - N·V ≥ 0.70`）到不了那里，
  所以「按白斑到边界的距离加权」这条计划中的门禁在它身上会读到 0 px。真正的病因是
  `bands: 2` 的皮毛在一块平面上的漫反射亮带 + 太亮的 albedo，修法是 albedo 第三步
  （`0x93b0cc → 0x86a1bd`）加上「每只怪的高光用自己皮毛的色相」（`hideSpec`）。
  读数 **651 px / 2.17% → 230 px / 0.43%**（门线 1.2%）。见[开发日志](docs/开发日志.md)
  「那块白斑不是边光，是一块被打平的面」与「高光是加上去的，所以平面会白掉」两节。
- ~~`enemy-cam` 只有 6 行、12 个机型里 6 个没有门禁~~ —— 已解决：现在 **12 行 12 个机型**，
  骨架靠前六行、配色靠后六行（白斑和高光色相这两节读的就是配色）。
- `enemy-cam` 的高光色相那一条对**遗迹守卫 SKIP**：它的 `body` 是暖灰（`0x6b6a62`），
  `hideSpec` 按定义给出的高光几乎就是白的（`0xfffdf1`，落差 5.5%），洪水读数 6.8% vs 2.6%
  分不开。对价是两条不用拍照的 uniform 断言（高光落差 = albedo 落差 × 0.66，
  以及涂白必须让它不成立），那两条每个机型都跑。仍然没有门禁的是**这块灰甲上的高光是不是
  好看**——那是审美，不是测量。
- `enemy-cam-boss`（暴风之主）的 `back-head` 取景断言余量只有 1 px：头框上沿量到 y = -1，
  同一个构建复跑时它绿了。这一条是「头框占画面长边 ≤ 73%」的边界抖动，不是模型问题，
  但如果再红一次，要改的是取景推导而不是那条 73%。
- ~~`react-check` 的照片是把 payload 直接喂给客户端的 `_onDamage`~~ —— 已解决：第 4 节
  是真的**附着 → 切人 → 触发**，光由服务器算出来的 `reaction: 'swirl'` 点亮（见[开发日志](docs/开发日志.md)「让服务端自己打出一次反应」）。
  剩下的限制是**覆盖面**：端到端只拍**一个**反应（扩散），一个来袭元素组合（风打炎），
  一个怪（蒙德那只遗迹守卫）。另外 10 个反应仍然只有喂 payload 的那 134 条照片门禁
  ——它们证明的是「客户端画对了」，不是「服务器会在真打里发出这个 key」。
- ~~反应的画面只在**一个相位**（0.25 s）下拍过~~ —— 已解决：端到端那一节按
  0.05 / 0.2 / 0.45 / 1.2 s 四个相位拍，要求前三个**互不相同**、第四个和命中前那一帧
  **逐位相同**（0 px，即效果真的结束了）。仍然只有一个相位的是**目录那一节**（11 个反应
  × 2 个 target）：给 11 个 key 每个都加四相位，是 88 张帧和四倍的运行时间，
  没有证据说形状展开的缺陷是按 key 分布的。来袭元素只覆盖了
  水和炎两种：按元素着色的那一支（扩散/绽放）有「换元素必须变色」和「冻结换元素必须不变」
  这一对断言，但七种元素逐个的颜色没有逐一拍照。
- 六个反应音效的断言是「被要过、而且在 sfx 总线上可闻」。**它们彼此听起来像不像**没有量过——
  波形相似度这种门禁这个仓库里不存在，配方之间的区分（往上/往下、点状/连续、有没有尾巴）
  是写在注释里的设计意图，不是测出来的事实。
- 扩散和绽放共用一张画面和一个声音，冻结和结晶共用一个声音。这是**设计**（要分辨的是
  「发生了什么」而不是「哪两种元素」），探针把它当作恒等式钉着（共用 case 必须逐位相同），
  所以以后想给绽放单独一支画面，得先改这条断言——这是故意的。
- 线上部署是**单任务**的：每次 `redeploy` 有约 1 分钟不可用，同一时刻只有一个世界。
  这不是配置懒——世界模拟活在进程里（见[开发日志](docs/开发日志.md)「上云这一趟」），两个任务就是两个世界。
  横向扩容要先把 zone 实例搬出进程（Redis pub/sub 或者专门的模拟进程），那是另一个工程。
- 线上没有 `/api/dev/*`（`NODE_ENV=production`），所以 `api-check` / `mp-check` /
  `deep-check` 这些**靠 dev 钩子给自己发装备的探针跑不了线上**；线上能跑的是
  `deploy/smoke.mjs`（24 条）和浏览器的 `tools/play.mjs`。要在线上验一次八层秘境，
  得先用真实途径把号练起来，那需要几个小时的挂机而不是几分钟的探针。
- 线上用的是 CloudFront 默认域名（`*.cloudfront.net`）和 AWS 自带证书，没有自定义域名、
  没有 ACM 证书、没有 Route53 记录。要换自有域名，得加 ACM（必须在 us-east-1 签）、
  给分发加 `Aliases`，然后把 `deploy/deploy.sh cdn` 那段配置里的 `ViewerCertificate` 换掉。
- RDS 是单可用区 `db.t4g.micro`、备份保留 1 天，ElastiCache 是单节点无副本。这套配置的
  意思是「一个能玩的公开 demo」，不是「不会丢档」：一次 AZ 故障就是一次停机，
  最坏情况会丢掉最近一天的存档。
