# 提瓦特在线 · Teyvat Online

一个原神风格的开放世界动作 RPG。前端 Three.js 实时 3D，后端 Fastify 权威模拟，
PostgreSQL 持久化 + Redis 缓存与在线状态，支持单机与多人在线同场景战斗。

**没有任何美术资源文件**：全部角色、怪物、地形、植被、建筑、武器、特效与音效
都在运行时用代码生成（程序化建模 + 程序化合成音频）。整个仓库里没有一张贴图、
没有一个模型文件。

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
`balance-check` 那一节里有完整的账。

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
「三个秘境只装得下一个人」那一节。
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
由 `tools/audio-check.mjs` 双向对账——这一条的来龙去脉见下面「挥剑、起跳、落地都没有声音」。

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

**`/tmp` 是内存，不是磁盘。** 这台机器的 `/tmp` 是 16 GB tmpfs，而一次完整 `check-all` 会往里写
120-520 MB 截图，并且每一个被 timeout `SIGKILL` 掉的浏览器都会留下一个 ~95 MB 的 Puppeteer
profile 目录。攒到 60 个 run 目录 + 54 个孤儿 profile 之后，一次跑到第 26 个探针的 suite
**不是失败，是停住**：`ENOSPC` 从写日志的 WriteStream 上抛成未捕获的 `'error'` 事件，
Node 打了一段栈就退了——没有红行，没有总数，后面 34 个探针一个都没跑，而日志尾部长得像
「某个探针崩了」。所以 `check-all` 现在开跑前自己做家务：删掉除最近 4 次以外的 run 目录、
在没有浏览器活着的时候清掉孤儿 profile、然后报告剩余空间，低于 4 GB 门线**拒绝开跑**
（一个注定死在第 26 行的 suite 不该开始）。日志 sink 上也挂了 `'error'`，
磁盘中途满了只会让那一行变红，不会再带走整个 runner。

**看图之前先确认这张图是哪个档位渲的。** `engine/perf.js` 会从 renderer 字符串猜初始档位，
llvmpipe 命中「软件光栅器」那条规则，于是这台机器上的浏览器探针一律从 `low` 起步，
并且自动画质会在几个坏帧之后继续往下踩。`low` 意味着 `uDetail 0.3`（地形的 clump/grain/fine
和 20 m 内的近场草皮几乎被关掉）、散布密度砍半、无阴影、无 bloom、DPR 1.0——那是一帧
**目标硬件永远不会显示**的画面。同一机位、同一场景，蒙德平原实测：

| 档位 | 三角面 | draw call | 近处地面 std | 远坡 std |
|---|---|---|---|---|
| low | 945,674 | 277 | 4.8 / 6.2 | 10.6 / 12.6 |
| high | 3,189,738 | 500 | 11.4 / 15.5 | 12.7 / 16.9 |

按 `pixstd.mjs` 自己的经验尺（std < 4 是真没细节，8-15 是正常地面），`low` 的近处地面
基本就在「没细节」的门槛上，`high` 是正常地面——**「地面看起来是一片平的绿」曾经是档位的结论，
不是着色器的结论**，而且这个误判已经浪费过一轮 review。所以 `tour.mjs` 现在默认把档位钉在
`high`（`--tier` 可改，`--adaptive` 回到旧行为），开跑前先关掉自动画质，每个场景拍完还要复查
档位没被偷偷踩下去——档位中途变了和拍错场景是同一种谎。代价是软件渲染下 fps 从 7 掉到 1~2：
这个数字本来就只说明 llvmpipe 有多慢，跟目标机器无关，现在只是「钉住档位之后的 llvmpipe 数字」。

**调色的算子是 display-referred 的，后处理链里的数值是 scene-linear 的。** 这两件事错配过一次，
代价是整个游戏的暗部：调色 pass 里那行 `c = (c - 0.5) * 1.06 + 0.5` 跑在 tone mapping **之前**，
输入不是 0..1 的显示值而是场景线性 HDR，于是它对每个通道减掉一个固定的 0.03——低于
0.028 线性（约屏幕上的 18/255）的东西全部被结尾的 `max(c, 0.0)` 削成纯黑。深渊试炼场
的地面因此拍出来是 `rgb=[0,0,46]`、luma 3.3、std 0.3：石板缝、法阵环线、火盆的光斑
全都算出来了，只是整段信号被压在削波点下面。用 `tools/grade-ab.mjs` 在同一机位上一档一档
试出来的：

| 变体 | 近处地面 | 中距地面 | 水晶 | 红绿被削掉的像素 |
|---|---|---|---|---|
| 原样（uContrast 1.06） | luma 3.3 std 0.3 | 7.1 / 4.9 | 121.3 | 100% |
| uContrast 1.0 | luma 22.2 std 1.2 | 31.0 / 9.5 | 129.9 | 0% |
| 整个调色 pass 关掉 | luma 12.9 std 1.3 | 22.4 / 10.3 | 126.7 | 0% |

也就是说这一行对高光只值 8 个 luma，却吃掉了游戏里每一个暗面。现在对比度改成绕
18% 中灰的幂函数（`c = MID * pow(c / MID, uContrast)`）：中调的支点一样，单调、永不过零，
黑点留在场景放的位置上。修完同一机位复测：近处地面 luma 19.3、削波 0%，中距 std 9.4，
水晶 130.6——暗部回来了，亮部几乎没动。

`grade-ab.mjs` 本身也踩了一个坑，值得记一笔：它最早用**第二个页面**去解 PNG，而第二个页面
一抢到焦点，Firefox 就把游戏页面的 requestAnimationFrame 节流到 1 fps 以下，于是除第一张
以外每张截图都是同一帧陈图——它连「把整个调色 pass 关掉」都测成了「没有区别」。所以
现在 PNG 在 Node 里解（`tools/lib/png.mjs`），并且每轮都等渲染器的帧计数真的往前走了 4 帧，
还有两个**控制变体**（把画面染红、把相机转 90°）必须让至少 2 万个像素变化，否则整轮判为无效。
探针自己不会告诉你它在量一张陈图，除非你专门给它准备一个必须变的东西。

## 副本的墙：地形高度场不是建筑

三个副本（`abyssTrial` / `frostCavern` / `goldenHall`）过去都拍成「一望无际的平原 + 远处一圈雾」。
原因不是缺光也不是缺贴图：`heightAt` 在 `terrain.arena.radius` 之外把高度场抬了 44 m，
所以「墙」其实是地形，而地形在雾线上、没有受光的立面、也没有任何尺度参照。
**高度场能挡住路，但不能告诉眼睛这是个房间。**

现在每个副本在 `props.enclosure` 里声明一圈墙体模块，由 `World._buildEnclosure` 摆放：

```js
enclosure: { kind: 'abyssArch', span: 8.2, inset: 2.2 }   // frostCavern 用 iceCurtain，goldenHall 用 goldArcade
```

三条经验，都是量出来的，不是推出来的：

1. **数量先定，跨距后算。** `count = round(2πr / span)` 之后 `span = 2πr / count` 再传给配方。
   两个值各自独立选，40 个模块攒下来的误差一定会在某处露出一道生地形的缝。
2. **立面的可读性来自反照率和高度，不来自灯。** 副本的太阳几乎垂直（`sunDir.y ≈ 0.93`），
   墙的立面拿不到直射光。第一版 `abyssArch` 用 `MATS.abyssStone()`（0x3a3550）配 0x14142a 的雾，
   整圈墙拍出来只剩几根发光的肋条；换成 `MATS.abyssWall()`（0x5c5590）并把墙升到 17.5 m 之后
   同一个矩形从 luma 3 变成 30.3、std 21.4。高度同样重要：11 m 的柱廊在 50 m 外只占 12° 画面，
   那是一条地平线，不是一个房间。
3. **悬空的东西要挂在某个东西上。** 第一版 `iceCurtain` 的钟乳石固定从 y = 12.2 往下长，
   上面什么都没有，整圈拍出来是一排浮在半空的栅栏；改成从三块高低错落的岩壁板的顶边往下垂之后，
   才读成「洞顶压下来」。同一版还有一块浮在空中的冰台，直接删掉了。

改完三个副本的墙面矩形：abyssTrial luma 30.3 std 21.4、frostCavern 119→137 std 33.4~38.7、
goldenHall 91.5 std 20.1，clip 全部 ≤0.01；三角面 293k→326k / 352k→438k / 318k→416k，
相对开放世界的 3.19 M 仍然便宜得多。顺便把 `frostCavern` 的冰从 0xc8e4f2 压到 0x9cc0d4、
日照 0.85→0.6、环境光 0.8→0.62：原来地面 luma 199 std 6.2——比蒙德的草地（132）还亮、
比裸岩还平，**一个没有余量的表面既显不出细节也显不出火光**。现在 160~175。

还有一个不是 bug 的现象值得记下来，免得下次又去查材质：`frostCavern` 里雪岩上那块
鲑鱼色的面，是 `warmth` POI 的篝火（`color: 0xff8a3c`）从相机背后打出来的暖光，
冷色洞窟里一块暖色的岩面就是这个机制想要的对比。判定它的办法是先看光源清单，
而不是先怀疑 `shadowTint`。

`prop-cam.mjs` 是判断模型和材质用的，跟帧率无关：第三人称相机做不了这件事——
镜臂会被身后的东西挤到最短的 1.9 m，角色永远挡在镜头和目标之间，而且 rig 每帧都会把
`fov` 拉回 `fovBase`，写进去的长焦在截图之前就没了。所以它先 `game.stop()`
（停掉主循环相机才留得住），把角色藏起来，手动摆相机再直接调 `renderer.render`。
顺便记一下 rig 的朝向是 `(-sin yaw, ·, -cos yaw)`，yaw = π 看向 +Z。
它认三种来源，因为一个地区把 props 放在三个地方：流式加载池（草木岩石）、
`world.landmarks`（固定数量的遗迹/灯/副本墙体），以及**POI 上那些单件**——
宝箱、神像、传送锚点、取暖点、副本门、还有解谜环上的每一座方碑，它们是
`buildProp()` 出来的普通 `Group`（名字 `prop:<kind>`），既不在池里也不在 landmarks 里。
第三种以前会得到「no 'monument' instances」——游戏里一半的可交互物件**拍不出来**。
补上之后第一张图就抓到一个 bug：方碑的元素纹章 `rotation.x = π/2`（从那些要把
`ring` 放平的调用点抄来的）让它躺平并且比它要贴的那面还宽，于是它是一枚
**悬在碑体旁边的白色椭圆**；而一个未点亮的纹章看起来就是在发光，等于把解谜唯一的
反馈通道（死石头 → 亮起来）抹掉了。现在半径、厚度和 z 都是从 loft 的剖面算出来的。

`mp-check.mjs` 不开浏览器：软件渲染下同时开两个 WebGL 上下文各只有 1 fps，
所以它直接用 Node 自带的 WebSocket 按 `shared/src/protocol.js` 跟网关对话，
开两个游客账号进同一个场景，逐条断言联机真正需要成立的事——同一个 shard、
互相收到 `playerJoin` / `playerLeave`、双向快照里都有对方、走 18 m 位置同步过去
且没有被反作弊纠正、区域聊天、组队邀请与双方名单、两人看到的怪物是同一批实体
（enemy id 完全重合）、以及 `JOIN_ZONE {follow}` 的四种结局（陌生人被拒、好友离线被拒、
落进好友的 shard、落在对方身旁 2.5 m）。
后一半是**联机秘境**：非队长先进 `abyssTrial`（分片必须叫 `p{队长}` 且 `mode` 仍是
`online`）、队长跟随进同一个实例、双向快照里都有对方、不在队里的好友被答
`friend_is_solo` 且同一次 `/api/social/friends` 里 `joinable` 一真一假、
`START_CHAMBER {floor:2}` 被答 `previous_floor_locked`、一个人开启挑战两个人都收到
`CHAMBER start`、两份快照里的 `chamber` 和怪物 id 完全一致、两人走进场地打到团灭
（`failed/'wiped'`、没有 `reward`、场地清空）、队长退队后由被顶上来的队长把他邀回来、
跟随落点仍是**原来那个** `p{旧队长}` 实例，最后离开秘境回到蒙德的**公共** shard。
60 项断言全通过，退出码是失败条数。
故意触发的错误列在 `expectedErrors` 里，其他任何 `S2C.ERROR` 都算失败。

`mp-view.mjs` 补上 `mp-check` 缺的那一半：**另一个玩家到底在不在屏幕上。**
`mp-check` 的每一条断言都是关于一段 JSON 的，而一个收着完美快照流却什么都不画的客户端，
从服务端看起来一模一样——这个仓库反复出过这种 bug（`uVaultCol` 那个 shader 一次都没上屏、
天神像的宝珠埋在自己的顶石里、九条音效没有调用方）。设计上的关键是**不对称**：
只开一个真浏览器（要判的就是它的像素），第二个玩家由 `tools/lib/ghost.mjs` 假扮，
只发 `client/src/net/socket.js` 会发的那些消息（同一个 `/ws?token=` 握手、同一串
`C2S.INPUT`），网关分辨不出来。开两个浏览器才是那个看起来显然、其实没用的做法：
软件渲染下两个上下文各 1 fps，而且 Firefox 会把没有焦点那页的 rAF 掐掉，两张图都是过期帧，
而「过期」和「正确」在帧差里长得一样。

站位不是写死的：页面里试 3 组机位 × 12 个方向，取第一个两个站位都落在平缓干燥地面、
都在画面里、且从相机到人的连线没被树或石头挡住（`world.blockedAt` 沿射线每米采样）的方向；
被否掉的候选连理由一起打印（`step` / `slope` / `in the water` / `a trunk or boulder 3 m along the ray`）。
矩形是从站位自己的脚/头投影算出来的，8 m 和 20 m 都成立，并且用 `elementFromPoint`
确认三块都压在 `CANVAS` 上而不是 HUD 面板上。

判定用两把尺子，因为它们的坏法不一样。**帧差**要配一张对照帧，容差是 48：蒙德的草是动的，
容差 8 时两张「空地」帧之间就有 13–17% 的像素不一样（有一对甚至 75%），容差 8 不是更严，
是坏的。另一把是 `alien()`——单张图里「不是这块地」的像素占比，参考色取**同一帧里对照矩形的均值**，
所以曝光、时辰、色调映射全都约掉了，风也吹不动它：实测空矩形整场只飘 ±0.5 个点，
站进一个人涨 25–33 个点（P1 9.1% → 36.1% → 走开后 9.4%，P2 3.7% → 34.0% → 离线后 3.6%，
对照矩形始终 11.5–12.0%）。所以「走掉」这半边也是硬断言：那块地必须**变回地面**，
而不只是「变了」——后者对一个还站在原地挥手的人同样成立。

还有一条踩过的坑写进了工具里：每张截图都先等 `Renderer#frame` 真的往前走 3 帧再拍。
llvmpipe 下 2–3 fps，`sleep` 之后拍到的可能还是上一帧，而一张过期的 PNG 会同时制造一个失败
和一个不在场证明——第 3 次跑的 `03-me-shown` 就是拿着扫描时的旧机位拍的，于是那条
「投影出来的矩形真的装着那个人的像素」读到 79.8% 的「信号」对 75.2% 的对照。现在这条断言
读到 38.2% 对 1.3%，并且十张图末尾还有一条断言说「没有任何一张是在渲染器卡住时拍的」。

除了像素，同一时刻的状态和 DOM 也一起钉：`actors.players` 里的昵称/`charId`/血量/坐标、
远端位移速度（`_syncPlayers` 从快照对算出来的，决定模型是跑还是滑）、名牌 `.wlabel .who`
的文字和它移动的方向、`进入/离开了此区域` 两行聊天、`C2S.ATTACK` 到 `attack1` 这段动画、
以及区域聊天里那条带昵称的消息。像素说「那儿有个东西」，这些说「那是**那个**玩家」。

`social-check.mjs` 是好友系统的浏览器侧：网关那半由 `mp-check` 证明，它证明的是玩家
**够得着**——申请出现在 U 键面板里、点「同意」变成好友行、好友一上线那行就长出「前往」
按钮、点下去世界真的重建到对方的 shard 且落在对方身旁。好友本人是个 Node 侧的 WebSocket
而不是第二个浏览器：软件渲染下两个 WebGL 上下文各只有 1 fps，而好友并不需要「看见」什么。
顺带钉住两条容易悄悄坏掉的提示：好友进出区域的系统消息必须**报出名字**——`S2C.PLAYER_JOIN`
带的是序列化后的实体（`{player:{id,n,…}}`）而不是扁平的 `playerId`/`nickname`，读错就是
每次有人进来都刷一行「undefined 进入了此区域」，而且「这是不是我自己」那个判断也永远不成立。
21 项断言。

`puzzle-check.mjs` 是**第一个用像素判定「玩家看不看得出来」的玩法探针**，40 项断言。
规则那一半 `api-check` 已经证完了，它证的是感知：客户端那一圈方碑必须和 `puzzleNodes` 的
推导逐个 id、逐个坐标对上（服务端按后者校验，客户端自己画一圈就是不可解的谜题）；
每座方碑各自是一个可交互物、谜题条目本身**不是**（否则站圆心点一下就能整圈点亮）；
被门禁的宝箱先说「需先解开谜题」、解完不再说；六米外**用鼠标点**一座方碑要走过去并点亮
（点击→寻路→到点交互是和按 F 不同的一条路），剩下两座按 F；然后用**同一个相机变换**
拍点亮前后两张，量纹章和元素球那两块矩形的亮度与色相（74 → 183，G−R 拉开 37，
说明它确实是风元素的青绿而不是一片白）；最后是飘字、toast、`p:` 行落库、成就里
`puzzles === 1`、reload 之后整圈仍然亮着（`applyProgress` 的 `p:` 分支）。

写这个探针的过程本身是三条经验：**测量前先让画面安静下来**——第一次「绿」的那一轮，
共鸣光柱（12 m 高、1.4 m 粗的半透明柱子）还活着，而这类探针会 `g.stop()` 停循环去摆自由
相机，于是那根柱子被**永久冻结**在画面里，从 4.6 m 用 36° 镜头看它就是整帧薄荷绿，
76 → 215 的差值是真的、原因是错的；现在先等 `vfx.*.live` 全空、`.dmg` 飘字全散再拍。
**矩形要瞄真东西**：纹章和元素球现在带名字（`monument:sigil` / `monument:core`），探针
遍历 prop 的 group 取它们的世界坐标再投影，而不是按 1.6 / 2.62 这样的猜测高度去截图——
元素球那个埋在顶冠里的 bug 恰好就是「按猜的高度量到一块没变化的石头」。
**探针里的传送要经过服务端同意**：`me.teleportTo` 单独用会被反作弊在 8 m 以上打回来
（`correction` → `me.correct` 原地传回），玩家自己的快速旅行是 `teleportTo` + `socket.joinZone`
两半，所以探针也这么走，并且**每次落点都断言自己真的到了**——第一版就是站在原地却以为
换了方碑，报出来的却是「1 号方碑的提示条写着 0 号」这种看不懂的失败。

`bag-check.mjs` 是背包面板那一侧，也是第一个真正点开背包的探针。`api-check` 已经证明了
`POST /api/inventory/enhance` 本身（成本曲线、素材记账、锁、按引用刷新装备者属性），
它证明的是玩家**够得着**：圣遗物页把秘境掉的那些列出来、选中一件会报下一级的价钱、
点「强化」之后格子真的变成素材选择器、被选中的读起来是「要被吃掉」而不是「被选中」、
确认之后**当场**重画出新等级而不是等下次开背包、锁定过一次重画还在。
它故意用**单机模式**启动：种数据要从 Node 直接调 `POST /api/world/chamber`，
而这条路对持有网关连接的人回 409 `use_socket`（就是那道防止一场战斗付两遍的守卫），
所以联机的浏览器会让探针自己没法准备数据。中途还 reload 一次——这是证明面板读的是
服务端存档而不是启动时那份快照的诚实办法（reload 会落到「继续冒险」而且模式按钮会重置回
多人在线，所以要先点回单机）。武器那一半同理：挖光蒙德的矿点、抽一发十连，然后武器页要
列得出来、矿石步进器要按持有量给（持有 0 的那几档只留一行名字，不给点不动的空控件）、
「全部」倒进去要预览出到 Lv.几和多少摩拉、确认之后格子上的等级当场变、有重复武器时
「精炼（N 把同名武器）」要在、点完格子上要多一个 `R2`。其中一条断言是**布局**的：
`确认强化` 必须在不滚动的情况下就在屏幕上——一个滚到看不见的确认按钮等于没有确认按钮
（第一版就是这样：四档矿石各占两行，`p` 还带着浏览器默认的 1em 边距，按钮被顶到列外）。
46 项断言。

顺便修掉一个让这一整段一开始**假通过**的坑：`bag-check` 的 `check()` 只打印、
**不返回**结果，所以 `if (check(...)) { … }` 是个静默的空块——精炼那一节一条断言都没跑，
报告还是「0 failed」。绿色不等于跑过，所以现在 `check()` 会 `return !!ok`，
而判断一轮有没有真的验到东西要看**断言条数动了没有**。

`api-check.mjs` 同样不开浏览器，用一个新游客把整套 HTTP 接口走一遍，269 项断言
（其中一节是 `zoneGateReport()` 的地区门禁，加上把 `client/src/gfx/props.js` 端进来
对撞 prop 名字，以及「每个 `requires` 都是一种被执行的形状」）。
它断言的不是状态码而是**后果**，因为新号的初始状态在 `server/src/db/repo.js` 里是确定的
（20000 摩拉、1600 原石、10 张纠缠之缘、流浪者的经验 ×10、甜甜花酿鸡 ×5、两个角色各带一把
初始武器、`q_intro` 停在第一阶段）：开宝箱必须让摩拉变多且掉落进背包，十连必须正好扣 10 张
纠缠之缘并返回 10 条结果且至少一个 4★，升级必须扣掉对应的经验书和摩拉并让面板攻击力上升，
采两朵甜甜花加一株麦子之后甜甜花酿鸡必须做得出来（这一条顺带证明采集和料理用的是同一套
物品 id），秘境给了 9999 秒必须 0 星、给 1 秒必须 3 星、通关必须正好扣 `DOMAIN_RESIN`
点树脂并掉出**这个秘境自己**套装池里的圣遗物（uid 要能在 `player.equipment` 里找到，
材料要进 `player.inventory`），再通一次不再付星数奖励但照样掉落，把树脂刷干之后必须
`resin.short === true`、没有掉落、星数记录照旧、树脂不倒扣。刷完那一堆圣遗物正好是强化那一段
的素材：喂上去等级要涨、只能吃掉需要的那几件、被吃的从背包里消失、摩拉按公布的费率扣、
**强化后的主词条必须等于同级自然掉落会 roll 出的值**（这一条把 `enhance` 和
`generateArtifact` 钉在一起，谁先漂了都会 FAIL）、副词条是**长上去**而不是重 roll、
穿在身上的那件强化后装备者的面板属性必须跟着动（它和角色实例是同一个对象引用，
抄一份就会让身上那件停在旧数值直到下次登录）、锁着的既不能喂也不能分解。
武器那一半的素材是**挖出来的**：先把蒙德的矿点全采一遍（这一条顺带证明矿石有去处），
一块铁块进去必须**经验守恒**——`weaponXpToLevel(等级) + 存下的 xp` 要等于升级前的同一个量
加上端上去的经验，不管这一次是升了级还是全存在武器上；上限必须正好是
`min(稀有度天花板, arCap(冒险等阶))`；把整包矿石一次倒进去必须停在上限、剩下的还在包里、
最便宜的先花；升级完装备者的面板攻击力必须涨。精炼则拿十连出的重复武器验：一把加一阶、
被动按 `refineMul` 精确变化并出现在装备者的 `typeBonus` 里、自己不能精炼自己、
不同名的不算、**锁着的不算**、多给的不超过 5 阶且只扣用到的那几把。
后面那三条要一堆同名武器，而**攒不攒得出来不能交给运气**：这一段原来写成
`if (deep.length >= 3)`，抽到两把重复而不是三把时它就把四条断言**整段跳过**，报告照旧
「0 failed」。现在它**自己攒**：开一个一次性游客，十连一发，再用初始的 1600 原石按
`GEM_PER_WISH` 换 10 张缘再来一发（20 抽摊在 5 把 3★ 上，鸽笼原理保证有一摞），
不够就去铁匠铺按 20000 摩拉买同名的补（`smith_<武器种类>`，每周 2 把）——
**用摩拉换确定性**。用一次性账号是因为主账号后面的商店、邮件、成就断言比的是精确差额，
凭空多花 4 万摩拉、多抽 10 次会把它们全带偏。破坏性的路径也要有明确答复而不是
崩：重复开箱 409、未拥有的角色 400、猜错的天赋名 400、AR 不够去龙脊雪山 403。最后注册一个
真账号、开个箱、重新登录，验证进度确实落到了 Postgres 而不只是 Redis。退出码是失败条数。

`proc-check.mjs` 在进程内直接开一个真的 `ZoneInstance`，调真的
`handleSkill`/`handleBurst`/`playerHitEnemy`，然后**立刻停掉它 20 Hz 的定时器**、手动推进 `inst.now`、
把 `critRate` 钉成 0 或 1——所以 92 条断言全是确定性的，不睡觉、不等墙上时钟、不重摇骰子。
真正让这一类 bug 不再复发的是第 1 节：它是一道**结构门禁**，
要求 `items.js`/`characters.js` 里每一个 key 要么是 `buildCharacterStats` 折进去的常驻词条、
要么是 `PROC_KEYS` 里被真正触发的条件、要么是三个描述形状的字段之一；
反方向也查一遍——`procs.js` 实现的每个触发器都得有装备或天赋认领它。
这道门禁写完的当天就抓出了天赋那一半的同一个毛病：`lowHpDef`/`healPerHp`/`shieldDR`/`overhealShield`
四个没人读，而雷电角色的 8 点回能是**反过来错**——描述写的是感电/超导，代码却在每次反应都给。
反过来错的那种更要命，所以第 9 节的能量断言不看绝对值，而是拿**不戴那套圣遗物的对照组**做差，
再按该角色的元素充能效率折算：只有这样才分得清「套装给的 6 点」和「天赋给的 8 点」。

`enemy-check.mjs` 是同一套结构门禁搬到怪物身上，25 项断言。第 1 节把
`shared/src/data/enemyGate.js` 跑一遍：`ENEMIES` 的每个 key、`ATTACK_MOVES` 的每个 key
都要在那份表里写明**谁读它**，反方向也查——声明了没人带的 key、没有怪列的招式、
没有营地和秘境刷的怪、`ENEMY_KINDS` 里没人用的建模，全算失败。因为
`client/src/gfx/enemies.js` 在 Node 下能直接 import，这道门禁还能跨层对账：
`buildEnemy` 把弱点球在**几何里**的落点导出来，跟 `ENEMIES.ruinGuard.weakspot.offset`
比，超过 12 cm 就红——美术挪了眼睛，红的是测试而不是玩家的手感。第 2~4 节则是门禁问不到的那半：
真的开 `ZoneInstance`、真的发射 `Projectile`、真的走 `updateProjectiles`，
证明打中弱点确实是 3 倍（实测 2.997×）、确实定身 1.6 秒、打胸口不是、
从背后打同一个高度不是、以及每个远程怪确实按自己那个速度射。
退出码是失败条数。

`enemy-cam.mjs` 拍的是同一件事的另一半：**光栅化之后还看得见吗**。raycast 能证明那颗眼睛
是正面第一层表面，但证不了它过完 cel 分层、bloom、雾、tonemap 和调色之后还是个目标。
它进正式场景、走 `enterZone`、等**服务端自己刷出来的**那只遗迹守卫（不是现场 `buildEnemy`，
那证明不了发布出去的场景），钉 `high` 画质，然后同一个机位拍两遍：第二遍把 `materials.glow`
改成普通金属。所以断言不是「两个矩形不一样」（对任何模型都成立），而是「眼睛那块跟旁边的
装甲差 171 字节，把发光关掉就只差 8 字节，而装甲自己只动了 9 字节」——加上 11 米外
「又亮又暖」的像素数 1108 对关掉发光后的 3。它还量出场特效和粒子透视，见下一节。

`balance-check.mjs` 问的是别的门禁都问不到的一件事：**内容打不打得过**。
它不开服务端也不开浏览器，直接 import `shared/src/sim/formulas.js` 里那套伤害管线
（跟网关跑的是同一份代码），再补上服务端强加的**节奏**——`handleAttack` 把普攻限流到
`normal.frameTime * 0.85` 并按 combo 数组轮转，元素爆发要攒 60 点能量而能量只按每次
物理命中 0.8 / 元素命中 2.4 到账，怪物则是 windup → active → recover 走完**才**开始
`attackCd`（所以丘丘人 1.6 秒的冷却其实是 2.73 秒一轮）。两边都过真正的减伤，队伍血量
按池子算，因为 `Entity.takeDamage` 是自动换人而不是倒地。23 项断言覆盖新号能不能打赢
第一个营地、每个营地和每层秘境在同级下的击杀/阵亡余量与三星门槛、把游戏里所有经验来源
走一遍能到几级、秘境门槛开出来的天花板够不够打第一层、主线按 `next` 顺序走一遍每一步
的准入、以及最后一个故事任务需要刷多少趟才打得动。「刷一趟」按**重复**通关计价，也就是只算
那一层怪的击杀经验：`chamberXp` 是按新拿到的星付的一次性里程碑，重复通关拿不到，
拿它当每趟收入会把最好的秘境高估三十倍，也就把一个只有营地答得上来的问题算成了秘境的功劳。
退出码是失败条数。

它第一次跑出来 9 项失败，全是真的设计缺陷，而且都指向同一个病根：**常数写在了超线性
曲线上**。`enemyStatAtLevel` 原本是 `1.068^(level-1)`，到 90 级是 340 倍，而玩家在同级下
的实测输出只涨 38 倍——80 级的暴风之主有 253 万有效血量，要打 457 秒，而那层的限时是
360 秒，即每个秘境的最后一层都是构造上打不过的。击杀经验 `def.xp * (1 + level * 0.05)`
和秘境奖励 `800 + floor * 400` 也是同一个毛病：线性的奖励对着 `xpForLevel` 这条超线性
的需求，55 级的丘丘人给 150 点经验去填 83540 点的一级，结果把游戏里所有内容打一遍只有
42 级，而最后一个秘境建议 55 级，差的 873593 点经验等于再刷 156 趟营地。修法是让三者都
按玩家自己的曲线计价：怪物血量改成玩家两条成长曲线（角色等级 × 武器等级）的乘积，击杀
经验和秘境奖励改成按**当前等级自己的需求**计价（`enemyXp`、`chamberXp`）。改完同级下的
杂兵击杀时间从 1.9 秒漂到 17.6 秒变成全程稳定在 1.8-2.6 秒，boss 从 107 秒漂到 865 秒
变成稳定在 93-133 秒，通关一遍到 58 级。

顺带审出来的两处不是数值的问题：`arCap` 说 AR 决定角色等级上限（`20 + AR*2`），但
`routes/world.js` 开启故事任务时用的是另一套自己发明的 `adventureRank >= minLevel / 2`，
两条规则互相矛盾——终章的 55 级按上限只需要 AR 18，按这条却要 AR 28，实测主线走到 AR 23
就卡死且没有可刷的东西能救。现在统一成 `rankForLevel`（`arCap` 的反函数），和 `arCap`
一起放在 `shared` 里，服务端、客户端和审计工具共用一份。另外 `POST /api/world/chamber`
原本不校验任何东西：新游客直接 POST `{zone:'abyssTrial', floor:8, time:10}` 就能领到
80 级那层的全部奖励，而且客户端本来就会在网关的 `cleared` 事件上调它一次——而网关的
`handleChamberClear` 已经发过同样的奖励，所以每次正常通关都是**发两遍**。现在这个路由
补上了和 `START_CHAMBER` 相同的准入（区域 AR 门槛、逐层解锁），两条路径都改成按
**新得的星数**发奖而不是按次发奖，重复通关只拿击杀经验，不再拿第二份里程碑奖励。

软件渲染下的实测（1280×800，llvmpipe）：开放世界 2-6 fps、370-490 draw calls、
0.8-2.9 M 三角面；秘境 5-6 fps、217-257 draw calls、~0.3 M 三角面。
这只能用来比较各场景的相对开销，硬件 GPU 上的帧率没有条件在这台机器上测。

植被的 draw call 由 `gfx/props.js` 的 `PropPool` 决定：整个区域每个 (原型, 材质)
只有一个 `InstancedMesh`，地形单元格进出视野时只是借还其中的实例槽位，而不是各自
新建网格。蒙德平原因此从 1963 降到 464 个 draw call，三角面数不变——瓶颈一直是
`单元格数 × 变体数 × 材质数` 的网格数量，不是实例数量。

## 副本的顶：着色器在遮挡物后面等于不存在

墙修好之后，抬头看还是一片雾。`gfx/sky.js` 里的 `VAULT_FRAG` 是专门为室内写的岩顶着色器，
把它的 `uVaultCol` 染成品红再拍——**三个副本画面顶部的色值一个数都没动**。
真正占满上半屏的是地形：`heightAt` 在 `terrain.arena.radius` 之外抬起的那 44 m 斜坡，
比天空穹顶近得多。**一个被遮挡的着色器，无论怎么改都不会出现在屏幕上；
这类问题的修法在几何，不在片元。** 验证遮挡关系的办法只有一个：把嫌疑物**隐藏掉**，
看那块矩形变不变——`world.terrain.group.visible = false` 让 goldenHall 的顶部从
[86,57,37] 变成 [37,32,31]，答案当场就出来了。

所以现在每个副本在 `props.ceiling` 里声明一个穹顶，由 `World._buildCeiling` 调
`buildVaultCeiling()` 生成：72 面 × 9 圈的非索引壳体（`domeY` 的 1.7 次幂加 5 个随机低频
凸起），底下挂肋条、两道箍线、垂饰和一枚拱心石。**它同时也是密封的**：
把边缘半径取成 `arena.radius + overhang`（比墙圈大）而边缘高度取成 `墙顶 - drop`（比墙顶低），
两个面就一定相交——从室内出发的任何一条射线，要么在边缘以下打到墙，要么穿过壳体，
而壳体的高度沿半径单调下降、射线却在上升，所以**斜坡一点仰角都不剩**。

顶面的造型不能靠光，只能靠反照率和真实起伏：副本的太阳几乎垂直（`sunDir.y` 0.90~0.94），
穹顶的每一面法线都背着它，直射项恒为 0。于是形体来自逐面顶点色（`vertexColors`）、
从拱心石到起拱线的径向渐变、以及肋条箍线垂饰这些真的凸出来的东西。

四件量出来才知道的事：

1. **常驻阴影带里，`shadowTint` 就是颜色本身。** `toon.js` 里 `shadowCol = albedo * uShadowTint`，
   一个永远拿不到直射光的面只会取到这一项。共用的冷色 `0x6a7488` 把一座金色穹顶拍成了灰罩子；
   把色调做成参数（`shadowColor: 0x9a7a4c`）之后才暖回来。
2. **两个均匀随机项比它们的区间平得多。** 标准差是 `(hi-lo)/√12`：`0.84 + 0.20h1 + 0.18h2`
   看着像 ±19%，量出来只有 7%，穹顶 std 3.8——一张灰纸。加宽到 `0.72 + 0.28h1 + 0.26h2`、
   把每隔一圈的砌层压到 0.90、再加两道**必定横穿画面顶部的箍线**（14 根向心的肋条不一定横穿），
   std 才到 5.0。
3. **`uMottle` 在 55 m 之外就没了**（`1 - smoothstep(18, 55, mDist)`），所以 25~60 m 的顶面
   拿不到片元级的颗粒，纹理必须来自顶点色。
4. **一盏没有消费者的灯 = 一个谎。** `Sky.fill` 的注释写着「让角色暗部可读」，
   可 `TOON_FRAG` 从头到尾只读 `directionalLights[0]`——这盏灯从来没照到过任何一个
   cel 材质。现在 `toon.js` 多了一个**按材质开关**的 `uFillStrength`（只有
   `MATS.vault` / `MATS.vaultTrim` 打开它），室内的 `fill` 改从**下方**照上来，
   也就是地面篝火的反弹光。三点量化和主光一致，为的是让相邻面落进不同的档。
   注意两件事：一是 three.js 交给着色器的 `directionalLights[].direction` 在**视图空间**
   （`WebGLLights.js` 末尾会 `transformDirection(viewMatrix)`），而 `vToonNormal` 是世界法线，
   所以要 `dir * mat3(viewMatrix)` 转回去；二是第一版强度给到 0.6/0.7、方向几乎正下方，
   结果**每个面的 n·L 都一样**——那是均匀提亮而不是塑形：goldenHall 顶部从 75 涨到 85，
   顶线（穹顶带与地面带的落差）从 14 塌到 5。改成 0.34/0.45、把水平偏移归一化到 34 m
   （对 50 m 的落差约 34°，和壳体自身的面倾角同量级）之后，顶线回到 8.8 而 std 反而更高。

`vault-cam.mjs` 就是为这件事写的：它把**游戏内**相机抬到 `camera.js` 会夹住的
`MIN_PITCH = -0.28`（也就是玩家真能看到的极限画面），沿画面竖直方向切 6 条带，
再对每个副本断言 10 件事——其中两条是身份断言而不是外观断言：隐藏穹顶后顶部色值
必须**变化**（按单通道最大差值，不能按 luma：[66,61,60] 和 [86,57,37] 的 luma 只差 0.1，
一个灰顶换成一个橙坡会被 luma 判成「没变」），隐藏地形后顶部色值必须**不变**
（否则说明斜坡还露着）。现在 30 项全过：abyss 顶部 luma 12.2 std 17.4、
frostCavern 77 std 13.2、goldenHall 75.7 std 5.4，隐藏穹顶的位移 15/12/34，
隐藏地形的位移 0/2/0。

## 光照空间：three.js 交给着色器的每一盏灯都在视图空间

上一节第 4 条挖出来的东西比一盏补光灯大得多。`light-space.mjs` 往场景里丢一个**球**
（材质是从当前区域现拿的真材质，所以量的是游戏里真在用的那个着色器），从四个方位角
各拍一张，比较球左半和右半的 luma。用球而不是用道具，是因为任何真实道具都不左右对称，
左减右量到的会是它的形状而不是它的光照。

`gfx/toon.js` 修好之前，四个方位角量到 **+11 / -8.6 / +10.9 / -19.6**——
**周期是 180° 而不是 360°**。这个签名没有第二种解释：把世界法线和视图空间的光方向点乘，
等于把太阳按相机自己的旋转再转一遍，于是**视在太阳以玩家转视角的两倍速度绕着走**，
并且刚好在一半的角度上和真太阳吻合（所以「四张符号是否相同」这种判据会放它过去，
第一版探针就是这么写的、也就是这么被骗的）。真正抓得住的判据是**对向方位角必须反号**：
把相机转到物体另一边，光就必须从屏幕的另一边来。

同一个原因还藏着一个更严重的：`pointLights[i].position` 也在视图空间
（`WebGLLights.js` 里 `applyMatrix4(viewMatrix)`），而代码写的是
`pointLights[i].position - vToonWorld`。这不只是照错方向——`dist` 直接变成了
**片元世界坐标那个量级**的数，于是 `att` 在离世界原点稍远的地方恒为 0：
**开放世界里所有火把、篝火、元素光效对 cel 材质一直没有任何贡献**，
而且它的衰减会随相机移动而变。副本因为竞技场就在原点附近，所以只是错得不明显。

修法是把灯搬回世界空间。`viewMatrix` 是正交的，所以右乘 `mat3(viewMatrix)` 就是它的转置、
也就是它的逆；位置还要再补一个平移：

```glsl
L = normalize(directionalLights[0].direction * mat3(viewMatrix));
vec3 lightWorld = pointLights[i].position * mat3(viewMatrix) + cameraPosition;
```

改完 `light-space.mjs` 四个方位角 4/4 吻合、对向反号，6 项断言全过。
顺带把副本拍得更好了——火盆的光第一次真的落到地面和墙上，`vault-cam.mjs` 的顶线
从 14.9/38.1/8.8 变成 **18.9/38.1/15.4**，30 项仍然全过；`tour.mjs` 六个区域无报错，
draw call 和三角面数不变（不多一次绘制，只是几行 GLSL）。

**教训：不要相信引擎把光交给你时用的是哪个空间，量一遍。** 判据要选那种**任何错误答案
都伪造不出来**的（对向反号），而不是那种「看起来该成立」的（符号恒定）。

## 剪影里面没有描边：村民的上衣读成了光膀子

`gfx/toon.js` 的描边是外扩壳，只画在**剪影上**。角色身上两块材质相接的地方
（领口、两个肘、裙摆和小腿）一根线都没有，**唯一撑住那条边界的就是两个 albedo 的差**。
`world.js` 的 `NPC_PALETTE` 前四条恰好是米色/奶油色上衣配奶油/小麦色皮肤，
蒙德那个铁匠拍出来是**光着膀子系了条腰带**。老的保护只比亮度、只拿头发当参照，
所以它从头到尾没看见这个问题。

**尺子选错过一次。** 旧代码用线性亮度差 0.22 当门槛，而线性亮度会把
一件近黑的斗篷和近黑的头发算成差 0.01（其实差 20 个字节）、把两块近白算成差 0.02
（其实差 60），并且**完全无视色相**——而「奶油上衣配小麦皮肤」这个 case 恰恰全在色相上。
现在统一用 **sRGB 字节距离**，也就是玩家屏幕所在的那个空间：

| 调色板 | 上衣 vs 皮肤（改前） | 改后 |
|---|---|---|
| 0 | 30 | 79 |
| 1 | 39 | 114 |
| 4 | 42 | 73 |

`buildHumanoid` 里的 `separateFrom` 是兜底，不是设计：它**同时**解所有约束
（皮肤 ≥48、床单/头发 ≥60），在亮度**缩放**里搜（缩放保色相与饱和度），取最近的可行解、
同分优先偏暗（白色上面没有余量，而偏暗的衣服看起来像染色或衬里）。一次解完而不是逐个推，
是因为两个参照会从两侧把颜色夹住（调色板 4：皮肤 luma 0.554、头发 0.204），
顺序推会来回振荡。近黑对**根本无法用亮度分开**（ignar 的斗篷 `#2a1a18` 对头发 `#3a2320`
在整个缩放区间上最多只有 51 字节），这种时候从**参照列表末尾**开始丢——调用处把皮肤放第一个，
所以让面积更大的「上衣/皮肤」边界赢。真正的修复还是回到调色板：把前四条重新配成
鼠尾草绿、青灰、藕色，比让保护把奶油色调暗好看得多。

**把光除掉才能量到 albedo。** `npc-cam.mjs` 不比原始像素差：肩→肘（上衣）和肘→腕（皮肤）
是同半径、同距离、只隔一条边界的两段同轴圆柱，所以在**线性空间**取它们的逐通道**比值**、
再乘上已知的皮肤 albedo，就能把上衣的 albedo 穿过 cel 分段、雾、tonemap 和调色反解出来
（实测和材质真值差 6~23 字节）。原始像素差做不到这件事：杂货商和铁匠穿的是同一套颜色，
量出来一个 53 一个 35，**纯粹因为其中一个站在阴影里**。

**单向的控制变量什么都证明不了。** 这个探针第一版把丽月的仙人打了 153 的高分——
它量的那块矩形其实落在她站的水里。「把上衣染成品红，这块没变」对皮肤、草地、水面同样成立。
所以每个村民拍三张（原样 / 上衣染品红 / 皮肤染品红），要求**两个方向都钉住**：

  上衣的染色必须让袖子那块动、且不让小臂那块动，
  皮肤的染色必须反过来。

两条胳膊都量，取两个控制都更强的那条；两条都过不了的村民直接 SKIP 并打印原因
（水里那两个：皮肤染色只动了 3 和 12 个 count）。顺带一个坑：**骨骼在关节上**，
所以以 `forearmR` 为中心的矩形是跨着肘的、会吃掉半只袖子——第一版就是这么让「皮肤」那块
在上衣染色时动了 52~63 个 count 的。量两段的**中点**才对。

修完实测：`npc-cam.mjs` **21 项全过**，反解出的上衣-皮肤差 **85 / 88 / 107 / 135** 字节
（改前 34~59，只加保护是 47~78），对比噪声比 7.8~15.3；`humanoid-check.mjs` 把可玩角色（现在 14 个）
加 7×7 的上衣×皮肤色调平面全扫一遍，全部达标（3 对近黑的布料/头发按「无法用亮度分开」记为提示）。
顺带修掉了 aurel 那条和上衣同色的奶油色裤子（18 字节）。

**教训：门槛要用眼睛用的那把尺子量，边界要从两侧钉。** 还有一条留给下一轮：
同色相的衣服/皮肤要比异色相的拉开更多才同样好认，所以 `SKIN_GAP` 该做成随色相变化的。

---

## 一个弱点得同时是数据、几何和消费者：遗迹守卫的那只眼睛

`shared/src/data/enemies.js` 里躺着这么一行，很久了：

```js
weakspot: { offset: [0, 2.2, 0.4], r: 0.5, mult: 3.0, stun: 1.6 },
```

读起来是一条完整的机制：遗迹守卫有个弱点，命中它三倍伤害、定身 1.6 秒。
`grep weakspot` 的结果是——**只有这一行**，加上 `client/src/gfx/enemies.js` 里
一句「这就是弱点」的注释，注释旁边那颗发光球被手摆在**后脖子上**，一半埋在头罩里面。
于是同一件事有三个互不相同的版本：数据说在胸口通气口（y=2.2），几何画在脑后，
注释说它们是一个东西。没有任何测试会红，因为**没人许下的承诺才会失败，没人消费的承诺不会**。

修法不是把三份对齐一次，而是让它们**只有一份**。`KINDS.ruinGuard.dims()` 现在算一个
`eye`（在头骨骼空间里），`parts()` 拿它摆那颗发光球，`weakspot()` 拿它导出一个点，
`buildEnemy` 把这个点转成「从脚底起算、+Z 朝前」的米数——也就是 `enemies.js` 里
`offset` 用的那个坐标系——挂在返回值上。仿真那边不能 import 客户端（它也在服务端跑），
所以它读的还是数据里的数；`enemy-check.mjs` 则把两边比一次，差超过 12 cm 就红。
实测 `[0, 3.251, 0.419]` vs 手写的 `[0, 3.25, 0.42]`：以后美术挪眼睛，红的是测试。

消费者那半有三个不那么显然的决定：

- **要扫掠，不能采样。** tick 是 50 ms，瞄准箭 70 m/s——**一步走 3.5 米**，比遗迹守卫
  整个碰撞圆柱还宽。拿箭这一 tick 的**落点**去比一个 50 cm 的球，即使瞄得完美也只有
  14% 命中，而且结果取决于你站多远。所以 `Enemy.weakspotSweep()` 比的是这一步的**线段**
  到弱点球心的最近距离（`updateProjectiles` 现在在 `pr.step()` 之前存下起点）。
- **倍率是倍率，不是加成。** `mult: 3.0` 乘进 `computeDamage` 的 `scaling`/`flat`，
  不是加进 `bonus`。加进 `bonus` 的话它会和元素加成、类型加成、反应倍率并成一个和，
  同一箭在不同配装下值多少完全不一样；乘进基数才让「三倍于你本来会打出的那一下」字面成立。
- **两种「弱点」不许叠加。** 原来的规则是「瞄准射击打进碰撞盒上三分之一」，对史莱姆合理
  （它没有可瞄的解剖结构），对遗迹守卫就荒唐：上三分之一里有两个肩膀，打肩膀和打眼睛
  一样值钱，那只眼睛就白画了。所以有 `weakspot` 的怪只认弱点本身
  （`headshot: weak || (!e.def.weakspot && meta.aimed && …)`），别人照旧。

反过来的那种腐烂也在同一张表里：`frostWolf.pack = 3`。`zones.js` 的营地本来就把三只狼
一只一只列着，`updateCamps` 刷的是那个列表，`pack` 是一条**看起来被执行了**的规则——
删掉，不是接上。所以这一轮真正的产出是 `shared/src/data/enemyGate.js`：
`ENEMIES`/`ATTACK_MOVES` 的每个 key 都要写明谁读它，两个方向都查（详见「验证工具」）。
它写完当天就又抓出一个：`basicRanged`/`basicCast` 自己带着 `projectileSpeed`，
而解析顺序是 `mv.projectileSpeed || e.def.projectileSpeed || 18`——**招式的值先赢**，
于是 `slimeElectro: 14`、`hilichurlArcher: 26`、`abyssMage: 16` 三个手写的速度一个都没被读过，
全游戏的普通远程弹都是 20（法师 15）。丘丘弓手的箭本该是最快的，实际比史莱姆的泡泡还慢。
两个 fallback 招式的速度删掉，怪自己的数字就活了；而唯一真正缺速度的
`ruinGuard.missileBarrage` 一直在用那个兜底的 18，现在写成 20。

**教训：一条机制要活着，得有数据、有几何、有消费者，还得有一道门禁把三者绑在一起。**
另外，在 20 Hz 上判定空间事件，要问「这一步扫过了吗」，不要问「这一步停在里面了吗」。

---

## 站在怪物头上的那根光柱：三个都只在截图里露脸的 bug

`enemy-cam.mjs` 头三次跑出来的照片里，遗迹守卫脑袋上立着一根**惨白的光柱**，
亮到把要量的那只眼睛都洗成了白色——11 米外「又亮又暖」的像素数只有 **9**，
断言红了，而它红的其实不是眼睛的错。三件事叠在一起才有这根柱子，一件比一件难看：

**1. 探针那句清场是个空操作。** 代码写的是 `g.vfx?.clear?.()`，而 `Vfx` **根本没有
`clear` 方法**——可选调用把「方法不存在」和「没有东西要清」变成了同一件事，于是
`g.stop()` 冻住的那一帧里，所有正在渐隐的特效被永久冻在了画面上。
这和「探针跑了 0 条断言还报绿」是同一个毛病：一步清理如果不会大声失败，它就不是清理。
现在 `Vfx.clear()` 真存在、**返回清掉了几个**，探针硬调它，并且再调一次必须返回 0
（清完还剩活儿的不叫清）。顺手补上的是同一个洞在游戏里的版本：`_buildZone` 拆世界、
拆演员、清 overlay，却没清 vfx——而 vfx 的池子挂在**常驻场景**上，
所以传送前一帧放的爆炸会在新场景里按**旧地图的坐标**继续放。

**2. 那根柱子是「怪物出场」，用的却是「传送」的特效。**
`S2C.ENEMY_SPAWN` 的客户端处理是 `this.vfx.teleport(e.x, e.y, e.z, true)`：
青色、12 米高、附一圈涟漪和一个半球——玩家在七天神像之间快速旅行时是对的，
一只丘丘人这么登场就不对。更要命的是**它什么时候触发**：
`updateCamps` 只要有任何玩家进到 **110 米**就把整个营地刷出来，`AOI_RADIUS` 130 米又保证它
被推送到客户端，所以在蒙德走一趟，地平线上会亮起一排巨大的青色光柱，
而柱子底下站的是一直都在那儿的怪。现在有 `vfx.spawnIn()`：地面一圈涟漪、
一段**只有身体那么宽**的腰高光晕、十几粒扬起的尘，颜色取怪自己的元素（物理走尘色，
因为 `physical` 是 0xd8d8d8，白闪读起来像法术而不像有东西落地），
尺寸取 `def.hitbox` 而不是常数；**并且 40 米以外根本不放**——那不是「怪出现了」，
那是世界在一个还在走过来的玩家身边加载。两个方向都得测，不然「安静」只是把功能删了：
探针直接往 socket 灌一个假的 `enemySpawn`，6 米处必须产生特效（实测 13 个），
90 米处必须一个都没有；再拍一张，脚下那块必须变（129 字节），头上那块不许变（5 字节）。

**3. 全游戏的粒子都卡在 90 像素上。** 改完出场特效，20 粒尘在 11 米外还是糊成一团
180 像素宽的白饼。点精灵的大小是这么算的：

```glsl
gl_PointSize = clamp(aSize * uScale / max(0.35, -mv.z), 1.0, 90.0);
```

`aSize` 是各个特效手写的 16~34，`uScale` 是 `(视口高/2)/tan(halfFov)` ≈ **960**——
两者一乘是几万像素，除以距离之后**在 200 米以内永远大于 90**。也就是说：
每一粒火花、每一团脚步尘、每一颗死亡飞灰，在屏幕上**都是同一个 90 像素的圆**，
不随距离缩小，而各特效精心区分的 16（脚步）和 34（死亡爆发）**从来没被读到过**——
又一个「有数据、没消费者」，而且这个是直接画在脸上的。
现在 `aSize` 的单位明确是**厘米**（`aSize * 0.01 * uScale / 距离`），上限放到 200。
断言是两粒一模一样的尘，一粒 4 米、一粒 16 米：面积必须差**距离的平方**那个量级，
实测 3233 px 对 192 px，**16.8×**。第一版这条断言把远的那粒放在相机正前方 24 米，
结果它埋进了营地后面的山坡里——加法混合但**照样做深度测试**，画出来 0 像素，
于是「被 clamp 住」和「被挡住」在数字上长得一样。把相机抬向天空才问出了那个比值。

**教训：能被冻住的一帧里，任何「什么都没发生」都是假设，不是事实**；
可选调用（`?.`）会把「不存在」伪装成「不需要」；
而着色器里的一个 `clamp` 上限，能让上面几十处手写常数集体变成死数据。

---

## 挥剑、起跳、落地都没有声音：`default: break` 让两头都不响

`audio.js` 从写下来那天起就合成、混音、接总线接了 **33 条**音效配方，
其中**九条从来没有任何人调用过**：`swing`（挥剑）、`jump`（起跳）、`land`（落地）、
`skill`（元素战技）、`burst`（元素爆发）、`loot`（掉落）、`open`（开面板）、
`error`（操作被拒）、`teleport`（传送）。也就是说，玩家**最频繁的五个动作全是无声的**，
而仓库里没有一条门禁会因此变红。原因是派发函数的收尾：

```js
switch (name) { … default: break; }   // 「没人叫这个配方」和「这个名字没实现」长得一样
```

一个不会失败的 `default` 把两个方向的错都咽了下去——和
「有数据、没消费者」是同一个家族，只是这次两头都能烂：配方可以没人叫，
调用可以拼错名字。现在词表是**代码里的一等公民**：`SFX_CUES` 逐条写明
「这是什么声音」和**应该由哪个文件放它**，`audio-check.mjs` 双向对账
（每条配方都有调用者、每个调用的名字都有配方、每条配方都被它自己声明的那个文件调用、
没有哪个文件在词表之外偷偷放声音）。写这个扫描器时先踩了一次空：
正则 `/(?:^|[^\w.])sfx\(/` 把 `.sfx(` 排除掉了，于是**扫到 0 个调用点**，
「每个名字都有配方」在空集合上完美通过——所以扫描器自己也有断言：
`calledNames.size >= cueKeys.length`。负控制也做了：临时塞一句 `sfx('bogusName')`，
三条断言必须点名 `bogusName` 和 `dash` 变红。

**`opts` 是个死参数。** `sfx(name, opts)` 的第二个形参根本没被读过，
所以 40 米外的丘丘人挥拳和贴在你脸上一样响。现在 `opts.gain` 进合成器
（挥剑重击 ×1.3、落地按下落速度 ×`speed/9`），`opts.at` 走距离衰减：
2 米内不衰减，之后 `12/(12+(d-2)²·0.06)`，约 **71 米**归零——
比 130 米的流式半径小一圈，所以「营地在地平线上加载」不会变成一片拳头声，
这正是上一节那根光柱的听觉版本。

**最难看的一条不是音频问题：五次落地里有四次，游戏自己吞了。**
`land` 接上以后探针仍然时红时绿。原因在 `localPlayer.js`：贴地判定有两个分支，
`y <= 地面` 走落地，`y <= 地面+0.35` 走「吸附到地表」——而后者**静默地把
`grounded` 设回 true**。`dt` 被钳在 0.05 s，一次下落末速 8.4 m/s，
所以下落帧一帧要走 **0.42 米**，比那条 0.35 米的容差带还宽：
结束于容差带内的那一帧，五次里有四次就是落地那一帧。
被吞掉的不只是声音，还有**尘土和相机震动**。吸附和落地是同一件事，
现在是同一个分支，落地速度从 `-vy` 现算。

**教训：`default: break` 是一句「两边都不必对」**；
一个 grep 门禁必须先证明自己扫到了东西；
而「音效偶尔不响」这种概率性红灯，第一嫌疑人是游戏逻辑，不是探针。

验证：`DISPLAY=:99 node tools/audio-check.mjs` —— 词表双向对账 + 一个会录音的
假 `AudioContext`（逐条配方证明它启动了源、只走 sfx 总线、包络非零）+
真页面里用键盘和鼠标驱动的 10 个提示音，**74 条断言全绿，两次跑结果一致**。

---

## 升到 17 级还在用 1 级的血量：入场时的那张快照

`PlayerEntity` 一出生就把两样东西抄了一份：

```js
this.stats = stats;              // 进场那一刻 derivedStats 算出来的
this.party = save.party || [];   // save.party 的一份拷贝
```

而游戏让玩家在两次进场之间做的**每一件养成**——升级、突破、天赋、换武器、
换圣遗物、强化、精炼、编队——都是一条 HTTP 路由，改的是数据库里的存档，
不是这两份拷贝。于是整条养成循环在本次会话里**是装饰性的**：
实测把新手伊格纳从 Lv.1 练到 Lv.17（maxHp 1290 → 2460），
面板上是 2460，正在打的那场架仍然按 **1290** 掉血、按旧攻击力算伤害；
把一个角色从队伍里拿掉，`entity.party` 里还在，**照样能切过去**。
两个症状是同一个缺失的步骤。

修在三层，顺序是从共享层往外：

1. **`PlayerEntity.applyBuild(stats, party, {heal})`** 写在 `shared/`，
   因为这套模拟有**两个宿主**（网关的 `WorldManager` 和浏览器里的 `localSocket`），
   只在联机生效的养成等于一条数值分叉。规则集中在这里：血量在新上限下保留
   （变强不回血、变弱不溢出）、离队角色的能量和血量清掉、新入队角色满血、
   被换下的当前角色自动切到一个活着的队友、没有属性块的名字不算队伍成员。
2. **`WorldManager.refreshBuild()`** 负责推送，并且**先算指纹再决定推不推**：
   `GET /api/player/state` 和商店/邮件/成就/祈愿的每个回包都会顺手算一遍 stats，
   逐次把几 KB 的属性块灌进 socket 是「每开一次面板」的代价。指纹是
   roster + 属性块的 FNV-1a，任何一处（一级天赋、一条圣遗物副词条、套装从 2 件变 4 件）
   变了它就变。
3. **`publishStats(p)` 一扇门**。修之前每条路由的结尾都已经是 `stats: derivedStats(p)`
   了——11 处，加上兄弟路由 4 处——所以正确的修法不是在 15 个地方各加一行推送，
   而是把 `derivedStats` 留作纯函数（只有握手和 `publishStats` 可以调它），
   让所有人改用会推送的那扇门。客户端是对称的：`panels._act` 是所有面板操作的唯一出口，
   在那里调 `game.applyBuild`；单机模式再往下走 `LocalSocket.applyBuild`，
   落到**同一个** `entity.applyBuild`。

**探针自己先撒了一次谎。** 修完以后它仍然报「live sim 说 1290」和
「离队角色照样能切」。原因是 `log.find(pred)` 搜的是**连上以来收到的所有消息**，
对同一个动作重复做两次时，命中的是**上一次**那条 `switchOk`。
现在每个动作前都 `log = []`——和「探针要有一个必须动的对照量」是同一族的错。
负控制则把 `refreshBuild` 短路掉（`NO_REFRESH=1`），三条断言必须变红：
`pushed to socket: NOTHING`、`maxHp 1290 != REST (2460) STALE`、
`switch to a character no longer in the party: ALLOWED`。

验证：`node tools/build-check.mjs` —— 34 条断言分三段：
`applyBuild` 的规则（含「升级回一点血但绝不复活倒下的角色」）、
两端的门禁（服务端只有握手和 `publishStats` 能调 `derivedStats`；
客户端四扇门都在，把它们改回修复前的写法五条断言全红）、
以及真 socket 上的联机验证（编队推送、新入队角色立刻可切、
升级后的 maxHp 进到战斗、**没变的 build 一条都不推**、当前角色被拿掉时自动换人）。
单机那一半在 `tools/solo-check.mjs` 里另加了 5 条（21 条全绿）：**真浏览器**里
把当前角色升一级（sim 1030 → 1964，和 REST 的 1964 一致、和 HUD 读的同一份），
再把她从队伍里删掉——浏览器托管的那个 entity 的队伍、当前角色和**模型**一起换成队友，
她也切不回来了。顺手修掉那个探针里的秒表竞速：4 fps 下 420 血的丘丘人打了 28.4 秒，
旧的 28 秒预算判它「还活着」（剩 14 血），然后它在截图期间死了。

---

## 十四层秘境长得一模一样：一个只从一边卡住的门禁等于没有门禁

`balance-check` 的秘境那一节一直是全绿的，它问的是「打不打得过」，而 14 层都打得过——
**问题恰恰在这里**。把它自己打出来的数字读一遍就能看见三件事：每层都只有**一波**怪
（`chamber.enemies` 是一个平铺数组，一次全刷出来），每层都只用掉限时的 **5-25%**，
而三星门槛是手写的秒数，最松的一层写着 95 秒而实测最优通关是 **16.1 秒**——
**三星是白送的**。玩家没有任何理由打快一点，14 层之间除了怪的等级也没有任何区别。
旧的断言只问「三星拿不拿得到」，而一个只从一边卡住的门禁对「门槛写成一万秒」同样满足。

### 波次是唯一的形状

`waves: string[][]` 换掉了 `enemies: string[]`，没有留兼容路径：`zoneGate` 现在**拒绝**
残留的平铺 `enemies`，`chamberEnemies(c)`（`waves.flat()`）是所有「这层有哪些怪」的
唯一问法，六个消费者一个不剩地迁过去了——`zoneGate`、`enemyGate` 的摆放扫描、
`routes/world.js` 的 `zoneKillLevel`、`api-check` 里镜像的那份 `zoneCap`、审计和探针。
迁的过程里顺手抓到一条死代码：`zoneKillLevel` 里有一行 `bump(c.boss, c.level)`，
而 `c.boss` 是个**布尔标记**，不是怪物 id——它从来没有 bump 到任何东西。

模拟那半边只多了一个「喘息」分支：`updateChamber` 里怪清空但还有下一波时，
记一个 `nextWaveAt = now + CHAMBER_WAVE_GAP`（4 秒），到点才刷下一波并发 `wave` 事件，
在此之前**既不刷怪也不算通关**。`CHAMBER_WAVE_GAP` 写在 `shared/src/data/zones.js`，
因为审计要拿同一个常数把空档算进通关时间——拆成多波会**降低**同时承受的 DPS，
所以一层的真实代价是逐波结算的「承受伤害之和」对着一条池化的队伍血条，加上还在烧表的空档。

### 地脉异常：每个字段都要点名它的消费者

`shared/src/data/disorders.js` 是五条地脉（炽炎/凝霜/雷鸣/磐岩/烈风），每条改动
`enemyHpMul` / `enemyDmgMul` / `enemyRes` / `playerElemBonus` / `reactionBonus` 里的两三项。
和 `procs.js` 的 `PROC_KEYS`、`audio.js` 的 `SFX_CUES` 一样，表旁边就是 `DISORDER_FIELDS`——
每个字段名点明**读它的那一行**（例如 `enemyDmgMul: 'zoneInstance.damagePlayer'`），
`chamber-check` 拿这份注册表去扫 `shared/src/world/zoneInstance.js` 的源码，
两个方向都查：声明了没人读要红，没声明就读也要红。把 `damagePlayer` 里那个乘数删掉，
门禁立刻报 `enemyDmgMul: unread`，同时那条测量断言也从 1.30x 掉到 1.00x（39 过 2 红）。

中文描述不是手写的，`disorderHint(d)` 从数字生成（共享同一个加成的元素合并成一句），
`disorderTerms(d)` 给出它必须产出的小句数量。**成对的规则要互相推导出来，
不要两边都自己写一遍**，否则改了数字忘了改字就成了对玩家撒谎。

### 门槛从审计自己量出来的曲线里取

`--stars` 让 `balance-check` 反过来输出建议值：三星/二星/一星 = 实测最优通关的
`3.2 / 2.2 / 1.5` 倍（取整到 5 秒），限时 = `4.2` 倍（取整到 30 秒）。14 层全部换成
这套之后，每层的三星都落在最优的 **~1.5 倍**上。新的断言是**两边都卡**的:

```js
const STAR_MIN = 1.15, STAR_MAX = 2.0;   // 拿得到，而且不是白送
```

也就是「三星可达」之外多了一条「三星不是免费的」——正是这条新断言在波次落地那一刻
把 14 层里的 11 层判红（例如深渊第一层 `95s vs 16.1s`），它们本来就都是坏的。
审计模型也跟着补齐：`floorFight` 逐波算，`charDps` 吃 `enemyRes` 与 `playerElemBonus`，
`wave` 吃 `enemyHpMul` 与 `enemyDmgMul`；`reactionBonus` **没有**建模，
所以雷鸣地脉那两层会打上 `[reaction bonus not modelled -> read pessimistically]`——
少算一个玩家侧的加成会让余量偏保守，比反过来安全。

### 探针的第三段：每个字段对着一个不该动的对照量

`chamber-check.mjs` 41 条断言分三段。第二段在一个**停掉的** `ZoneInstance` 里手推时钟
驱动波次（只有第一波刷、空档里什么都不发、`wave` 事件带 `wave/waves/enemies`、
最后一波清空给 3 星、超时判失败、快照里 `wave/waves/waveIn/disorder` 都在）。
第三段每个字段量两遍，`underDisorder(id, fn)` 把地脉挂到一个已经在跑的 chamber 上，
所以两次运行**唯一的差别**就是地脉本身：生命 1.35x 对没有地脉的 1.00x、
受到伤害 1.30x 对通关后的 1.00x、反应 1.51x 对一次不产生反应的命中 1.00x。

抗性那两条第一次是红的：我按「−40% 炎抗」估了 `> 1.3x`，实测 **1.28x**。
探针是对的，常数是错的——丘丘人没有炎抗条目，走的是 0.1 的默认值，
而 `resMultiplier` 对负抗性是另一条分支（`1 - res/2`）。修法是把期望值也**推导**出来
（`resMultiplier(res + delta) / resMultiplier(res)`），得到炎 1.28x、物理 0.56x，
而不是把一个手估的数字写死在断言里。

呈现层在开跑之前就要说清楚这一层是什么：地图面板的每一行写「Lv.X · N 波 M 敌 ·
限时 Ts · 三星 Ss」外加地脉说明，进场横幅标题是「第 N 间 · 炽炎地脉」，
HUD 的秘境块多了一行紫色地脉提示（`c.disorder` 变了才重新格式化，不是每帧），
换波时弹一条「第 2/3 波 · 4 名敌人」的金色 toast 并复用 `chamberStart` 音效。

### 呈现层要在浏览器里真打一层，不能靠手写状态

`chamber-ui.mjs`（41 条，需要 `DISPLAY=:99`）是上面那段的另一半。第一版是往
`window.game.chamber` 上手写一个 chamber 块然后截图——它给一个**空**的秘境块打了满分，
因为单机模式下 `game.socket.inst` 就是页面里那个活着的 `ZoneInstance`，20 Hz 的快照
每 50 ms 就把手写的字段盖掉。所以探针改成真打：`startChamber` → 用
`applyDamageToEnemy(e, 1e9, …)` 逐波清场 → 等 `state !== 'running'`，
两层（无地脉的第 1 间、凝霜地脉的第 2 间）全程按真流程走。

这一改立刻抓到一个真 bug：HUD 的判断是 `st.chamber.state !== 'idle'`，而 `'idle'` 是
模拟侧**从来不发**的值——`zoneInstance` 清关后并不会把 `this.chamber` 置空（它要留着
`state:'cleared'` 拒绝第二次结算），快照也照发，于是通关之后那块计时器会一直挂在屏幕上，
冻在「剩余敌人 0」并且继续念着已经打完那层的地脉名。修法是把条件收成
`st.chamber.state === 'running'`（`client/src/ui/hud.js`）：结算有自己的横幅，计时块只属于
**正在跑**的那一轮。探针两头都断言——开跑时块在、清关后块没了且地脉行高度为 0。

紫色地脉行的**颜色**证明卡了三次，全是同一个错：拿会动的 3D 场景当背景。整块矩形均值下
紫行和金行都读成 `220,215,203`（HUD 顶栏正后方压着一条亮雾带）；换成「最亮 15%」也一样；
改成两帧相减去抠字形，雾和粒子在动，矩形里三分之一的像素都变了，抠出来的还是场景。
最后的做法是把 canvas 自己 `visibility:hidden` —— 待证的命题本来就只关于 HUD 自己的像素，
背景一静，同一矩形「有这行 / 隐掉这行」的差别就全是这行：紫行 `156,132,186`（蓝>绿、红>绿），
隐掉后亮度 141 → 13，上面那条金行同法读出 `89,77,48`（暖、且过不了紫色判据）。

## 元素共鸣：一个系统要同时是名册的形状、战斗里的数字和面板上的像素

八条共鸣（炎/水/冰/雷/风/岩/光各要两个同元素角色，四象庇护要四个**不同**元素）
在数据层只是 `shared/src/data/resonance.js` 里的八个 `effect` 对象。真正的工作在它两侧：
**名册要能凑出这些队伍**，**效果要落到已经在跑的战斗里**，**面板要在两个状态下都是对的**。

### 队伍凑不出来的共鸣等于不存在

上线共鸣的前提是每个元素至少两个人，所以名册从 8 人扩到 14 人。
`char-check.mjs` 第 6 节就是这条前提的门禁：每个元素 ≥2 人、
同元素这一对里**武器类型至少有一个不同**（否则「凑共鸣」等于强制双剑）、
五种武器都有人用。再往上一层是可获得性——一个既不在任何祈愿池里、
也不在初始队伍里的角色只存在于数据文件，那和不可达的共鸣是同一个缺陷：

```js
const unreachable = CHARACTER_IDS.filter((id) => !poolChars.has(id) && !STARTER_PARTY.includes(id));
```

这条断言第一次跑出来的「不可达角色」里有一个叫 `i` 的人——`featured` 是单个 id，
`featuredFour` 是数组，把字符串也 `for...of` 一遍就会把它的字母加进集合。
所以 `addIds` 显式区分两种形状，而不是指望调用点都写对。

### 六个字段写在名册里、没有人读

扩名册的时候顺手给技能字段也上了双向门禁（`KIT_FIELDS`，规则和 `DISORDER_FIELDS`
`PROC_KEYS` `SFX_CUES` 完全一样：字段要声明、声明要有人用、点名的消费者必须存在并且
真的读了那个 key，外加一条自测——伪造的字段/函数/模块必须都被报成死的）。
它抓到的不是新加的六个人，而是**原本那六个字段**：
`charged.chargeTime`、`charged.hold`、`charged.spinDrain`、`charged.thrust`、
`charged.headshot`、`skill.particles` 全都写在 `characters.js` 里而没有任何消费者。
后果是能玩出来的：弓和剑的重击都蓄 0.32 s，巨剑的旋转重击只收一次固定体力，
两粒微粒的技能和四粒的技能给爆发充能一样快。修法是给每个字段接上消费者——
`localPlayer.chargeTime/heldSpin/spinDrain`、长柄走 `attack3` 突刺动画、
背击 `headshot`、以及

```js
entity.addEnergy(st.charId, (skill.particles ?? 3) * ENERGY_PER_PARTICLE);
```

充能既然按微粒计价，「爆发多久能起来」就有了单位。`char-check` 拿它当可达性门禁的
两边卡：只靠技能微粒（确定性来源，命中与战斗内涓流只会更快）最慢 70.0 s、最快 15.0 s，
超过 75 s 判红，低于 12 s 也判红——爆发不能免费。

### 强度对照的豁免必须被人用，而且要付钱

同一节按名册自己的中位数卡强度（>2.2x 是打字错误，不是设计），低侧原本一刀切 0.45x，
结果把三个治疗/护盾角色判红了：支援本来就该打得软。但「支援可以软」不能是空头支票，
所以豁免是成对的——软到 0.25x 为止，**并且**同一个技能要在 HP/s 上把让掉的 DPS 买回来：

```js
const unpaid = exempt.filter((r) => r.sustain < 0.4 * r.m * REF.atk);
```

实测 `seris 568hp/s ≥ 162 | aurel 264hp/s ≥ 162 | naida 196hp/s ≥ 162 | naida 243hp/s ≥ 231`。
另外一条断言要求豁免**至少被三个人用到**，否则那段分支是死代码，
真有一天加进来一个既不打人也不奶人的角色，它会安静地放过去。

### 效果复用已有的消费者，不新开代码路径

`RESONANCE_FIELDS` 给九个字段各点名一个消费者，`resonance-check.mjs`（38 条）
两头都卡。关键是共鸣**没有**自己的结算层：`fold: 'stat'` 的六个走
`sim/loot.applyPartyResonance` 折进 `st.atk / mastery / cd / shieldStrength / dr`，
和圣遗物套装走的是同一条路；`critVsFrozen` 和 `energyOnReaction` 走
`world/procs` 的 `hitMods` / `fireProcs`，和「暴击率 +X% 当目标被冻结」这类武器被动
共用同一个 conditional-source 机制。探针的每一条都是**两个只差伙伴元素的队伍**相减：
炎 `936 -> 1170 = 1.250x`、水的治疗 `647 -> 815 = 1.261x`、风的冷却 `6.00s -> 5.40s`、
岩的护盾 `1872 -> 2246`、四象的减伤 `500 -> 450`（三个不同元素时一分钱不减）、
光的精通 `40 -> 120` 且它喂的反应 `11629 -> 16224 = 1.395x`、
雷的 `+3.83` 能量（= 3 × 充能效率 1.28）而结晶反应一点不给。
期望值全部从 `RESONANCES` 和公式里**推**出来（`want 1.261x` 是算的，不是写死的）。

### 面板的两个状态都要量像素

`party-ui.mjs`（113 条，需要 `DISPLAY=:99`）是另一半：八条共鸣各截「亮/灭」两帧，
断言亮着的集合等于 `partyResonances(party)`（两个方向）、
文案是 `已激活` 对 `resonanceCondition(r)`、`resonanceHint(r)` 两态都在、
不透明度 1 对 0.5、边框与标题色都要动（`rgb(232,197,106)` 对 `rgba(0,0,0,0)`）、
亮行更亮且更暖（`lum + 3`、`R−B + 3`），外加一行**两态都灭**的对照行不许动（<2.5）。
队伍是通过 `game.applyBuild(stats, party)` 换的，这是刻意的：
`/api/player/party` 会按持有过滤，而新号只有 2 个角色、20 抽只够再出 1 个，
没有任何 REST 路径能凑出两个炎角色。

这一节的四条像素断言第一次全读 `Δlum 0.0`，而所有文本断言都是绿的——
llvmpipe 上页面只有 2 fps，等 250 ms 截到的还是面板**打开之前**那一合成帧。
所以现在每次读像素前都 `game.stop()`、隐掉 canvas、等两个 rAF 再加一拍，
并且带一个**必须动**的对照量（`pixelsDiffering > 200`）——
静态帧不会报错，它只会把每一条差值断言读成 0。
`light` 和 `protective` 又多错一轮：它们排在队伍面板侧栏的**折线以下**，
`getBoundingClientRect` 给的是被裁掉的那块像素，所以每帧都先 `scrollIntoView`，
对照行的矩形也每帧重读（两帧的滚动位置是各自的）。

第 2 节把十四个人逐个 `setCharacter` 之后正面拍下来（站到 (24, 22)、`ry = 0`，
不能站在传送点里对着相机的后脑勺），和一张 `rig.group.visible = false` 的基准帧相减：
剪影 395x606、覆盖率 13.8–22.1 %、五种武器都在、91 对两两比较没有双胞胎。
身高比例卡了一轮：宽松阈值把**固定尺寸的元素光环**也算进剪影，于是
`sylvi 1.54m` 和 `ignar 1.86m` 的像素比读成 1.036（作者值 1.208）。
修法是每行至少 8 个变化像素才算「这行是人」（光环是稀薄的一圈），
再用投影出来的头部骨骼做第二个独立读数交叉验证：
`bone ratio 1.209 vs silhouette 1.175`，两者互相咬住 0.06 以内。

### 探针替被测对象把界面摆好，就等于把缺陷藏起来

`party-ui.mjs` 每帧都先 `scrollIntoView` 再读像素——为「玩家本来就得滚一下才看得到」的
七行这是对的，但它同时把**真正的 bug 也滚进了视口**：亮着的那条排在共鸣表的最后一个
（`四象庇护`），而这一列是个八行的滚动容器，于是玩家一打开队伍面板，唯一亮着的那行
在折线以下。112 条断言全绿。

`resonance-ui.mjs`（31 条，需要 `DISPLAY=:99`）就是从另一头写的：**只读面板打开时那一帧
的视口**，不滚、不改 class、不换 build。它第一次跑出来亮行的像素是 `10,11,18`——页面背景。
修法进了 `client/src/ui/panels.js`（激活的共鸣排到最前），不是进探针：

```js
const resRows = Object.values(RESONANCES)
  .sort((a, b) => (activeRes.has(b.id) ? 1 : 0) - (activeRes.has(a.id) ? 1 : 0));
```

所以现在有两条断言卡这件事：`the active rows are the first rows in the list`
（打印 `0:fire* 1:water …`）和 `...and the lit row is inside the scrolling column, not below
the fold`（行矩形要落在 `.res-list` 所在 `.col` 的 client box 里，`y 462, visible true`）。

这个探针另外两处和 `party-ui` 刻意不同：

- **队伍是真账号真凑出来的，不是 `applyBuild` 塞进去的。** 新号只有
  `STARTER_PARTY.slice(0, 2)`（lyra 风 / ignar 炎），两个不同元素什么都不亮，
  第一版直接 `r1[undefined].cond` 崩了。于是第 0 节先走 REST：登录失败就注册
  （`/api/register` 每小时每 IP 只有 20 个，所以是六个固定账号 `resui1…resui6` 复用），
  领邮件、领成就，然后 `wishTicket + floor(primogem/160)` 还有预算就一直抽，
  每十连之后再领一次成就，直到 `bestParty()` 能凑出一条共鸣，最后
  POST `/api/player/party`。抽卡的运气不许决定探针的判决——
  这一轮实测 `owns lyra ignar gorran pyra → party ignar pyra lights fire (0 pulls this run)`，
  0 抽是因为上一轮买的号还在。
- **状态是点出来的。** 第 3 节点 `.slot[data-slot-index]` 把 `伊格纳` 从队伍里拿下来
  （玩家的操作路径），断言那行退回 `2 名炎元素角色`、不透明度回 0.5、
  像素掉了暖色（`105,106,107` was `181,156,90`），再点 `[data-add="ignar"]` 加回去，
  行重新亮成 `181,156,90`。全程有一条对照：水的那行文本、不透明度、亮度都不许动
  （`water lum 121 vs 121`）。

亮/灭的像素判据也换过一轮。原来是「金色」的绝对阈值（`r > 150 && r - b > 40`），
而真实的字比想象的暗——亮行读出来 `120,112,87` 就被判成不金。绝对阈值是在给字体调参，
所以改成两侧都卡的**色相**测试，再把矩形从整行收窄到行内标题元素：

```js
const warm = (rgb) => rgb[0] - rgb[2] > 15 && rgb[1] > rgb[2];
const nameInk = (img, r) => ink(img, r.name.rect, 0.25);
```

实测亮行 `181,156,90`（`R−B = +91`）、灭行 `121,121,119`（`+2`），
灭掉之后 `105,106,107`（`−2`）——两个状态分在阈值两边，而且 `lum 156 vs 121`。

**排序一改，`party-ui` 的对照行反而被咬了一口。** 激活项排到最前之后，
两帧的行序不再一致：测 `皓光同辉` 时对照行 `炎炎不息` 在亮帧是第 0 行、
在灭帧被滚动裁掉了一半，于是「两帧都灭的行不许动」读出 `lum 36.7 vs 39.7`，
超过 2.5 的容差。矩形里装的东西变了，不是状态变了——把容差放宽就等于把这件事盖住。
正确的修法是**对照行必须两帧都完整落在滚动容器里**，所以 `readRows` 现在每行多返回一个
`visible`（沿 `parentElement` 找到真正会滚的那个祖先，比 `rect` 与它的 client box），
挑对照时要求 `visibleBoth(id)`。再加一条「对照本身的对照」——
`most resonances got a pixel control row — 8 of 8`：
可见性要求万一把所有候选行都饿死，像素断言会失去参照而整轮仍然报 0 failed。

## 料理与食物：先问「有用吗」，再花

采集→烹饪→吃下去这条链上曾经有三个洞，三个都是**先动手、后判断**：

1. **`reviveDish.revive.hpPct = 0.4` 是没有消费者的数据。** 背包面板照着它印
   「恢复 40% 生命值」，而 `PlayerEntity.revive()` 把 0.5 写死在函数里、
   一个参数都不读。玩家读到的数字和游戏做的事差了 10 个百分点，
   两边都「正确」，只是没人把它们接起来。修法是让份额变成参数：吃复苏道具传
   `MATERIALS.reviveDish.revive.hpPct`，免费复活（队友搭手、8 秒重生、带复苏的爆发）
   保留 `REVIVE_HP_PCT = 0.5` 的旧默认——**两个数字互相推导，而不是各自硬编码**。
2. **满血吃回血菜，菜没了、血没涨。** `C2S.USE_ITEM` 的顺序是先 `repo.addItems(-1)`
   再算效果，`entity.heal(amount)` 在满血时返回 0，于是一份甜甜花酿鸡在数据库里被扣掉、
   在世界里什么也没发生，还没有任何地方退还它。站着吃复苏道具、在城里吃浓缩树脂同理。
3. **`revive()` 会把健康的队友按下去。** 它给全队写 `hpByChar[c] = maxHpOf(c) * hpPct`，
   全队倒地时这是对的，但带复苏的爆发落在一个后台还满血的队伍上，就把 100% 改写成 40%。

三个洞的共同修法是一个**共享的门**：`shared/src/world/consumables.js` 里的
`consumableRefusal(def, who)` 回答「这一口有没有用」，`consumableEffect()` 把答案连同
要执行的 heal/buff/revive 一起给出来。它有三个调用方，而且必须是三个：
网关（`C2S.USE_ITEM`，问在扣除之前）、`LocalSocket._useItem`（单机同一句话，
而且这里更要紧——扣除是 REST 的、效果是本地实体的）、以及背包面板本身，
它把同一个 refusal 码变成 使用 按钮的 `disabled` 和按钮下那行灰字
（`hp_full → 生命值已满，留着受伤时再吃`）。**按钮先说的话，必须是服务端会说的话**，
所以 `api.js` 的 `ERROR_TEXT` 和面板读的是同一个码，探针把两句话对起来比。
`revive()` 里那个 `Math.max` 就是第 3 条的全部。

`CONSUMABLE_EFFECTS` 是这些字段的词表，和 `DISORDER_FIELDS`/`PROC_KEYS`/`SFX_CUES`
一样做**双向门禁**：声明了的 key 必须有菜真的带它，带了的 key 必须在指定模块的源码里
被读到；扫描器自己还要拿一个编造的 key 自测，否则「0 failed」可能只是没扫到东西。

`food-check.mjs`（66 条，前两节不需要显示器）的三节分别是词表+拒绝矩阵、
在真 `ZoneInstance` 里吃一口、以及真浏览器里从采集到 buff 芯片过期。
拒绝矩阵按 `{满血, 受伤, 倒地} × 8 种消耗品`**两侧都钉**：
回血菜满血必须报 `hp_full`、受伤必须放行；复苏道具站着必须报 `not_downed`、
倒地必须放行；buff 菜满血也要放行（不然「加攻菜只能受伤吃」这种荒唐规则会静静通过）；
倒地时只有复苏类能吃；浓缩树脂两个状态都是 `use_via_menu`。
浏览器那节的期望值全部从 `RECIPES`/`cookOdds`/`maxPortions`/`MATERIALS` 现算——
概率条的每段宽度和 `cookOdds` 差不到 0.2 个百分点，回血量 `+669` 正是
`min(缺的血, 2000 + 18% × 1030)`。

**探针自己踩到的坑：一次读到的是「正在离开的宽度」。** 队伍卡的血条
`.bar > i` 带 `transition: width 0.2s`，把角色打到 35% 之后立刻读
`getBoundingClientRect()`，量到的是 123px——满宽，也就是过渡的**起点**。
`style.width` 是 `35%`、`hudState()` 是 `361/1030`、快照里也是 361，
全都对，只有像素是旧的，看起来和「血条根本不动」一模一样。
修法不是加 sleep，而是等动画自己落地：

```js
await Promise.race([
  Promise.allSettled(el.getAnimations().map((a) => a.finished)),
  new Promise((r) => setTimeout(r, 1500)),
]);
```

然后 43px → 123px（123px 轨道的 35% → 100%），而且两端都卡：受伤时必须明显短于轨道，
吃完必须够到轨道，「涨了」一条会被一像素的蠕动骗过去。
同一节的 buff 芯片消失判据也修过一次：对照矩形取的是 `.zone-name`，
而它压在活的 3D 画面上，于是「不该动的对照」自己动了 35.7%——
拍 HUD 之前先把 canvas `visibility: hidden`，对照才真的是 0.0%。

## 祈愿：印出来的概率必须是掷骰用的那条曲线

抽卡是唯一一个**玩家只能通过面板上的数字认识它**的系统：护盾破了看得见，
「五星基础概率 0.60%」错了没人看得出来。所以这一轮的四个洞全长在同一个地方——
数据、掷骰的代码、发布的载荷、面板印的字，四份里少接一根线：

1. **软保底曲线只有 `pullWish` 知道。** 第 74 抽起每抽 +6%，可面板照着 `rate5` 印
   「0.60%」——一个坐在 80 抽上的玩家读到的是模拟六抽前就抛弃的数字。修法是把曲线
   变成一个导出的函数 `wishRate5({rate, pity}, n)`（`shared/src/sim/loot.js`）：
   掷骰的那一行用它，`/api/wish/pools` 顺带发布 `SOFT_PITY`，面板 `import` 它算出
   「当前五星概率」。参数取 `{rate, pity}` 而不是整个 pool，就是因为那是服务端
   发布的形状——**客户端拿服务端的数算服务端的曲线**，才不会各印一套。
2. **`fourStar.featuredChance` 和 `guaranteed4` 是没有消费者的数据。** 四星那半边根本
   没有 rate-up 分支：`rand.pick(four.chars)` 均匀取，于是横幅上写的 75% 由
   「`chars` 数组里恰好有几个限定」决定。补上分支之后又暴露第二个洞——
   `featured` 池的四星名册当时**只有那三个限定**，输掉 rate-up 无处可去，
   `guaranteed4` 永远解不开。所以四星名册改成两个池共享一份
   （`FOUR_STAR_CHARS`/`FOUR_STAR_WEAPONS`），限定池是「同一个池 + 三个名字前移」。
3. **路由收的钱不是横幅标的价。** `count * 1` 写死，同时又把 `pool.cost` 发布出去给
   面板印。改成 `WISH_POOL[pool].cost.wishTicket`；`160` 原石折算率同样从
   `GEM_PER_WISH` 导入，面板里那个字面量删掉。
4. **按下标打补丁的面板。** 抽完不重绘（会擦掉抽卡动画），靠
   `querySelectorAll('dd')[1..3]` 回填三个数——上面加一行就整体错位，而且
   **从来没被回填的那一行正是 大保底**。现在每个 `dd` 带 `data-k`，按名字打。

`wish-check.mjs`（122 条，前两节不需要显示器）的四节是词表/载荷、转化、分布、真账号，
第三节要显示器。**每一个期望值都是从同一张表现算的，没有手写常数**：
`p(n) = 存活 × wishRate5(n)` 给出五星落点分布，它的均值倒数就是长期出率
（62.3 抽一发，1.605%，实测 1.615% 在 4σ 内）；50/50 加大保底的限定占比是
`1/(2−c)`——`c = 0.55` 得 68.97%，实测 68.68%；四星 `c = 0.75` 得 80%，实测 79.96%。

三个**因为写错而被探针抓出来的判据**，都值得记下来：

- **「最长空窗 87 < 90，硬保底没被突破」不是硬保底存在的证据。** 第 89 抽的概率已经
  96.6%，活到第 90 抽的概率约 7e-8——`k >= pity` 那个分支在任何一次探针里都不会执行。
  改成从选定状态出发驱动：把 `pity5` 放到 89，300 个种子必须每次都出五星。
- **两个四星之间可以隔 12 抽，这是对的。** 五星会抢掉同一抽的四星，而
  `s.pity4 = Math.min(s.pity4, pity - 1)` 只把计数器往回推一格。按 `gaps4 <= 10` 判会
  报一个假缺陷；玩家真正感觉到的不变量是**十连不可能全是三星**（实测最长 9），
  外加计数器本身永不越顶，再加一条针对那行 `Math.min` 的定向用例。
- **逐抽校验软保底需要每个抽次约 3000 个样本**，而 20 万抽里只有约 2000 个周期活到第 74
  抽。改成把「五星落在第几抽」做成直方图，分箱由曲线自己累出来（每箱期望 ≥100 发）。
  更要紧的是这个直方图**必须能否定一条曲线**：同一批样本对着「起点晚三抽」的
  ramp 再拟一次，必须有箱子被拒（实测 8 个箱子，`69-76` 段 24.1% vs 3.1%）。
  样本不够时它 SKIP 并让你 `--pulls 200000`，而不是变成一条永远绿的断言。

浏览器那节同样有一个**必须动的对照**。全新账号从 0 抽到 10 抽都在 ramp 之前，
「当前五星概率 0.60%」和「限定五星 55%」在这个区间里**删掉回填代码也照样对**。
于是把客户端那份状态注进 `pity5: 80, guaranteed5/4: true` 再重开面板：
当前概率必须变成 48.60%（= 0.6% + 8×6%）并带高亮，两个保底必须改说
「大保底：必定为限定」「下次必定为限定」——这两行平时根本看不到。然后再真抽一次 ×1，
服务端回的 `pity5 = 11` 必须把注进去的 80 冲掉：少回填任何一行，它就还停在 80。

## 满命之后再抽到：星辉、星尘，和一个用商店价格计价的赔付

抽到第七个 `pyra` 之前，服务端就已经在 `LEAST(dupes+1, 6)` 那里把命之座顶住了：
再抽到同一个角色，数据库照写一次，玩家什么都没拿到。多余的三星武器更直接——
背包里多一把铁枪，仅此而已。这不是平衡问题，是**死路**：抽卡是这个游戏最贵的动作，
而它有一整类结果的收益是零。

出口是 `shared/src/sim/loot.js` 里的 `WISH_CONVERSION`：三星 15 星尘，四星 2 星辉，
五星 10 星辉，外加一张 `maxed` 表给「命之座已满」的重复角色。

关键不在于加了两种货币，而在于**赔付用商店的价格计价，不是拍脑袋的数字**。
`GLITTER_PER_WISH = 5` 同时是两件事：`bar_glitterWish`（5 星辉换 1 纠缠之缘）的价格，
和满命四星的赔付来源。于是那张 `maxed` 表可以被读成一句话——
**满命的重复角色，把它花掉的那一抽退回来**：满命四星恰好 1 抽，满命五星 5 抽。
探针不核对常数，它用 `inWishes()` 把两种货币都换算成「抽」再断言：
3★ 0.20 < 4★ 0.40 < 5★ 2.00，`maxed[4] === 1`，`maxed[5] === 5`，
并且同一档「满命」永远优于「不满命」。换算率也不是写在探针里的，是从商店里
**读出来**的（那些用星辉/星尘买纠缠之缘的条目），所以商店改价的第一时间这里就红。

两条互相推导的规则，缺一条另一条就没有意义：

- 换抽有月上限（5/月），所以星辉星尘是**返利而不是抽卡打印机**；
- 正因为有上限，每种货币必须再有一个**不是抽卡**的 sink（星尘换摩拉，
  星辉换一把四星武器），否则月底一到，货币就变成背包里只会涨的死数字。

`capped` 由 `repo.grantCharacter` 给出，不在路由里算——只有它知道 `dupes` 撞上了
`MAX_CONSTELLATION`；路由只知道掷出了什么。REST 断言因此**不读路由自己回的
`capped`**，而是用卡面上那个玩家能看见的命之座数字反推它：读回自己写的字段，
只能证明它和自己一致。

存储上没有 migration：`CURRENCIES` 是玩家行上的列，星辉星尘走 inventory，
`kind` 必须是 `material`——背包只渲染 `material` 和 `consumable`，填错 kind
就是「货币加上了、包里看不见」。

证据是 `DISPLAY=:99 node tools/wish-check.mjs --pulls 200000` 的
**122 passed / 0 failed / 1 skipped**，其中转化这条链是端到端的：
十连的每张卡印出 `✧星尘 +15`／`✦星辉 +2`，卡片下方那行
`本次共获得 ✧星尘 +135 · ✦星辉 +2` 等于十张之和，footer 里的两个余额从 `0`
走到 `135 / 2`（**两头都断言**，只看抽完那一半的话，一个永远印 0 的 footer 也能过），
再用 75 星尘在商店换回 1 纠缠之缘，那张券真的抽出了下一次，并且又付了一次自己的零钱。
唯一的 SKIP 是「REST 上的满命赔付」：十连里没有角色能到 C6（那需要同一个四星七张），
这条分支在 0b 节用构造状态驱动，而不是假装它过了。

## 无人值守：`up` 不等于在干活

`./tools/autorun.sh status` 曾经连续 23 小时报告
`autorun: up (2821) iterations=4170`，而那 4170 轮**每一轮都在毫秒内失败**：

```
=== iteration 4170  2026-09-07T01:12:34+00:00
./tools/autorun.sh: line 200: claude: command not found
iteration 4170 failed
```

机器重启了，`game-watchdog` 这个 lingering 单元按设计把循环拉了回来——但
**systemd user unit 不继承登录 shell 的 PATH**，`~/.local/bin/claude` 于是不存在。
一整天的无人值守时间什么都没换来，客户端还带着一个缺失的 import 编译不过。

根因不是 PATH，是**断言下在了外壳上而不是活儿上**：`status` 只检查 pid 在不在，
watchdog 只匹配字符串 `autorun: up`。这两个检查都不可能失败，所以它们把一具尸体
一直捂着。这和「探针跑了零条断言」、「读到一帧永远不动的画面」是同一个缺陷。

三处修改，缺一不可：

- `autorun.sh` 自己 `export PATH="$HOME/.local/bin:$PATH"`，`watchdog.service` 里
  再写一遍 `Environment=PATH=…`。谁启动它都不影响结果。
- 进 worker 前 `command -v claude` 预检，找不到就 `notify` 并退出——**在门口大声失败**，
  而不是安静地每 20 秒重试到天亮。连续 5 轮失败也直接退出，让 watchdog 重启一个
  干净的 worker（重启会重新跑预检）。
- `status` 改成读**进展**而不是存在：最近 ≥3 轮全部失败就报 `stalled`（一个和 `up`
  不同的词，否则 watchdog 的 `up` 匹配会把它吞掉），并打印最后一条错误。watchdog
  多一个分支处理 `stalled`：停掉它，下一轮起一个新的。

`stalled` 是在真实日志上验证的，不是推理：改完直接对着那份 4177 轮的日志跑
`status`，它输出 `autorun: stalled (2821)` 和 `the last 5 iterations all failed`。
反方向也要验：修好 PATH 重启之后，同一个命令必须回到 `up`，并且
`iterations=` 要真的往前走。

同一次重启还带走了**根目录的 `node_modules`**，于是 `tools/` 下所有浏览器探针
一起变成 `Cannot find package 'puppeteer'`——而根 `package.json` 的
`devDependencies` 里**只有 `concurrently`**：puppeteer 当初是随手装上的，从来没被
记下来，所以 `npm run install:all` 也不可能把它装回来。一个不在清单里的依赖，
等于一个只存在于「这台机器现在的状态」里的依赖。现在它是
`devDependencies.puppeteer`，浏览器本体在 `~/.cache/puppeteer`（那份没丢）。
探针跑不起来和探针跑出绿色是两种不同的失败，但在无人值守里它们的后果一样。

## 新手引导：一步只能由「真的做到了」来完成

这个游戏一直没有任何新手引导。所有操作都能用，但**没有一处能被找到**：唯一提到键位
的地方是设置面板最下面的一行散文，

```
键位：WASD 移动 / 空格跳跃 / Shift 冲刺 / C 闪避 / E 战技 / Q 爆发 / F 交互 / 1-4 切换 / …
```

而玩家要看到这行字，得先按 Esc——正是这行字想教的那个键。更糟的是**整行没有一个字提到
鼠标**，而这个游戏的主操作方式就是鼠标：点地面走路、点敌人攻击、按住拖动转视角。目标里
写着「支持鼠标点击」，实现里做了，文档里一个字都没有。没人能发现的功能，和没做的功能
在玩家眼里没有区别。

### 一步的完成条件是结果，不是按键

`shared/src/data/tutorial.js` 里 11 步的 `id` 同时是客户端信号的名字，而每个信号都发在
**动作真的发生了**的那行代码上，不是发在按键上：

| 步骤 | 标记的位置 | 为什么是这里 |
| --- | --- | --- |
| `attack` `skill` `burst` `dash` | `me.on('swing' / 'skillCast' / 'burstCast' / 'dash')` | LocalPlayer 只在冷却、体力、元素能量都过了之后才 emit |
| `clickMove` | `_leftClick` 的第 3 个分支 | 点敌人、点宝箱也会移动，但那不是「点哪走哪」 |
| `interact` | `_interact()` 的重入锁之后 | 距离不够时走过去，到了才算 |
| `switch` | `switchTo()` 的两个 early return 之后 | 切到倒下的角色、切到自己都没教会任何事 |
| `panel` `map` | `panels.open()` | 按键只 emit `togglePanel`，再按一次是关闭 |
| `move` `look` | 每帧采样位移和**实际应用的**镜头旋转 | 这两件事不是事件 |

冷却里按 E 不会让玩家学到 E 是干什么的，所以引导也不许往前走——探针里有一条专门的反向
断言：能量为 0 时 `useBurst` 返回 `false`，`done` 里就不许出现 `burst`。

`look` 只认**鼠标拖动实际造成的旋转**（在 `_frame` 里量 `rig.yaw/pitch` 的前后差，还要处理
±π 绕回和 pitch 夹紧），因为锁定敌人时 `faceDirection` 也会转镜头——把那份旋转算作玩家的
功劳，等于玩家没碰鼠标就把「转一圈看看」勾掉了。`move` 单帧位移超过 2 m 不计：那是传送或
换区，不是走路。

进度存在 `players.settings.tutorial`（一个早就存在的 JSONB 列，不需要迁移），
`{ done: [...], skipped: bool }`，服务端按 key 浅合并，所以引导只发自己那一个键——它可能在
玩家正拖音量滑块的时候触发，把整个 settings 快照发上去就是第二个写者在和面板抢。

`tutorialView(state)` 会**丢掉列表里已经没有的 id**：否则一个改过名的步骤会让老账号永远
停在 12/11，而那个分母就是卡片上印的数字。

### 操作说明从 KEYMAP 推导出来

设置面板里那行散文换成了一张分组表（`.keyref`），行不是手写的，是从 `input.js` 的
`KEYMAP` + `ACTION_INFO` 推出来的，鼠标手势（`MOUSE_CONTROLS`）作为「鼠标」这一组
并列在最后。两个对象的 key 必须完全一致，探针两头都查：新绑一个键忘了写说明会红，
给一个没绑定的动作写说明也会红。`ShiftLeft`/`ShiftRight` 合成一个 `Shift`，因为对玩家
来说那是一个键。

有一处细节值得记：键帽和鼠标手势是两种样式（方角白底 vs 圆角青色描边），第一版用
「这个字符串里有汉字吗」来选样式，于是 **`空格` 被画成了鼠标手势**——正是这两种样式要
避免的混淆。现在按组判断，探针也加了一条断言：圆角药丸的数量必须正好等于
`MOUSE_CONTROLS.length`，且 `空格` 必须是键帽。

### 验证

`tools/tutorial-check.mjs` 四节，75 条断言：

- 词表两头封闭：11 个 id 每个都在客户端被 `mark()`，每个 `mark()` 都命名一个存在的步骤；
  扫描本身先断言「至少找到 11 次调用」，否则两个方向都会因为「扫不到东西」而免费通过。
- 结构：`_handleKeys` 里**不许**出现 `tutorial.mark(`；skill/burst/dash 必须标在
  `_bindLocal` 的事件里；卡片印的每个键帽都必须真的在 `KEYMAP` 里。
- 浏览器里真的把 11 步走完：按住 W 走路、右键拖动转视角、左键点地面、挥剑、战技、点头像
  换人、按 C 闪避、满能量爆发、按 F 和 NPC 交互、按 B 开背包、按 M 开地图；每一步都断言
  **卡片显示的是「第一个未完成的步骤」**（这个期望是推出来的，不是写死的下一个 id——开宝箱
  可能顺手完成 `panel`，写死的链条会在一个正确的游戏上变红）。
- 像素：藏掉 canvas 量卡片标题的墨色（gold，rgb 203,173,97），再藏掉卡片本身作为对照
  （lum 174 → 13）。另外 `elementFromPoint` 打在卡片中间必须落到 `canvas`——卡片整局都挂在
  左边，如果它吃掉点击，就把自己正在教的那个操作弄坏了。
- 存活：`flush()` 之后 reload、走「继续冒险」重新进入，`done` 仍然是 11/11——这条走的是
  Postgres，不是这个标签页的内存。最后点「跳过引导」（卡片消失、`complete` 仍是 false），
  再从设置面板的「重新引导」回到第 1 步。

第一轮跑出来两条红的，都是探针自己的毛病，但都指向真实约束：**按住 W 两秒只走了 0.4 m**
——帧循环把 `dt` 夹在 50 ms，llvmpipe 上 3 fps，一个墙钟秒只推进 150 ms 模拟时间，所以
按键要按**帧数**而不是秒数（`frames(30)`）；`nearestInteractable` 只在每个交互物自己的
`radius` 内找，站在出生点当然是 `null`，得直接遍历 `world.interactables`。

## 任务导航：一个位置是一次查询，不是一张坐标表

追踪器一直只印目标那句话——「击败 5 只霜狼」「前往七天神像」。420 m 的蒙德平原里有 7 个营地、
3 个锚点、4 口宝箱，地面上没有任何标签，所以那句话不是指令，是谜语：十条魔神任务读得懂，
但找不到，整条主线卡在**游戏从没告诉过玩家的知识**上（霜狼在哪刷）。

修法不是手写一张坐标表。每个阶段的 `target` **已经**是世界数据里的一个 id——NPC id、POI id、
宝箱档位、敌人 id、某种怪掉的材料 id——所以位置是一次查询，跟成就里「一个统计是一次查询」
是同一件事。`shared/src/data/questNav.js` 里一个 kind 一个 resolver，写在 `STAGE_LOCATORS` 里，
并且**两个方向**对着 `QUESTS`/`QUEST_EVENT_SOURCES` 卡：没有 locator 的 kind 是一个指不出去的
目标，没有 kind 用的 locator 是看着像承重墙的死代码。

答案只有四种形状，其中第三种是这个模块存在的理由：

| 形状 | 意思 | 界面上长什么样 |
|---|---|---|
| `place` | 本区域里的一个点 | 箭头 + 距离 + 小地图菱形 + 大地图金色 pin |
| `place`（门） | 目标在别的区域，但**门在这个区域** | 箭头指「深渊试炼场入口」——第一次找秘境就靠这个 |
| `zone` / `here` | 在别的开放区域 / 就在这里 | 「龙脊雪山 · 打开地图传送」「在秘境内开始第 3 间」 |
| `panel` | 根本没有地点 | 「按 <kbd>L</kbd> 打开料理」，键从 `KEYMAP` 读 |

一个人称量的位置全部经过 `heightAt()`，所以箭头指的是地面而不是海平面；宝箱、采集点这类
带进度的目标读 `game.world` 的实时列表，**开过的箱子不是目的地**，下一口才是。

### 门禁当场抓到的第一个洞

`questNavGateReport()` 除了词表双向，还断言**每条任务的每个阶段都能解析出东西**。第一次跑就红：
`q_tyrant.s2（击败暴风之主）resolves to nothing`。最终 boss 只出现在 `zone.chambers[].waves`
里，从来不站在 `zone.spawns` 的营地上——也就是说整条主线最后一个目标是个没有箭头的目标。
`findChamberEnemy()` 补上：在秘境外指入口并带上层数，已经进去了就说「第 3 间」。

### 追踪器是一个状态，不是一条通知

浏览器探针第一轮把真正的 bug 抓出来了：**登录进去时追踪器是空的**。它只由 `quest` 和
`playerState` 两个事件写，而这两个事件在进入世界时都不发——序章任务是随账号发的，四条每日
委托在第一帧之前就掷好了，所以一个有 5 条进行中任务的玩家，屏幕左下角是空的，直到他碰巧
打死了什么东西才突然冒出来。修在 `Hud.setZone()` 里刷一次：那既是挂载路径（`ui.js` 构造时
调用），也正是切区域需要的重解析钩子——否则箭头会继续对着上一个区域的坐标算距离。

### 同一句话的两份实现，在一个迭代里就漂了

追踪器印「按 <kbd>L</kbd> 打开料理」（键从 `KEYMAP` 读），任务面板印「料理」——同一个目标，
面板给出的是一个不是地点的地点名。四种形状里有三种根本没有位置，那句话就是全部答案，
所以现在只有 `client/src/ui/navtext.js` 一份，面板只多加区域名和距离。探针把这条钉住：
两个文件都必须 import 它，两个文件里都不许出现 `kind === 'here'`，去掉注释之后哪个文件里都
不许出现 `按 X 打开` 这种写死的键。顺手修的还有两处：`采集点（sweetFlower）`——名字里漏了
一个玩家没见过的 id（现在过 `itemName()`，探针禁止任何位置名里出现 4 个以上连续拉丁字母）；
以及「在地图上查看」按钮紧贴在地名最后一个字上（`.qwhere` 改成 flex 行，探针量按钮和文字
之间的像素间距 ≥ 4）。

### 探针：`game.me.x = …` 不会让角色动

写 `game.me.x` 之后读回来是新值，一秒之后角色又回去了——服务端（单机模式下是本地 sim）
发来的位置校正在 `localPlayer.correct()` 里把它 lerp 回去了。这正是那种「断言全绿、玩家看到
的游戏根本不是这样」的探针修正。改成走产品自己的点击移动路径（`setGoal(x, z, 'interact', it)`，
和点一下 NPC 完全同一句），角色自己走过去、自己交互，于是端到端的那条断言也变成真的：
**沿着箭头走过去，阶段完成，箭头自己移到下一个目标**——序章两个阶段是真的用脚走完的
（28 m → 2.4 m，stage 0 → 1；20 m → 2.0 m，stage 1 → 2，箭头从「七天神像」变成「水史莱姆营地 88 m」）。

### 一条时不时红的断言，是箭头真的慢了 167 ms

「转 90° 相机，箭头必须跟着转」这条第二次跑变红了：`124.8° → 124.8°`。原因不在探针的等待时
间，而在产品——距离文本和箭头角度写在同一个 6 Hz 节流分支里。距离一秒变六次完全够用，但
箭头的答案**只要相机动就变**，节流意味着鼠标转视角时箭头最多落后 167 ms，看上去是一格一格
地追着相机跳。`_navAim()` 拆到节流之前每帧执行（一次 `atan2` + 一个 CSS 变量），探针改成逐帧
轮询并把帧数写进断言（`after 1 frame(s)`，预算 2 帧），同时加一条结构断言：`--rot` 不许再出现
在 `_navTick` 的节流段里。探针闪烁是症状，被节流的是玩家的箭头。

### 验证

`tools/questnav-check.mjs` 四节，77 条断言：

- 词表两个方向 + 14 条任务 29 个阶段 × 5 个可读区域 = 174 次解析全部有答案，四种形状都被真
  内容用到；反向也钉住：没有 resolver 的 kind、target 打错一个字母、越界的 stageIndex 都必须
  解析成 `null`，否则上面那些绿灯只是「一个永远有答案的函数」。
- 答案对着世界数据本身核：NPC 自己的坐标、POI 自己的 `at`、开过的箱子换成下一口、最近的营地
  是**离玩家**最近的那个（换两个站位得到两个答案）、龙脊雪山的任务在蒙德读也不会被蒙德的
  霜狼营地骗过去（任务自己的区域优先）。
- 界面消费者：三处（追踪器 / 小地图 / 大地图与任务面板）都必须存在，样式键也查。
- 浏览器里：距离和方位对着游戏状态算（arrow 124.8° vs bearing 124.8°），转 90° 相机箭头必须
  跟着转；藏 canvas 量那一行的墨色再藏掉它自己作对照；小地图用 `getImageData` 数金色像素，
  **对照是把 `navTarget` 清掉之后那些像素必须归零**（不然「有金色像素」对宝箱 pin 也成立），
  再把目标挪到 320 m 外验证它贴在圆盘边缘而不是消失；大地图的 pin 位置对着地图自己的
  `toScreen()` 比（0.0 px）。

## 任务结算：一句话写了十遍、没有人读

打完序章 风起之时，屏幕上出现的是「任务完成 · 风起之时」一行横幅、一声铃，和两个飘字
（摩拉、原石）。这一轮就是把这块屏幕补齐，而补齐的三样东西全是**写好了、没有消费者**的数据：

- `outro`——任务结束时委托人说的那句话。十条主线里只有两条写了，而且写了的那两条也从来没有
  任何代码读它。
- 剩下的奖励。御风之刃（4★ 单手剑）、大英雄的经验 ×2、纠缠之缘 ×2 是真的进背包了，但飘字只
  认摩拉和原石，所以玩家看到的是「+3000 摩拉、+60 原石」，一把剑悄悄躺进了背包。
- 下一章。服务端在同一个事务里就把 `def.next` 激活了，然后**不告诉任何人**：Postgres 里有这一
  行，当前会话里没有，于是追踪器变空、地图上没有 pin，故事要等玩家自己刷新页面才继续。

### 一个字段的消费者要从两头钉住

`questHasEnding(def)` 是这一轮唯一新增的判据（非日常、非可重复），它同时被两处读：客户端拿它
决定「弹结算卡还是走横幅」，`questGateReport()` 拿它要求**正好这些任务**必须同时有 `intro` 和
`outro`、其余任务一律不许有 `outro`。少写一句话和多写一句话都会红，这才叫有消费者——
「委托完成」的横幅分支同样是真分支，探针会真的打完一条每日委托来证明它走过。

### 一份奖励清单，只许有一个作者

`rewardList(rewards)` 放在 `shared/src/data/items.js`：结算卡、任务面板的奖励预览、探针，三处
读同一个函数，顺序也由它固定（货币在前）。在这之前面板里是 `itemName(id) || id` ——一个拼错的
id 会以 `windriderEdg ×1` 的形式出现在一句中文里。现在 68 条奖励行全部必须能被 `itemDef` 解析、
数量为正，否则门禁红。

### 结算是一次状态交接，不是一条通知

`advanceQuests` 在完成的同一次 push 里带上 `next`，而且带的是**记录本身**（`next.rec`）：

```js
next = { id: def.next, name: nd.name, chapter: nd.chapter || null, intro: nd.intro || null,
         stageDesc: nd.stages?.[0]?.desc || null, rec: { ...player.quests[def.next] } };
```

客户端 `_applyQuestUpdates` 把这一行插进活的任务文档，于是追踪器、任务面板、地图 pin 在同一帧
里全部指向下一章的第一个目标——不需要刷新，也不需要客户端自己去猜下一章是什么。

### 结算卡不暂停游戏

它不调 `setPaused`、不套 `.scrim`。最后一只史莱姆倒下的那一刻，多人世界里往往还有别的东西正
朝你挥，一块吃掉键盘的模态框等于「死在自己的奖励屏幕上」。所以它是一张居中的卡片，点任意处
或点「继续」关掉，14 秒后自己消失，世界在它背后照常跑；Escape 先关卡片、再开设置菜单。

### 探针跑出来的三个缺陷，两个在产品里

- `.qe-name`（章节名后面那半个标题）**没有任何 CSS 规则**。断言是双向的：卡片写的每个 class 都
  要有规则，每条规则也都要有人写——16/16。
- 每次击杀的战利品行印成「获得 史莱姆凝液 ×2、摩拉 ×50、摩拉 ×50」：服务端 `grantKillRewards`
  返回的 `items` 里已经含摩拉，客户端又把 `d.mora` 追加了一遍。合成一张 map 之后，断言直接钉在
  刚刚那几次击杀的聊天行上（每行最多出现一次「摩拉」）。
- 第三个在探针里：`killOne` 连打 90 秒，史莱姆 320 hp 一点没掉。两个原因都是静默的——
  `spawnEnemy` 之后立刻 `setTarget` 会被自己清掉（角色还没流进 `actors`，自动攻击那段查不到
  `enemyById` 就调 `_clearTarget()`），而 `_handleMouse` 整段在 `if (!this._paused)` 里面，
  上一步神像留下的模态框一开，整个预算期一次都不会挥。修法是让那一轮轮询等于**一次鼠标点击**：
  取锁、够不到就下 `'approach'` 目标、发现 `_paused` 就关掉 scrim 并计数；挥刀始终由产品自己的
  自动攻击循环负责，探针不许调 `me.attack`，否则它在「鼠标操作打不了架」的构建上照样绿。

### 「多出来的 20 原石」不是 bug，是任务自己买来的那一阶

钱包断言第一次红在 `原石 +80`，期望 60。多的 20 是任务奖励里的 500 冒险经验刚好顶过一阶，
而升阶自己付 20 原石（每五阶再付 2 纠缠之缘）。所以期望值现在是从等阶差推出来的
（`def.rewards.primogem + 20 * ranks`），摩拉是唯一的下界（三次击杀也在往里付）。
把外部收入算进「这条任务付了多少」，和它的第一次犯法（解锁七天神像自己付 30 原石，快照取在开跑
之前，于是「任务付了 60」被读成「有人付了 90」）是同一个错误——所以快照现在紧贴着击杀之前取。

### 一个日志文件，两个探针进程

这一轮差点把「已经修好」读成「7 条红」：上一轮的探针还活着，新一轮 `> /tmp/questend-check.log`
只是截断了文件，旧进程按自己的偏移继续写，于是日志里出现了一行
`...第一章 · 丘丘人的威胁   daily kills: 320hp/22s ...`——两次运行互相插字，中间还夹着一份旧的
总结行。后台跑探针之前先确认上一轮已经退出，日志名带上轮次。

### 一条 3.5 秒的横幅，和一次没等回信的轮询

「每日委托走横幅」这条断言在一次全量套件里报红：`(no banner in the last 3.5 s)`。产品是好的，
两处都是探针的错，而且它们叠在一起才露出来：

1. `killOne` 在**本地 actor 死掉**的那一刻就返回，可是推进任务的是 `POST /api/world/kill` 的
   回信。循环每杀一只只查一次 `quests()`，于是第 12 只（正好是收尾那一只）查到的还是
   `active`，循环又买了第 13 只——日志里 `3 + 10 = 13` 次击杀却只记到 `s1:12`，那个 1 就是证据。
2. 就算不多杀，`hud.banner` 的 `setTimeout` 只给横幅 3500 ms 的寿命，而这里一只史莱姆要
   8-11 秒。「循环跑完之后读一次 DOM」问的其实是「最后那一刀恰好是收尾那一刀吗」。

改法不是把等待时间调长，是**把事件录下来，从第一刀之前就开始录**：`game.on('banner', …)` 把
`{title, sub, 矩形, opacity}` 推进数组。HUD 自己的监听是在构造时注册的，所以它先跑——录制器看到
的时候元素已经在文档里了，于是一个录制器同时证明两半：游戏说了这句话，**并且** HUD 把它画上了
屏（268×122 px，opacity 1）。opacity 要在 800 ms 之后再取样，不能在事件那一帧取：`bannerIn`
从 0 起步，到 3.4 s 的 14% 才升到 1，当场读会读成透明。负控制是把同一个录制器指向
`.bannerNOPE`——`el:false, w:0`，「画上屏了」那条立刻变红。循环那半边则改成杀完一只**等回信**
（最多 4.8 s 的轮询）再决定要不要买下一只，于是 9 刀收工、横幅进了截图。

### 验证

`tools/questend-check.mjs` 三节，55 条断言：

- 数据：十条有结算卡的任务全部有 `intro`+`outro`，四条日常一条都没有，两边的集合正好是
  `STORY_CHAIN`；68 条奖励行全部解析得出名字与正数数量。**门禁自证能红**：抽掉一条主线的
  `outro`、给日常加一句 `outro`、把奖励 id 拼错一个字母、把 `next` 指向不存在的任务、让 `next`
  链和 `STORY_CHAIN` 不一致——五个变异必须五个被抓到，然后目录复原、再确认干净。
- 结构：完成 update 必须带 `outro`/`next`/`rec` 而阶段推进不带；客户端必须用
  `questHasEnding` 而不是自己写 `type` 判断；卡片不许出现 `setPaused` 与 `scrim`；
  Escape 必须先关卡片；奖励行必须来自 `rewardList`；class 与 CSS 规则双向对齐。
- 浏览器里真打一遍：走到莉莎（28 m）、走到神像（20 m）、打死三只史莱姆，然后读屏——
  「序章 · 风起之时」、莉莎的收尾台词、`💰摩拉×3,000 💎原石×60 ✦冒险经验×500 📗流浪者的经验×3
  🎫纠缠之缘×1`、「第一章 · 丘丘人的威胁 — 击败 6 只丘丘人 (0/6) — 丘丘人营地」、卡片
  446×456 px 真的画在屏幕上、`_paused` 全程为假、没有 `.scrim`、「继续」按钮关得掉，钱包
  按上面那条公式核对；再打完一条每日委托（9 次击杀）证明它走的是横幅、不是卡片——横幅是
  录事件读出来的，连它 268×122 px 的矩形和 opacity 一起（见上一节）。

## 传说任务与世界任务：一个只有声明、没有实例的词表

`QUEST_TYPE` 里一直有四个值：`story`、`daily`、`side`、`world`。前两个各有实例（10 条主线、
4 条每日委托），后两个有 UI 芯片（`ui/panels.js`）、有 CSS 配色（`.qtype.side` / `.qtype.world`
两种颜色）、有追踪器排序里的一席，**一条任务都没有**。这不是「以后再写」的占位：它长得跟写完了
一模一样，因为所有的门禁问的都是「每条任务的 `type` 都在 `QUEST_TYPE` 里吗」——只有实例存在的
那个方向。反方向那半句（**每个声明过的值都必须至少有一个实例**）现在写进了
`questGateReport()`，它当场就红了两条。

同一次盘点里还有五个 NPC 除了「与…交谈」什么都不做（花语、凯瑟琳、铁匠、深渊商人、璃月商人），
和一个 `ly_puzzle1`——一个建好模、能解、没有任何任务读它的谜题 POI。所以这一轮加的六条任务不是
凭空写的内容，是把已有的世界零件接上：

| id | 类型 | 委托人 | 前置 | 阶段 | 用上了什么原本没人读的东西 |
| --- | --- | --- | --- | --- | --- |
| `sq_flower_wine` | 传说·蒲公英 | 花语（杂货） | `q_intro` | 采集 → 料理 → 交付 | 花语这个 NPC、`sweetMadame` 配方 |
| `wq_wolf_howl` | 世界·奔狼领 | 凯瑟琳 | `q_slimes` | 抵达 → 击杀 → 珍贵宝箱 | `mond_wp3`、丘丘弓手营地 |
| `sq_smith_ore` | 传说·风锤 | 铁匠 | `q_ruins` | 采矿 → 掉落物 → 交付 | 铁匠这个 NPC、`chaosCore` 掉落 |
| `wq_abyss_hood` | 世界·裂隙 | 深渊商人 | `q_abyss_gate` | 秘境第 5 间 → 收集 → 华丽宝箱 | 深渊试炼场的中层楼层 |
| `sq_starsilver` | 传说·雪线 | 探险家 | `q_frost_seal` | 采集 → 取暖 → 掉落物 | 龙脊雪山的取暖点 |
| `wq_liyue_lantern` | 世界·归离原 | 璃月商人 | `q_liyue` | **解谜 → 击杀 → 采集** | `ly_puzzle1`（此前零消费者） |

### 奖励用曲线计价，不要手写常数

等级与冒险等阶都是超线性曲线，所以「支线给 10 000 摩拉」这种常数在 5 级是暴富、在 40 级是打发。
六条任务的奖励因此是**推出来的**：找 `minLevel` 最接近的那条主线，取它的一半，摩拉取整到 500、
经验到 100、原石到 10（下限 20）。手写的只有物品清单——物品是内容，数值是曲线：

```js
function extraRewards(minLevel, items) {
  const r = nearestStory(minLevel).rewards;
  return { mora: Math.round(r.mora / 2 / 500) * 500, xp: Math.round(r.xp / 2 / 100) * 100,
           primogem: Math.max(20, Math.round(r.primogem / 2 / 10) * 10), items };
}
```

派生买到的那条性质才是值得断言的：按 `minLevel` 排序，摩拉与经验**都不许下降**
（3 000→6 000→7 500→10 000→16 000→20 000，600→…→4 800）。这条在门禁里，不在测试文件里，
因为它是目录的不变量。

### 一个判据，两个提问者

「这个 NPC 现在有任务给我吗」有两个提问者：`POST /api/world/talk`（要真的把任务交出去）和
客户端交互提示（要不要印「有新任务」）。写成两份就是提示承诺了路由拒绝的任务——玩家走过去、
按 F、什么也没发生。所以只有一份 `offerableQuest(npc, player)` 在 `shared`：

```js
for (const id of ids) {                       // npc.quest（主线钩子）+ 所有 giver === npc.id 的额外任务
  const def = QUESTS[id];
  if (!def || quests[id]) continue;           // 已经拿过（哪怕做完了）就不再给
  if (!questUnlocked(def, quests)) continue;  // 前置必须 done
  if (rank < rankForLevel(def.minLevel || 1)) continue;
  return def;
}
```

`api-check` 里那一段的最后一句断言就是这件事：把服务端刚返回的**玩家存档原文**喂给这个判据，
要求它对蒙德每一个 NPC 的结论都和路由刚做的事一致——手搓一个假 player 只能证明判据自己前后一致。

### 内容也要自带门禁，不然一个打错的 `giver` 就是永远拿不到的任务

新内容最容易的死法不是崩，是**没人能碰到**。四处门禁，各管一个方向：

- `questGateReport()`：每个 `QUEST_TYPE` 都要有实例；`EXTRA_IDS` 与 `type` 两向一致；额外任务
  不许出现在 `STORY_CHAIN`、不许带 `next`、必须有 `giver`/`requires`/`zone`，`requires` 必须是
  一条主线。最后**走一遍判据**：造一个主线全通、AR 90 的玩家，对每个委托人反复调
  `offerableQuest` 直到六条全被交出来——`giver: 'grocer '` 多一个空格会在这里红。
- `zoneGateReport()`：`def.giver` 必须真的是 `def.zone` 里的一个 NPC。
- `questNavGateReport()`：六条任务的每一个阶段都必须解析出一个可指向的地点（`ly_puzzle1`
  就是这样被证明能当目标的）。
- `questend-check`：有结算卡的任务集合 = 主线 ∪ 额外任务，**逐个 id 比对**。写成
  `type !== 'daily'` 就等于以后新增一种类型时替我做了决定。

顺手修掉的两件小事：`npc.role`（`'guild'`/`'forge'`/`'quest'`/`'shop'`）在对话面板里有一张私有
的中文表、在交互提示里**直接印英文 slug**（「与铁匠交谈 / forge」），现在是 `zones.js` 里一份
`NPC_ROLES` + 两向门禁；追踪器的优先级从「主线优先，其余看 `Object.entries` 顺序」变成
`story < world < side < daily`——否则今天 04:00 写进存档的一条每日委托，会凭键顺序压过玩家五分钟
前刚接的传说任务。

验证：`api-check` 292/0（新增 12 条断言：前置未完成时铁匠不给、判据同意；花语给出且类型
`side`；带 `chapter`/`intro`/`name`；再谈不重发；列表里只有一行、三个阶段；采集把 `s1` 从
0/6 推到 1/6；判据与路由对蒙德四个 NPC 结论一致）、`questnav-check` 77/0、`questend-check`
54/0、`quest-check` 15/0、`balance-check` 32/0、`mp-check` 全绿；整套门禁
`48/48 GREEN · 2858 assertions`（`/tmp/check-all-20260908-131529/`）。顺带修掉一条门禁的假红：
「`questNav.js` 不许碰 DOM」是拿正则扫**原文**的，我在注释里写了一句「玩家存档 document」就红了——
现在先 `nocomment()` 再扫（并用一个真的 `document.body` 变异体确认它还抓得住）。

## 倒下与复苏：五个洞，五个都是「写好了、没有人读」

角色被打倒之后，屏幕上只有一行「你倒下了」，然后**站在原地不动**——没有面板、没有复活手段、
没有倒计时。挖下去，这一块的每一处缺口都是同一个形状：数据或分支已经写好了，只是没有消费者。

- `world_progress.unlocked`——每走到一个锚点都往里写一行，加 5 原石，从来没有任何读取方。
  于是大地图上 14 个锚点全都能点，点了就传送，「走过去点亮它」这句设计等于不存在。
- 倒下面板上的两个按钮，`原地复苏` 和 `返回锚点`，发的是**同一条**消息。
- 「按 R 复活」——`KEYMAP.aim` 是 `KeyR`。R 从来没有复活过任何人，它是弓箭的瞄准键。
- 网关里有一整段「复活队友」的分支，客户端没有任何地方会发那条消息。
- 自动重生把人送回 `zone.poi` 里**第一个** waypoint。蒙德的第一个是风起地；你在果酒湖畔倒下，
  醒来在 143 m 外的另一头。

### 复活点是「最近的已激活锚点」，一次查询就够

`defaultAnchor(zdef)` / `respawnAnchor(player, zdef)` 放在 `shared/src/world/anchors.js`，
两个宿主（浏览器里的 `ZoneInstance`、服务端网关）和 `/api/world/teleport` 三处读同一份：

```js
export function respawnAnchor(player, zdef) {
  const open = anchorsOf(zdef).filter((a) => isUnlocked(player, a.id));
  return nearest(open, player) || defaultAnchor(zdef);
}
```

「锚点」是 waypoint 与七天神像，宝箱和 NPC 不是——所以 `unlocked` 里躺着一行宝箱 id 也不会
把宝箱变成传送目的地（404 `no_such_anchor`，不是悄悄退回入场点）。入场锚点永远开着，否则
新号无处可去；其余 13 个都要先站上去。这条规则同时是复活点和传送门禁的判据，两个方向都钉死：
没激活就传送是 403 `anchor_locked`（「这个锚点还没有激活，先走过去点亮它」），
在没激活的神像旁边倒下则回到**最近的已激活**锚点，而不是脚底下那个。

### 一个手打的键名，是对另一个文件的一句承诺

「按 R 复活」不是打错字，是一类缺陷：一句中文里写死的键名，是对 `KEYMAP` 的断言，而没有任何
东西能让它保持诚实。同一次扫描还翻出启动提示里的「Tab 查看好友」（Tab 是地图，好友是 U），
以及 HUD 里三个 tooltip 手写的 `(I)`、`(H)`、`(M)`——那三个当时是对的，但同样是无从校验的巧合。
现在所有这类句子都走 `keyHint(action, what)`，键从表里查出来：

```js
title="有未领取的邮件，点击或${keyHint('mail', '打开')}"
```

门禁扫 35 个客户端文件，禁止 `按 X`／`title="…(X)"` 两种字面形式出现在 `input.js` 以外，
并且自带反向对照：把 `keyHint` 换成手打的一行必须被抓到。

### 倒计时要读时钟，不能积分 dt

`_downedTick(dt)` 原本把每帧的 `dt` 累加起来倒数。而 `dt` 是被夹住的（一帧卡了两秒也不许让
人瞬移），模拟自己的计时器用的是墙上时间——于是在 llvmpipe 的 3 fps 下，2.3 s 的等待只让标签
走了 0.35 s，「8 秒后」原地不动地显示了整整八秒，然后角色突然站起来。改成从时间戳推：

```js
const left = AUTO_RESPAWN_SEC - (now() - this._downAt);
```

顺手补了另一半：`revived` 时把标签清空。`_downedTick` 只在倒下时跑，留在里面的
「正在返回锚点…」会成为**下一次**死亡开屏的第一帧。

### 一个按钮的两个状态都要量像素

`原地复苏（提神醒脑的汤 ×0）` 是禁用的，而让它**看起来**禁用的只有一行 css
（`.btn:disabled { opacity: 0.42 }`）。断言 `disabled` 属性的探针，在删掉那行样式的构建上
一样绿——玩家看到的是一个亮着的按钮点不动。所以这一条量的是像素：藏掉 canvas（背后的世界还在
动，不然量的是天空），同一个矩形拍两次，禁用 249×38 px 的亮度 67.4，塞两碗汤之后 148.8，
必须差出 1.25 倍以上。

### 探针：不许点玩家看不见的按钮，一次致命伤也不是死亡

- 第一版点 `[data-act="resume"]`（继续冒险）。那个按钮**每次启动都在 DOM 里**，只是所在的行
  `hidden`；没有存过 token 时点它直接进「登录状态已失效」，`game.me` 是 null。改成先问哪一行
  真的显示着，再点那一行的按钮。
- 第一版打一下就去读面板，读到 `hp 1290` 和一个不存在的面板，判了 12 条红。原因在产品里而且
  是对的：`PlayerEntity.takeDamage` 会切换到队伍里下一个还有血的角色，只有全队倒下才
  `alive = false`。一次致命伤测的是游戏永远不会显示的状态。
- 「已经发货的那条规则」留在探针里当函数（`shippedRespawn` 取表里第一个 waypoint、
  `shippedTeleportAllows` 恒真），断言要求它们和新规则在同一份存档上**给出不同答案**。
  一个不可能红的门禁只是一句注释。

### 验证

`tools/death-check.mjs` 四节，106 条断言（1 条 SKIP）：

- 数据：6 个区域 14 个锚点，每个区域都有入场锚点（蒙德 4 / 龙脊雪山 3 / 璃月 4，所以
  「最近」不是常量）；空存档在蒙德只能传送到 1 个地方，点亮一个就正好多一个；站在没激活的
  锚点上倒下退回入场点，激活之后回到它自己；宝箱不是目的地。
- 结构：每条 C2S 消息在两个宿主里都有分支、在客户端都有发送方；两个按钮发不同的消息；倒计时
  用的是 `AUTO_RESPAWN_SEC` 而不是手打的 8；`REVIVED` 事件带坐标和锚点名，客户端在收到时就
  `teleportTo`，不靠服务端纠偏把人拖回去；复活范围 4 m、救起来 50% 血，客户端和网关读同一个常量。
- HTTP：新访客传送到没点亮的果酒湖畔 403，宝箱 404，入场锚点 200；点亮之后 +5 原石、同一次
  传送 200 落在 (130, −60)，旁边的神像仍然 403。
- 浏览器里真的死一次：传送被拒并给出理由 → 走过去点亮 → 跳到果酒湖畔 → 走开 18 m → 全队倒下
  → 面板、横幅、两个按钮、倒计时 7 s → 2 s → 点「返回最近的锚点（果酒湖畔）」落在 0.0 m
  （风起地 143.2 m）→ 再死一次，7.8 s 后无人干预地回到同一处 → 大地图上两个 ◈ 两个 🔒，
  点 🔒 的那个不传送、只弹提示、地图不关。

`tools/mp-check.mjs` 补上网关这一侧的拒绝面：`C2S.REVIVE` 是唯一一条**主语是别人**的消息，
所以那两道门就是它全部的访问控制——没有 `not_downed`，「救队友」等于任意距离上的一次免费
50% 治疗，`C2S.RESPAWN` 等于站着传送回锚点。三次拒绝（救站着的队友、救不在这个分片里的人、
活着要求回锚点）之后，没有任何 `REVIVED` 发出去，两个人血量一格没变（1030→1030）。
`too_far` 那一支在协议层构造不出来（C2S 里没有任何消息能造成伤害，也就没法让远端的人倒下），
它由浏览器探针在本地模拟里跑。

## 一条命令跑完整套门禁：`exit 0` 不是证据

仓库里有 32 个探针，和 0 个入口。每次迭代只跑手边那三四个，argv 靠记忆敲——而 argv 的形状并不
统一（`mp-check`、`build-check` 收 `host:port`，其余收 URL），敲错了还不像敲错：
`node tools/mp-check.mjs http://127.0.0.1:5173` 死在 `getaddrinfo ENOTFOUND http`，
读起来像服务器挂了。把每个探针真实的调用方式写下来一次，就是 `tools/check-all.mjs` 大半的价值。
按目标逐项核对的时候露出来的后果更直接：二十来个探针在当前这份代码上根本没跑过，
「每个模块都验证过」是一句关于过去的话。

三条规则，是 `for f in tools/*-check.mjs` 循环做不到的：

1. **`exit 0` 不是证据。** 一个开了浏览器、在第一条断言之前就抛了异常、然后返回 0 的探针，
   是这个仓库反复栽的坑：`check()` 忘了 `return`（整段被 `if (check(…))` 静默跳过，仍然报
   「0 failed」）、`default: break` 两个方向都不会失败、autorun 循环报了 23 小时的 `up`。
   所以只有「进程退出 0 **并且** 日志里解析到大于零的断言条数」才算 GREEN，其余是
   `NO-EVIDENCE`——那是失败，不是通过。
2. **一次只跑一个。** 每个浏览器探针都在抢同一个 Xvfb 和同一个 Vite；两个页面同时开，
   Firefox 会把失焦那个的 rAF 掐到 1 fps 以下，两边读到的都是旧帧。串行还有个副作用：
   墙上时间可以跨轮次比较。
3. **前置条件是查出来的，不是假设的。** 服务端 `/api/health`、客户端 200、X display、
   `/tmp/world-token.txt` 都在第一个探针之前验一遍，缺谁就点名 SKIP 谁，而不是 90 秒后
   莫名其妙地失败。display 查的是 X server 绑的 socket `/tmp/.X11-unix/X99`，不是
   `xdpyinfo`——这台机器没装它，而一个依赖不存在的工具的前置检查，会把所有 display 都报成缺失。

### 第一次跑完，红的两条是同一个原因：等级门把画面门禁锁在了门外

`nan-scan` 四条 FAIL，全是「the transition took — in mondstadt」；`tour` 在 dragonspine 直接
abort。都不是流式加载坏了：六个区域里有四个是等级门（龙脊雪山 AR 4、冰封洞窟 5、璃月 7、
黄金屋 18），而门禁按设计写在四个地方——客户端 `enterZone`、单机的 `localSocket`、网关的
`JOIN_ZONE`、REST 的 `/api/world/teleport`。新访客是 AR 1，于是项目里唯一一道「细腻画面」的
回归门禁，长期只拍得到蒙德和深渊试炼场两个区域，另外四个区域的画面证据一直是陈的。
更糟的是拒绝长得跟坏掉一模一样：`tour` 早一个版本把蒙德的截图写成了 dragonspine 的文件名。

### 提级要走真正的那条路，而且必须在页面打开之前

`POST /api/dev/rank`（`server/src/routes/dev.js`）只在 `config.isDev` 注册，启动时打印一行，
内部调 `grantAdventureXp`——奖励发放走的同一个函数，等级由 `totalXpTo`（`shared/sim/formulas.js`
里已经有，没有再抄一份）换算成 xp。这样 `adventure_xp`、`world_level`、AR 升级奖励都跟一个
老老实实打上来的等级一致；直接 UPDATE `adventure_rank` 会留下角色等级高于 `arCap(rank)` 的
存档，那是任何正常玩法都产生不出来的状态。同理它只前进不后退。

**必须在浏览器打开之前提级**，因为那四道门读的都是一份「只取一次」的存档：`Game.load` 取
`/api/player/state`、`localSocket` 把它留成 `this._save`、网关在连上时从缓存里取自己那份。
在活着的会话里改等级，这三份副本全都还是 AR 1。所以 `tools/lib/account.mjs` 的顺序是固定的：
node 里发号 → 提级 → 把 token 塞进 `localStorage` → 才 reload 页面点「继续冒险」。
探针自己也验这一步：`nan-scan` 断言点到的是「继续冒险」而不是「立即游玩」，
否则它拿到的是另一个新建的 AR 1 账号。

### 跳过要出声，而且总账要红

hook 缺席时（生产构建，或者服务端还没重启）`raiseRank` 不抛异常，返回一句可打印的理由，
探针把到不了的区域**点名 SKIP 并打出这句理由**，同时让一条总账断言失败：
`tour` 少拍一个区域就 `exit 1`，`nan-scan` 有 SKIP 就红。一个只跑了两个区域的 tour
绝不能看起来像跑了六个——豁免必须配一份义务，否则「all passed」就开始撒谎。

### 验证

- `--group data,http`：11/11 GREEN，664 条（data 8 个探针 323 条，http 3 个 341 条），13 秒。
- `--group browser,visual`：21 个探针 20 分钟，19 个 GREEN、1039 条断言，红的两个就是上面那两个。
  三组合计 32 个探针 1703 条断言。
- `api-check` 新增 8 条把 hook 从两头钉住：龙脊雪山传送先 403 `rank_too_low{need:4}` →
  匿名调 hook 401 → `rank:0/9999/{}` 全 400 → 提级 AR 1→4（xp 0→1680，`worldLevel` 按公式）→
  **同一次传送 200 落在 dragonspine** → 再要 AR 1 时 `moved:false` 停在 4 → `/api/health` 的
  `devHooks:true` → 读 `server/src/index.js` 源码确认注册仍然包在 `if (config.isDev)` 里
  （269 → 277 条）。
- 打开 hook 之后重跑那两条：`nan-scan` 六个区域全进得去，2073 个 geometry、5407 条顶点属性、
  零个非有限值（25 passed / 0 failed / 0 skipped）；`tour` 第一次真的拍满 `6/6 zones`，
  钉在 high，无 page error 无 HMR——龙脊雪山、璃月、冰封洞窟、黄金屋的画面证据到这一刻才第一次
  是当前这份代码的。
- 顺手修掉的一个「靠运气的探针」：`api-check` 的武器养成那一节需要一把**穿在身上又有替身**的
  武器，而十连抽给什么是随机的。这一轮抽出了 3 把猎弓、3 支铁尖枪、2 本训练法书，新访客那两个
  角色一种都拿不了，于是 `worn` 是 undefined，`WEAPONS[worn.weaponId]` 抛异常——不只是这一节红，
  它后面所有节的断言都跟着没了。改成跟精炼那一节同一个办法：不够就去铁匠那儿花 20000 摩拉
  买一把**已经穿在身上的那把**，把持有者变成重复持有者；真凑不出来时靠一个带标签的 `break`
  只红一条，不再是 stack trace。

## 金光底下只有明度差活得下来：黄金屋这一帧

上一节第一次把黄金屋拍下来，结论是六个区域里最弱的一帧：整屏一个金橙色调，地板占七成画幅
只有一个色，墙面、穹顶、地板三个大面的亮度几乎一样，全画面找不到一处深色。

**为什么加个别的颜色没用。** 这个区域的太阳是 `0xffdca0`、环境光是 `0x9a8558`，也就是屏幕上
每一个像素都被乘过一遍金色：中性灰的墙（`MATS.stonePale` 0xbdb6a4）渲染出来照样是金的，
色相差会被这个乘法吃掉大半。能穿过它的是**明度**——`stonePale` 的 luma 是 0.71，跟被near-vertical
太阳直射的地板一样亮，所以那面墙不是「颜色不对」，是「没有比地板暗」。这一轮四个改动全部
落在 albedo 上，一个都不在灯光上（这也是 `tools/gamut-check.mjs` 那个教训的另一面）。

1. **墙裙（dado）**：`props.enclosure.wallColor: 0x9c4a34`，配一个新的参数化材质
   `MATS.lacquer(hex)`（2 个 band、glossy 的硬终止线、粗 mottle 当剥落）。同一面墙的勒脚和
   线脚不是另找一个颜色，而是 `shade(wallColor, 0.55)` 和 `0.34`——一种材质做三道工。
   金线脚下面那道**深色凹槽**是手画的：墙面朝着场地中心、这个区域的太阳仰角 0.92，整面墙都
   压在 cel ramp 的暗带里，灯光不可能自己产生一条水平线，而卡通描边只画在剪影上，画不到墙中间。
   量出来（同一台相机、同一个 yaw 的 tour 帧，rect `300,178,420,22`）：**luma 96.5 → 47.3**。
   横扫墙裙那一行：墙裙 53、上层墙 123、压在墙裙前面的金壁柱 110——三个层次。
2. **地板的第四个 biome**：平地只可能取到 `biomes[0]`（`goldFloor` 允许任意坡度任意高度，
   `biomeIndex` 是首个匹配），所以地上唯一的第二个颜色是 shader 里那条 `uColD` 的「裸土」项
   （`gfx/terrain.js`，mask 上限 0.62）——而它原来是 `ember 0xa8703c`，还是金的。改成
   `patina 0x4e6154`（埋在地下的鎏金地面上的铜锈）。量出来是**斑块**而不是整体变暗：`f1`
   90.7 → 89.8、`f3` 107.3 → 105.7 基本没动，落在锈斑里的 `f4` 从 `[190,127,42]` 变成
   `[119,94,41]`——红绿比 1.67 → 1.27，这才是「多了一个颜色」而不是「调了亮度」。
3. **地面镶嵌线**：`terrain.inlayColor` 是金的，而它按 0.45 混进金地板（`uInlayColor`，
   `ui/mapview.js` 烤小地图用的是同一个常量），等于图案只存在于数据里。改成玉色——
   但第一版 `0x2c6f5e` 被 `node tools/gamut-check.mjs 2c6f5e` 拦下：五个光照档里有三档红通道
   被 ACES 钳到 0，这是任何 shading 参数都救不回来的那种坏。取它给出的最小去饱和方向，
   落在 `0x40796a`。
4. **穹顶的暗锚**：`crownShade 0.72 → 0.48`（深渊试炼场 0.46、冰封洞窟 0.36）。只动这个而不动
   `rockColor`，因为顶棚的 albedo 要留在雾（luma 44.8）之上，而 crownShade 只压**顶心**——
   贴着雾线的起拱圈不受影响。`tools/vault-cam.mjs goldenHall`：10 passed / 0 failed，
   顶带 68.3 对雾 44.8、上暗下亮（68.3 / 地板 93.4）、天花线最大落差 16.7。
5. **室内的石头**：`rocks.scale` 的 2.8 是乘在一个约 4 m 的 recipe 上的，于是大厅正中间站着一块
   比玩家高、还插进柱子里的野外巨石。改成 `[0.45, 1.15]`（塌下来的碎石），密度略提。
   再加一组 `crystals`（`0x7fd8b0`，磐岩的回响）——它是这个房间里唯一一个**自发光**的非金色。

**新键要两头钉住。** `enclosure.wallColor` 三处齐全才算存在：`shared/data/zoneGate.js` 的
`PROP_GROUPS.enclosure.keys` 里登记它的消费者、`world.js#_buildEnclosure` 把它转发进
`buildPropField`、`props.js#protoKey` 把它加进 key 列表——最后这一条不加，proto 缓存会把第一个
区域的墙色发给后面所有区域（材质不同的 proto 本来就不能共享 InstancedMesh）。
另外 `bar()` 的宽度别跟身后那块板取一样的 `half`：侧面和背面**共面**，近景照出来整条边都是
z-fight 的点阵。窄 2 cm、浅 7 cm 就干净了，留下的 4 cm 缝正好读成两块板之间的接缝。

### 「没有这个 prop」也可能是等级门

`prop-cam goldArcade goldenHall` 回答的是 `no 'goldArcade' instances in goldenHall`——而拱廊
就在屏幕上。原因还是上一节那个：`/tmp/world-token.txt` 通常是 AR 1 的新访客，黄金屋要 AR 18，
`enterZone` 被拒，工具于是**用黄金屋的名字拍了蒙德平原**，然后如实报告蒙德没有拱廊。
`prop-cam` 和 `vault-cam` 现在都在页面打开之前提级，并且把「落在哪个区域」和「要求的区域」
对一遍，不一致就 abort 并打出需要的 AR。一个分不清「这个 prop 没建出来」和「你在别的区域」的
工具，说不了任何关于这个 prop 的话。

## 一块 3 m 的方砖比整个近景还大：地面这一轮

黄金屋的地板占七成画幅，上一节把它的第二个颜色和镶嵌线都改对了，再拍一次还是一片平。
`tools/pixstd.mjs` 量近景 4 m 的一块地：**std 4.3**——按这个仓库自己的经验值（一米见方
std < 4 是真的没纹理、8-15 是正常地面、>20 是边缘主导），它和「什么都没画」只差 0.3。

**先排除，再动 shader。** 一个一次只推一个 uniform 的临时探针（基准帧 + 每帧只改一个值）
把四个候选一次全打掉：`uColA` 改品红 → 地板整片变色，所以这块地**确实**是 terrain shader
画的；`uDetail` 推到 3 → 纹理项还是几乎不动；`uInlayMix` 归零 → 玉色带子下面的 std 从 1.1
只回到 1.6；`toneMappingExposure` 1.12 → 0.75 → std 反而从 3.3 掉到 **0.9**。最后这条最有用：
龙脊雪山那一轮的结论是「降曝光救回纹理」，在这里是反的。**一个杠杆在一个区域是对的，
不代表在另一个区域是对的，量了再用。**

排除之后剩下的两条都是结构问题，不是数值问题：

1. **室内地板一直在借草地的近景项。** `nearW`（草簇/草叶那一档）只按距离和 `uDetail`
   开关，室内也在跑，等于用「草」的形状去画石头。现在乘一个 `1.0 - indoor`，室内换成自己的
   `grit`（7.5 和 21 cycles/m 两档砂粒 + 一点高光噪点，2.5-11 m 淡出）。
   单独加这一项：近景 4.3 → **4.1**。**没有变好**——它只是补上了刚被关掉的草。
2. **镶嵌线是在「替换」而不是在「调制」。** `mix(floorCol, uInlayColor, k)` 的意思是
   「按 k 的比例把地板的纹理擦掉」，所以全场镶嵌最强的地方（黄金屋 0.72）必然是这块地
   最平的地方。改法是把所有纹理项收成一个**乘性**的 `dress`，再 `mix(floorCol,
   uInlayColor * dress, k)`：玉色带子从此带着方砖缝、砖面色差和砂粒一起走。
   `jade-spoke` rect：**1.9 → 17.8**。

**真正最大的一笔是砖的尺寸，不是砖的纹理。** 原来的 `floor(vWorld.xz / 3.0)` 是 3 m 的方砖——
比整个近景 rect 还大，也就是近处那一片里**一条砖缝都没有**，砖面内部再怎么加噪声都救不回来。
真实的方砖是 0.6-1.2 m，改成 1.5 m 之后近景 4.3 → **13.9**。这个数是它一个人挣来的。

砖的尺寸有两个消费者（shader 和小地图烤图），所以它是 `terrain.js` 里导出的
`export const ARENA_SLAB = 1.5`，一头插进 GLSL 模板字符串、一头被 `ui/mapview.js` import。
小地图 256 texel 画 160 m，1 m 只有 1.6 texel，1.5 m 的缝会糊成一片灰，所以烤图画的是
`ARENA_SLAB` 的**整数倍**（凑够 3.5 texel）——地图可以比地板画得粗，但不许画成另一种铺法。

其余几条都是「量出来才知道要这么写」的：

- **裂缝属于某一块砖。** 第一版用世界坐标的 fbm ridge，拍出来是一条条爬过四十块砖的褐色
  蚯蚓。改成骑在**砖局部坐标、每砖随机转 4 个方向**的 `vein` 上，裂缝到砖缝自己就停了。
- **砖的亮边（arris）只能是 albedo。** 这块地是高度场，一块砖的切边没有自己的法线，
  卡通描边又只画在剪影上；深缝里侧一道 7 cm 的亮边，才让网格读成「有厚度的砖」而不是画上去的格子。
- **线宽要随距离变宽，这就是抗锯齿。** 程序化噪声没有 mip 链，`aa = 0.012 + camD * 0.0016`
  配 `smoothstep(aa, aa*2.8, edgeM)`，一条 4 cm 的砖缝到 60 m 才不会碎成爬动的虚线。
  阈值全部用**米**表达（`edgeM = … * slabW`），改砖距不会顺手改掉缝宽。

同一轮把墙裙做成了漆金**嵌板**：`np = round(span / 4.3)` 块板，每块一圈凸起的边框 + 描金内框 +
中心一朵八瓣团花（`ring` + 8 根 `spike` + 珠子），顶上一条长短交替的回纹。装饰位置全部从
墙裙自己的前平面 `faceZ = -0.715 + 0.485` 算，不写死 -0.23。代价：黄金屋中心视角
299 draws / 453 082 tris → 338 / 588 438。

### 把手修的东西变成门禁，第一次跑就抓到两个区域

「地面没有纹理」这个缺陷已经在三个区域各犯过一次，每次都活下来，因为证据是一folder PNG、
没有人回头量。所以这一次把量法搬进 `tools/tour.mjs`——它本来就跑六个区域 × 四个 yaw、
本来就锁死画质档、本来就防 HMR，新增的只有三十行：一块贴着画面底边的地面 rect、
每张算 `std`、取四个 yaw 的**中位数**、`6.0 .. 34.0` 双边判定。算法抽到
`tools/lib/rectstats.mjs`，`pixstd.mjs` 和 `tour.mjs` 共用一份——不然在一个工具里校准出来的
阈值，到另一个工具里就是另一个意思。

- **中位数而不是均值或最小值**：一张里有棵树或一段墙压过 rect 不该决定整个区域，
  而失败的区域会把四张的 `rgb/lum/std/p5..p95` 全打出来，中位数是可复核的。
- **上界不是留白**：超过 34 说明 rect 落在 prop 边缘或角色身上，这时候它「通过」的理由
  和地板无关。
- **阈值必须用修好之后的那一轮校准**：用引出这次工作的那些截图定下界，等于把缺陷本身写成合格线
  （那批数字里深渊试炼场是 2.4）。
- **量像素要等游戏浏览器关掉之后**：在 WebGL 页旁边开第二个页面会把它切到后台，
  Firefox 掐掉 rAF，后面每张截图都是同一帧。

第一次跑（六个区域）：蒙德 14.3、璃月 11.2、冰封洞窟 15.7、黄金屋 10.2 —— 以及
**龙脊雪山 4.3 和深渊试炼场 3.3 两条红**。

### 纹理在色调曲线的两头都会被压掉，暗的那一头你不会怀疑

两条红是同一个病，而且是同一句话的两个方向：

**深渊试炼场跑的是刚刚写完的那套方砖 shader**，和黄金屋 10.2 的是同一段代码，量出来
lum 27、std 2.8、p5..p95 **24..32**——砖缝、砖面色差、纹理、砂粒全都算了，然后被塞进
八个 sRGB 阶，因为地板 albedo 是 `0x3a3a5c`。这是龙脊雪山「亮到肩部」的**镜像**：曲线的
底端一样吃纹理。同一帧里推一个值：`uDetail` 3 → std 6.3、`toneMappingExposure` 2.2 → 4.2、
提亮 albedo → **5.5** 且别的什么都没动。取 albedo：`abyssFloor 0x3a3a5c → 0x807ca8`
（连带 `abyssEdge`、`abyssRock` 一起抬）。暗厅是美术方向，纹理活不过自己的 albedo 不是。

**龙脊雪山的曝光那一轮是量 20 m 外的地面得到的结论**，脚底下那块地一直是 lum 194、
p5..p95 188..200、std 3.9。同一帧的排除做得很干净：`uDetail` 推到 **0 → std 1.1**，
所以那里每一个阶的纹理都是画出来的、没有一份来自光照；`uDetail` 3 → 6.3，
所以项在、只是太小。**一个在 3 倍幅度下都不动的项，是根本没到像素**；而
±20 % 的 albedo 摆动只换来五个 sRGB 阶，说明幅度和工作点两边都不对，得两边一起动：

- `snowColor 0xd4e2f0 → 0xbccddf`（雪仍然是全场最亮的地面，也仍然暗于自己的天空），
  连带坡面的 `snow` biome 一起改，免得平地和坡面之间出一条硬线。
- 补上**风棱（sastrugi）**这一档：drift 是 11 m 的雪丘（脚下那一米见方整块都在同一个丘里，
  看不见）、sparkle 是稀疏亮点，30 cm 到 2 m 之间原来什么都没有。沿风向 4:1 拉长的 fbm，
  `smoothstep(0.30, 0.70)` 先摊开再用（summed fbm 挤在 0.5 附近，这个坑 drift 踩过一次），
  背风面同时变暗**和变蓝**——被雪丘背阴变蓝是同一个道理，小一档而已。
- 近景 `crust`（雪粒之间的天蓝色小坑，不是亮点：亮点读成冰，那是 sparkle 的活）幅度加倍。

修完再跑这两个区域：**龙脊雪山 4.3 → 7.0**（四张 5.3 / 6.5 / 7.5 / 9.2）、
**深渊试炼场 3.3 → 9.0**（6.1 / 6.2 / 11.8 / 14.2）。方砖那三项幅度顺手各提了约 25 %：
一块暗地板的纹理花在更少的 sRGB 阶上，两个厅要**同样的相对摆幅**才值不同的绝对量。

### 一条断言只能指着它看得见的那个窗口

这一轮 `check-all` 唯一的一条红是 `death-check` 的「倒计时在走」：`7 s → 0 s`。产品是对的。
倒计时的读数取自面板刚弹出来时的快照，然后中间跑了四次 `frames(2)` 和两张截图——3 fps 下
这比整个 8 秒窗口还长。窗口一关，`ui/hud.js` 的标签**正确地**变成「正在返回锚点…」，
里面一个数字都没有，而探针拿正则从里面抠数字就抠出个 0，于是把「倒计时结束了」报成
「倒计时冻住了」。（这条断言本身是有价值的：它当年真的抓到过一个卡在 8 秒不动的计数器。）

两处改法，都是「让断言指着它真的看得见的窗口」：

- 倒计时的两条断言搬到面板弹出来的**第一时间**，并且**轮询**而不是 sleep——要看的是
  「第一次减少」这个事件，固定睡 2.3 s 是拿三分之一个窗口去等一件已经发生的事。
  同时把「窗口已经结束」和「数字没动」在输出里分开写。
- 「点『返回最近的锚点』能站起来」这一条原来在和那个 8 秒定时器**赛跑**：机器一慢，
  是定时器把人扶起来的，这条断言就白通过了。现在点之前先确认面板还在；不在就走远一点重新倒下
  （自动复活会把人放回锚点，直接重新倒下的话「按钮把身体挪走了」就什么都没量到），
  并且新增一条断言把这个前提本身钉住。

一条同类的：`api-check` 的「武器条目会铸出装备」在一次 `check-all` 里不是红，是**崩**——
`forged.b.gained[0]?.uid` 里的 `?.` 保护的是属性、不是下标，买失败时 `gained` 是 undefined，
于是一个 TypeError 把它后面一百来条断言全部带走，而且对真实状态什么都没说。
根因不是路由：一把剑 20 000 mora，而这一轮的钱包取决于 gather/cook 随机掉落被 growth 段
花掉多少，到这里正好落在价格两侧，resin 又早被 chamber 段抽干了、赚不回来。
改成**两条真断言**而不是一条 SKIP：钱够就验「铸出来了 + 只扣了标价」，钱不够就验
「拒绝，而且一件都没铸出来」——后者才是真会疼的那半。再顺手让「钱不够」那条谓词在
**每一轮**都跑一次（付掉 20 000 之后再买一把，周限是 2 所以只能是 `not_enough`
而不是 `sold_out`），否则那个分支是一段从来没有人跑过的代码。

## 一个洞窟为什么会拍成雪原：雾比穹顶亮

`tools/tour.mjs` 上一轮学会了量地面，六个区域全绿之后翻它自己拍的照片，冰封洞窟这一张是错的：
钟乳石垂在画面顶上，而**石笋之间露出的是天空**——一块 1.8 万像素的浅蓝，比脚下的冰还接近晴天。
一个叫「洞窟」的室内场景没有顶，是这一轮要修的东西。

第一件事是先证明「没有顶」这句话是不是真的，而不是照着截图去加几何体。`tools/vault-cam.mjs`
早就是干这个的：它把**游戏自己的相机**抬到 `camera.js` 允许的上限（-0.28 rad，玩家真的能看到的
一帧），量六条横带，并且用**藏起来**的办法确认量到的是什么——藏掉 `ceiling` 组，顶带动 18 阶；
藏掉整个高度场，顶带动 2 阶。所以**顶是存在的、而且它挡住了地形斜坡**，三个副本都是。

那画面顶上那块浅蓝是什么？是**雾**。冰封洞窟的 `fogColor` 写的是 0x6b8fa8，luma 137，
而它的 `vaultColor` 是 0x3e5064，luma 78 —— 雾比自己的穹顶亮 **1.77 倍**。这在室内是个矛盾：
一间屋子的雾就是这间屋子的表面在远处退掉，所以它**不可能**比头顶的壳亮。而 `FogExp2`
在 density 0.013 下，60 m 处已经吃掉 66 %、120 m 处 91 %，也就是说**平视方向上视线里的一切
最后都收敛到那个颜色**：量出来墙环上方那条带是 rgb [96,139,170]，和 fogColor 差 3 个阶以内。
所以顶在、墙在、钟乳石在，画面照样是「蓝天下的雪原」，因为决定远景的是雾，而雾是白天的颜色。

改的是雾，不是几何体：`fogColor` 0x6b8fa8 → **0x2c3f52**（同一个冷色相，luma 60，
是穹顶的 0.78）。落到像素上（同一段 tour，同样 pin 在 `high`，四个偏航角）：

| 冰封洞窟 | 顶带 luma | 与地面之比 |
|---|---|---|
| 改前 | 132 / 126 / 120 / 127 | 0.74 |
| 改后 | 60 / 71 / 98 / 74 | 0.35 – 0.54 |

0.46 是深渊试炼场一直以来的值——也就是说这一改不是把一个数字调好看，而是**让第三个副本落回
另外两个早就在的位置**。地面那一格没有动（16.1，因为近景 15 m 处雾只有 3 %），
`vault-cam` 的顶带从 82 落到 48，「上暗下亮」这条从 82/165 变成 48/165。

### 三个区域各自判断过的事，写成一条规则

这一条本来是三个 zone 各写各的注释、没有人对照过：**`indoor` 区域的 `sky.fogColor`
必须落在 `sky.vaultColor` 的 0.30 – 1.0 倍之间**（`shared/src/data/zoneGate.js`）。
上界是这一轮的病：亮过壳就是「墙环上面是天」。下界同样是错的一半——雾只有壳的 0.1 倍时，
远处是一片死黑，`vault-cam` 断言的那道天花线、墙环、钟乳石全部埋进去，
和这个仓库在色调曲线两头栽过的跟头是同一个形状。已有的三个区域是 0.62 / 0.73 / 0.78，
规则是从它们身上读出来的，不是发明的。顺手把 `arenaOnly` 缺的那一半补上：
`props.ceiling`／`props.enclosure` 原来只查「没有 arena 不许写」，反过来
**`indoor` 却可以没有顶**——那正是 `vault-cam` 当年为之而写的那个 bug
（`heightAt` 在 `arena.radius` 外把地面抬 44 m，一间没壳的屋子抬头看到的不是天空，
而是那条斜坡的背面，和黄昏的山坡分不清）。三条规则都用改坏的数据反向验过会报错。

### 一条 29/30 的探针，比不存在更糟

`vault-cam` 写完之后**没有进 `check-all`**，因为它有一条永久的红：
「abyssTrial: looking up finds a ceiling, not the fog colour — ceiling 16.1 vs fog 21.6」。
看照片就知道产品没错——深渊的穹顶是带肋的深紫壳，配着一圈符文拱门，一眼就是室内。
错的是那条断言的**度量**：它比 luma。深渊的顶是 [11,14,54]，雾是 [20,20,42]，蓝差 12、红差 9，
是两种不同的紫；而 luma 恰好撞在 16.1 和 21.6，只差 5.5。这个文件在 30 行之外**自己写过**
这条教训（黄金屋 [66,61,60] → [86,57,37]，两个完全不同的表面 luma 只差 0.1），却没有用在自己
这条断言上。改成**逐通道取最大位移** > 6：深渊 12、冰封 24、黄金 50，三个都过，
而「哪一个更亮」现在是 zoneGate 里的数据规则，不再由像素来猜。

于是 `vault-cam` 进了 `check-all` 的 `visual` 组（`tour` 之后），**30 条断言**：三个副本
各 10 条——在对的区域里、是 indoor、角色让开了、相机是活的（两个偏航角必须不同）、
顶带是天花几何体、天花挡住了斜坡、抬头不是雾色、天花有形状（std > 4）、上暗下亮、
画面有一条天花线（相邻带之间最大落差 > 8）。`tour` 拍的是**平视略下**的一帧，
结构上永远拍不到天花板；这 30 条是那半张画面第一次有门禁。

整套跑完：**34/34 GREEN，1807 条断言**（上一轮 33/33、1777 条），
`/tmp/check-all-20260907-112018/SUMMARY.md`；`tour` 六个区域地面中位数
14.4 / 6.8 / 11.2 / 9.0 / 16.1 / 10.8 全部在 6..34 之内，`vault-cam` 30/30。

## 把墙从外面拍了一遍：道具这一轮

到上一轮为止，像素门禁只管地面（`tour`）和天花（`vault-cam`）。中间那一层——**玩家一路上真正
贴着看的东西**：树、草、矿脉、宝箱、神像、灯笼、副本的墙——`prop-cam` 会拍，但一条断言都没有；
`npc-cam`、`enemy-cam`、`light-space` 三支明明在数断言，却压根没进 `check-all`。
所以这一轮先补齐这三支（21 + 15 + 6 条，`enemy-cam` 顺手修了一个 argv bug：它剔掉了 `--out`
却没剔掉后面那个目录名，于是把目录当成了区域 ID），再写 `tools/prop-check.mjs`。

### 想量一个 prop，先把它藏起来

矩形会漂。这个仓库里每一条手打的 rect 都漂过：`npc-cam` 的仙人 rect 漂到了她脚下的水面上，
`vault-cam` 把带子收到画面中间 60% 纯粹是为了躲 HUD。所以 `prop-check` 一张也不手打：
拍一帧 → 把这一件的 instance 矩阵全部写成零矩阵（`Group` 就 `visible = false`）→ 再拍一帧 →
两帧差超过 8 个 sRGB 阶的那些像素，就是这一件自己的剪影。这么做白送两个控制：
剪影为空说明它压根没画出来（探针的 staleness 控制也一起有了，冻帧的差集必然是空的），
而**「藏起来那一帧里同一批像素的颜色」**就是它背后的东西——同样的光、同样的位置，
于是「它和背景分不分得开」是个能减的差，不是一句形容词。

### 尺寸的承诺是它自己的包围盒

第一版拿「剪影填满自己 bounding box 的比例」判大小，草丛（1856 px、fill 0.07）和清心
（8998 px、fill 0.02）当场判红——而它们是对的：细叶子本来就只占包围盒的百分之几，亮花的
bloom 光晕还会把差集摊到盒子外面去。一个绝对像素下限分不出「很细」和「没画」，所以改成
把这一件的世界包围盒**投影到画布 client rect 上**，用两个比值判：`剪影落在盒内/剪影`
（≥ 0.35，说明变化发生在盒子承诺的地方）和 `剪影落在盒内/盒面积`（≥ 0.015，说明真有东西
填了这个承诺）。颜色和 std 也只在盒内那部分上算——bloom 光晕和「它不再投的那道影子」
都是「它消失时变了的像素」，但都不是它的材质。

### 三个副本的墙，在相机真正瞄的那一段是一片糊

第一次跑就抓到了：`abyssArch` 在 271 000 px 的剪影上 p5..p95 = **48..51**（std 3.9），
`iceCurtain` 31..37（std 4.2，rgb [24,34,50]），`goldArcade` 163..166（std 10.2）。
原因是三个配方的装饰全在**两头**：勒脚、雪垄、笋石在 4.6 m 以下，雪帽、钟乳石、檐口在 12 m
以上，而第三人称相机站在 20 m 外瞄的是 8.5 m ——正好夹在中间那一段谁都没管。
`uMottle` 救不了它：那是个乘数，三个八度平均下来可见摆幅约 `0.23×uMottle`，
在 luma 33 的面上不到一个 8 位阶。竖直面 + 头顶光 + toon 描边只画外轮廓（内部边界没有线），
剩下的手段就只有两个：**一道真的台阶**（cel ramp 会把它量化成一条硬边）和**换 albedo**。
于是 `MATS.caveWall`（`props.enclosure.wallColor`，冰封给到 0x7b8b9e）、深渊补上层的
`abyssStone` 束带层/壁柱/符文钉、黄金屋补中层的红漆堂心/贴金线脚/团花与柱础。

### 固定方位角，拍到的是环墙随便转过来的那一面

改完再跑，`iceCurtain` 4.2 → 14.3，而 `abyssArch` 和 `goldArcade` **一个数字都没动**：
std 还是 3.9 和 10.2，剪影大小差 0.3%。这种「完全没动」不是没生效，是没拍到——
`prop-check` 原本按固定的世界方位角 0.9 / 3.0 / 5.1 绕着 prop 转，而环墙的每一段朝向不同，
0.9 恰好是冰封那一段的**内侧**、深渊和黄金那两段的**外侧**。相机站在了竞技场外面，
拍的是背面那块光板，而所有装饰都在朝着场地中心的那一面。
改成**把扇形锚在出生点方向**（`atan2(spawn - prop)`，再 ±0.85），也就是玩家真正会看到的那一侧：
三面墙立刻变成 26.4 / 64.8 / 42.1，而且顺手把别的 prop 也拍正了（全套 34 个主体的 std
中位数从原来的二十几抬到 37）。教训是：一个「改了没反应」的量测，第一件要怀疑的事情
不是改动，是量测有没有指着改动。

### 门线从缺陷和好样本两头夹出来

`MIN_STD` 于是定在 **12**：缺陷那一头量到的是 3.9 / 10.2 / 14.3，好样本那一头最平的是
龙脊的 `ancientArch` 19.4，中位数 37。上界不设——分布最高的是 `iceCurtain` 64.8，
白冰打在近黑的岩面上，那一侧没有缺陷可以门禁。覆盖率那两条（31 种 prop 全拍到、
`OFF_CAMERA` 豁免表没有一条过期）只在**跑满六个区域**时判定：按名字跑子集时它必然红，
而一支「正常会红」的探针等于没有探针，所以子集跑法下这两条是 SKIP 并且说明原因。

`node tools/prop-check.mjs` 全跑：**156 条断言全绿**，31 种 prop（算宝箱四档是 34 个主体）
一个不漏，每一种四条——画出来了且在包围盒承诺的位置、和背后的东西分得开、有形状不是糊、
颜色落在 tonemap 显示得出来的范围里。

整套跑完：**38/38 GREEN，2005 条断言**（上一轮 34/34、1807 条），
`/tmp/check-all-20260907-122740/SUMMARY.md`——多出来的 4 支就是 `prop-check`（156）、
`npc-cam`（21）、`enemy-cam`（15）、`light-space`（6）。规矩记在 `check-all.mjs` 里：
**会数断言的探针，必须在名单上**。

## 会动的那一部分：四个写好了、没有人播的动作

上面每一支画面探针拍的都是**静止的世界**——`tour` 停下循环拍地面，`vault-cam` 停下循环拍穹顶，
`prop-check` 停下循环拍道具。整个游戏里唯一会动的东西，也就是角色本身的 24 个动作剪辑，
**一条像素断言都没有**。写 `tools/motion-check.mjs` 的第一件事不是拍照，是把词表走一遍，
结果是四个剪辑：`hit`、`sit`、`aim`、`climb`——`animator.js` 里有曲线，
`protocol.js` 的 `ACTION` 里有编号（会通过快照的 `a` 字节广播给别的玩家），
`autoLocomotion` 里有分支，`climb` 连键位说明都写了，而**没有任何一行代码播放它们**。

### 一个钉死成字面量的状态键，通过了每一种「接线了吗」的检查

`climb` 是四个里最深的一个。它不只有剪辑和编号，`animator.autoLocomotion` 的第一个判断就是
`if (st.climbing) return 'climb'`,而 `localPlayer` 交给动画机的状态对象里那一行是：

```js
climbing: false,          // ← 一直是这个
```

「状态里有 `climbing` 这个键吗」——有。「动画机会读它吗」——会。「读到 true 会播 climb 吗」——会。
三条都绿，而这个动作永远不会出现。所以门禁下沉了一层：不是查键在不在，而是查**它的值是不是一个
表达式**——

```js
const live = !!val && !/^(false|true|0|null|undefined)$/.test(val);
check(`localPlayer varies '${key}' rather than pinning it`, live, …);
```

七个键（`sitting`/`aiming`/`climbing`/`gliding`/`swimming`/`grounded`/`speed`）逐个过。
和「授权的键要有消费者」是同一族的错，只是这一次消费者是有的，生产者是个常量。

### 调用方扫描不能锚在 `play('name'`

第一版正则是 `\bplay\(\s*'(\w+)'`，它报告 `charged` 是孤儿——而实际上有三处在播它，
写法是 `playAction(d.action === 'charged' ? 'charged' : 'attack1')`。三元表达式让参数不在
第一个位置。改成「把整个参数表里所有带引号的名字都抠出来」：

```js
for (const call of ln.matchAll(/\b(?:play|playAction)\(([^)]*)\)/g))
  for (const m of call[1].matchAll(/'([a-zA-Z0-9]+)'/g)) used.add(m[1]);
```

宁可多认（一个名字出现在参数里但没被播的可能性远小于漏认），因为 `client/src` 里 `.play(` 只有
一个实现。同族的两处特殊调用要单独认：`attack${(combo % 5) + 1}` 这种模板串（五个连段全靠它），
和 `autoLocomotion` 的一串 `return 'walk'`。

### 攀爬：`slopeAt` 是 `1 - normal.y`，所以门线在 1 以下

实现 `climb` 的时候第一版搜索条件写成 `slopeAt > 1.4`（心里想的是「坡度 = 高差/水平距」），
探针于是报「这个区域没有可爬的面」并 SKIP——**一条永远不会执行的断言，和不存在没有区别**。
`zones.js` 里 `slopeAt = 1 - normalAt(x,z).y`，值域是 `[0,1)`：0 是平地，1 是垂直墙。
`MAX_SLOPE 0.68` 因此是 **71°**，「可爬」就是 71° 到垂直之间那一段。同一个式子还定了速度：
`sqrt(1 + grad²) = 1/ny`，所以沿面速度 `CLIMB` 折算成水平速度正好是 `CLIMB * (1 - slope)`,
不需要开根号。

攀爬**不需要新协议**。`world/actions.js:handleInput` 只把 `y` 夹在 `[gh-0.6, gh+60]`、
只拒绝超过 `MAX_SPEED*dt+1.5` 的水平位移；一次让 `y === heightAt(x,z)` 的攀爬既在夹取范围内，
水平速度又比走路慢，服务器本来就接受。松手的分支反而是有坑的那个：只清 `climbing` 标志，
人会**挂在墙上站着**——落地吸附把「站在 79° 的崖面上」当成站在地上，于是横向每一步都因为太陡被拒。
松手必须**先往下坡方向推 0.9 m** 把身子挪出崖面，重力才接得上。

### 探针自己点的那一下，同时废掉了 24 张照片

为了「让 canvas 拿到焦点」，第一版在 `(500,640)` 点了一下。那里是 HUD，点开了**地图面板**——
面板盖住世界、`input.setEnabled(false)` 关掉世界输入、一个 `gather` overlay 把 `auto` 钉在 off。
两条 sit 断言和 24 张剪影，全错在同一个原因上，而它们看起来像 24 个独立的失败。
（是打开 `/tmp/motioncheck/sit.png` 看见的，不是推出来的。）改成 blur + `ui.panels.close()`,
并且加一条「面板没盖住世界」的前置断言。更重要的是给每个剪辑加了一条
**「这团像素在相机瞄的地方」**：那次跑出来的 mask 是 500-2000 px、停在画面角落，
任何一个裸的像素下限都会让它通过。

### 剪影的包围盒要 trim，画面边缘是一个 clamp

`diffMask` 的原始包围盒把 idle 量成 843×629，而身体那一条只有 160 px 宽——几个零星的
dither 噪点就够了。`trimBox`（丢掉峰值 2% 以下的行列）之后是 160×527，`down` 的宽高比
从 1.77（差点判红）变成 1.54。

第二个 clamp 更隐蔽：相机原来架在 2.3 个身高、抬高 0.30 h 俯视 0.52 h。
六个举手过头的姿态（`climb`/`fall`/`plunge`/`aim`/`skill`/`attack2`/`attack5`）
包围盒顶边都是 **`y = 0`**——被画面上沿切掉了，于是它们的「高度」量的是视口，不是身体。
拉远到 2.8 h 一条都没修好，因为距离从来不是原因：0.30 h 的抬高在 2.8 h 的距离上是 **6° 俯角**,
而半张角只有 17°,6° 等于吃掉三分之一的头顶空间。把镜头放平（3.4 h、抬高 0.12 h，俯角 2°）
修掉了六个里的五个——最后剩下的 `climb` 是全套里最高的一个剪影：手完全举过头顶，
`1.67 h`（idle 是 1.0 h）。最后那组数字于是从这个测量里算出来，而不是再猜一次：
3.9 h 处可见纵向跨度 2.39 h（每个身高 293 px），瞄在 0.70 h 上，脚落在 ~555 px、
那只手落在 ~66 px（实测 83 和 566），两头都空着。像素数掉到 ~17k，而下限是 4000,
所有几何断言都是比值，不受影响。**现在每个剪辑都有一条「整个姿态在画面里，没有被边缘切掉」**——
这就是会抓住前两版取景的那条断言，也是唯一能把「clamp 掉的测量」和「小的测量」分开的东西。

### 新的 `climb` 事件也要有消费者，而引导的最后一步注定跑不到

`localPlayer` 抓上墙的那一刻发 `climb` 事件——为了不再制造一个「写好了、没有人读」的键，
它当场就有两个消费者：靴子蹭岩壁的音效，和新手引导的最后一步 `climb`。事件发在**真正进入攀爬
的那个分支**上，不发在按键上，所以顶着一面其实走得上去的坡按 W 既不出声也不算完成
（和整份引导的规矩一致：一步是由做成了那件事的代码标记的）。

这一改让 `tutorial-check` 红了三条：它原来的收尾是「按 M 打开地图 → 引导完成」,
而 `climb` 现在是最后一步，蒙德出生点 70 m 内没有一面爬得上去的墙。修法不是把新步骤挪到前面
（那会让第一次进游戏的人卡在一步做不到的事上），而是给探针加一张 `OFF_PATH` 表——
**豁免必须带义务**：一步如果在这里跑不了，就得写清楚是哪一支探针在跑它，
而那个文件必须存在、必须提到这个 id，然后这一条记 SKIP 而不是偷偷标记完成。
表里没登记却还没完成的步骤，一律判红——那正是新玩家会撞上的「引导永远走不完」。

### 判定：形状要不一样，方向也要对

24 个姿态用同一张「把角色藏起来」的底片作差（循环停了、相机固定，所以世界完全一致，
25 次渲染而不是 48 次；那张底片拍了两遍，互相差 0 px，同时充当「画面没卡住」的对照）。
两两 IoU 比一遍（276 对）保证没有两个剪辑拍成同一个姿势，每个和 idle 比一遍保证它真的动了。
但「和 idle 不一样」对一个错的姿态同样成立，所以四个死掉的剪辑各自还有方向性的断言：
坐姿的头要明显低于站姿且身子矮下去、倒地要**宽大于高**且头比坐姿更低、
瞄准要比站姿宽出去（弓臂伸开、拉弦手后引）而且仍然是站着、
攀爬要伸到站姿头顶之上且**宽高比比走路更瘦**（贴在岩壁上，不像走路那样甩手甩腿）。

### 验证

`node tools/motion-check.mjs`：**149 条断言全绿**（24 个剪辑 × 3 条剪影断言 + 23 条和 idle 比 +
276 对互比 + 8 条方向性几何 + 输入链 12 条 + 攀爬 12 条 + 词表 20 条）。
攀爬那一段是在真的岩壁上跑的——
蒙德全区扫出 1520 个可爬格子而出生点 70 m 内**一个都没有**（最陡的 0.807 在 (-130,198)），
所以探针用 `enterZone(zoneId, {x,z})` 走过去（客户端直接改坐标会被服务器纠回来），
对准坡面按住 W：`y 63.19 → 64.89`、`base climb`、快照 `action 16`、体力 240 → 231,
松开 W 挂住不掉、体力归零松手、松手之后**离开崖面继续掉高度**（`grounded false`、`action 5`）、
攀爬中攻击和战技都被拒。

`tutorial-check` 加上 `OFF_PATH` 之后 **79 条绿、1 条 SKIP**（就是 `climb` 那条，
写着它由谁跑）；`solo-check` 21 条、`death-check` 107 条仍然全绿；
`data,http` 两组 11/11 GREEN、663 条（新的 `climb` 动作字节走 `api-check`/`mp-check` 的线上编解码）。
`motion-check` 已经进 `check-all.mjs` 的 `visual` 组（`needs: 'browser'`,
因为它自己领 guest token，缺的是显示和页面）。

## 会自己动的那一样东西：昼夜这一轮

`gfx/sky.js` 从写下来那天起就有两个 uniform：`uStars` 和 `uNight`。
六个区域的 `sky` 块里**没有任何一个写过这两个键**——不是写错了，是根本没有生产者。
缺的东西不是数据，是一个世界时钟。这一轮把它补上：
一天 24 现实分钟（1 现实秒 = 1 游戏分钟），太阳真的从东边升起、从西边落下，
`shared/src/world/daylight.js` 是唯一的真源。

### 时钟是推导出来的，所以不用同步

`worldClock(Date.now())` 是纯函数：epoch ms 进，`dayT` 出。
没有任何一个字节走网络，所有客户端天然一致，单机和联机是同一条式子。
时间不存库、不广播、不会漂——服务器根本不知道现在几点，因为不需要知道。

### 中午必须和手调的天空一模一样，不是「差不多」

这一轮最大的风险不是太阳画得好不好，是**约 500 条已经校准过的像素断言**
（`tour`/`vault-cam`/`prop-check`/`npc-cam`/`enemy-cam`/`light-space`/`motion-check`）
全都站在每个区域手调的那个 `sky` 块上。太阳一动，那些门线的地基就没了。

所以 `daylight()` 是**照着这个约束构造**的：12:00 时 `day === 1`、`night === 0`、
`golden === 0`、`stars === 0`，每一对系数都精确相加为 1（`0.055+0.945`、`0.10+0.90`、
`0.30+0.70`，在 float64 里 `=== 1`）。
`daylight-check` 对六个区域逐个用 `===` 比 14 个返回项：中午返回的就是作者写下的那一份。
配套的另一半是：**17 个像素探针全部显式 `setWorldTime(12)`**，
而探针自己扫一遍 `tools/*.mjs`，谁量像素又不钉小时就红（豁免表里三个是把 canvas 藏了量 HUD 的，
探针还会验证它们真的藏了，以及豁免表里没有过期条目）。

### `lightDir` 不是 `sunDir`：夜里得从月亮那边照

穹顶要把太阳的圆盘画在太阳真正在的方向，但 `DirectionalLight` 和地形着色器不能——
太阳落到地平线下之后，`sunDir` 指向地底，整个地面从下面被照，法线全反。
所以返回两个方向：`sunDir` 给穹顶，`lightDir = sinElev >= 0 ? sunDir : -sunDir` 给光和地形。
夜里的光源就是月亮的方向，而 `daylight-check` 扫一整天断言 `lightDir[1] >= 0` 一次都没破。

### 地面不走 `DirectionalLight`，所以调光要另给一份颜色

`gfx/terrain.js` 的直接光整项就是 `uSunColor`，**它从来不乘 `sunIntensity`**。
只调 `sunIntensity` 的话，天暗了、光暗了、草地一点没变。
所以另外返回一个已经预乘过的 `groundSunColor`，地形专用。
门禁上量得到：地形自己的太阳色 noon `#fff2d8` → 黄昏 `#723f26` → 夜 `#0b0d16`。

### `night` 在日出的时候还有 0.6，所以它不能拿来驱动月色和星星

第一版把 MOON 蓝按 `night` 混、星星也按 `night` 出。
结果 06:00 是一个**橙色的日出天空上盖着满天星、光偏蓝**——
因为太阳正好在地平线上时 `night` 还是 0.6。
`day` 的过渡区从 `smooth(-0.08, …)` 拉宽到 `smooth(-0.22, 0.30, sinElev)`，
另外拆出一个**只在地平线以下才起来**的 `dark`（`smooth(-0.02, -0.20, sinElev)`）驱动月色，
星星用自己的 `smooth(-0.03, -0.26, sinElev)`。
`timeOfDayName` 同一个病：`night >= 0.6` 排在前面，日出被叫成「夜晚」。
现在 `golden` 先判（黎明/黄昏），而「正午」是**时钟事实**（11:00-13:00）而不是光的事实——
`day` 在整个下午都是压平的 1，用它判会把 16:00 也叫成正午。

### 一个内部驱动量不该是返回值

`daylight-check` 里有一条双向门：返回的每一个键都要在
`sky.js`/`terrain.js`/`world.js`/`game.js`/`hud.js` 里找得到读它的人，
反过来读到的每一个键也必须真的被返回。
它当场抓到两个：`dark` 被我顺手返回了（没有消费者，删掉，留在函数内部），
`dayT` 是调用方自己传进来的、没人读回去（删掉）；
`elevation` 留下来了，因为给了它一个真的读者——HUD 的 tooltip「太阳高度 +53°」。

### `uNight` 之前只让云薄了 45%，藏起来动 0 个像素

「藏起嫌疑犯」这一招在 `uStars` 上一次就过了（午夜置零动 317 px，中午 0 px），
`uNight` 却动了 **0 个像素**——它当时唯一的作用是把云的透明度压 45%，而午夜本来就没什么云。
夜空里少的是**月亮本身**：`daylight()` 早就把 `-sunDir` 交给了光，却从来没有人在那个方向画东西。
`SKY_FRAG` 里补一段月盘 + 光晕（`acos(dot(d, -L))`、盘 0.030-0.038 rad、`exp(-mAng*9)*0.16` 的晕），
现在午夜置零 `uNight` 动 **4610 px**，中午仍然是 0 px。

### 头顶高度看不到地平线，一条声称「天空」的断言量的是山坡

「黄昏应该是橙的，而橙色长在太阳旁边」——`golden` 把 horizon 色拉向 GOLD 55%，
zenith 只拉 18%，所以断言必须瞄着太阳自己的方位角量。
第一版在人眼高度往上抬 6° 取一条带，量到 `rgb(121,133,89)`：那是蒙德环谷的山脊，
它比 10° 还高。**教训不是「换个位置」，是那条自校验断言救了整段**——
「这条带在中午必须是天空（蓝 > 绿 > 红）」先红，才没有让三条色相断言拿着草地的读数变绿。
把相机抬到山脊之上（`me.y + 90`、水平看）之后：中午 `r/b 0.95`、
黄昏 `1.65`、黎明 `1.40`，同一小时背对太阳的 zenith 是 `0.72`。

### 一个 boot 会恢复上次存档的区域

有一整轮 133 绿 / 11 红，全部是「必须变」的红、「必须不变」的绿。
原因是这个探针**自己最后一段**把共享的 guest token 留在了深渊试炼场，
下一次 boot 就在地下——那里 `applyDaylight` 直接 return，天色当然不动。
修法两条：显式 `enterZone('mondstadt', …)` 并断言 `boot.zone === 'mondstadt' && boot.indoor === false`，
以及把洞窟那一对放在地表那一对**之前**跑，让 token 留在地面上。

### Xvfb 下一个 CSS transition 读到的是「正在离开」的那个值

HUD 的日晷小圆点连着两次读到上一个时刻的颜色。
`.wc-dial` 上有 420 ms 的 `transition`，而 Firefox 在 Xvfb 里只在**绘制时**推进它。
这个改在产品里而不是探针里：小圆点的颜色去掉 transition（CSS 里写着原因）。
月牙也不能靠 inline style——它是 `::after` 的 inset shadow，
否则 `sunColor` 的 inline glow 会把它盖掉。

### 室内三个区域拿不到天色，所以一半的画面门禁结构上免疫

`World.applyDaylight` 对 `indoor` 区域直接 return。
`daylight-check` 两头都量：地表中午 vs 午夜 **699181 px 不同**，
深渊试炼场同样两个小时 **0 px 不同**（共 700000 px）。

### 一个存下来的方向不是一个光源的位置

`daylight-check` 单独跑是全绿的，进 `check-all` 之后红了一条：
「午夜是大变化，不是微调」——`Δground` 单独跑 52.8，套件里 24.8。
两张 PNG 的相机一模一样、几何一模一样，**光照不一样**：
一次近景草地是晒着的（右侧带子 lum 106），一次整片在阴影里（68）。

原因在 `gfx/sky.js`：`applyDaylight` 写的是 `this.lightDir`，
而真正照亮世界、并且决定 shadow map 中心的是 `DirectionalLight` 的**位置**，
它当时只由 `update()` 写。循环在跑的时候这只差一帧，看不出来；
但**每一个像素探针都会 `g.stop()`**（设置里「固定时间」也一样），
于是太阳留在上一个小时把它放的地方——两次跑停在不同的帧上，就拍出两种光。

修在产品里：抽出 `_placeSun(fx,fy,fz)`，`applyDaylight` 末尾用当前 target 位置立刻调用它，
`update()` 也走同一条。门禁跟着补上——每个小时都断言
`dot(normalize(sun.position - sun.target.position), lightDir) > 0.9999`，
**在循环已经停掉的状态下**测。修完地面的读数才是对的：
中午 127.5、黄昏 50.9、午夜 26.1（Δ101，之前那个 24.8/52.8 的抖动是同一个 bug 的两次采样），
中午的草地 127.5 也终于和 `tour` 拿蒙德草地量到的 132 对得上了。

### 验证

`node tools/daylight-check.mjs`：**154 条断言全绿**。
Node 半边（112 条）：时钟与解析、六个区域的中午恒等（`===`，14 项）、
每区 96 步扫一整天（范围、`night === 1 - day`、太阳严格在 06:00-18:00 之间升起且两端 elevation 恰为 0、
`lightDir[1] >= 0`、单位长度、星星只在日落后、`golden` 两端开中午关、
没有任何颜色通道低于 0.005、上午单调、中午最亮、noon > 黄昏 > midnight、黄昏比中午暖）、
`timeOfDayName` 词表双向、返回值读者双向门、像素探针钉小时扫描。
浏览器半边：五个小时逐个断言光源真的站在那个小时该站的位置（循环已停）、
中午先自校验 sky/ground 两个矩形（不然后面的色相断言可能量在草上）、
五个小时的排序与不压黑、地形 uniform、两个夜间 uniform 的藏起来证明、
瞄着太阳方位角的暖色断言、HUD 时钟的六条读数（含 tooltip 里会动的太阳高度）、
室内外双向对照。
`daylight-check` 已进 `check-all.mjs` 的 `visual` 组（`needs: 'browser'`），全套现在 40 个探针。

## 会自己动的第二样东西：天气这一轮

`zone.weather` 从 zones.js 写下来那天起就是个常量：蒙德永远晴、龙脊雪山永远下雪、
三个副本 `type: 'none'`。它带出的第一个缺陷不在画面里，而在音频里——
`client/src/audio/audio.js` 用 `this.zone?.weather === 'blizzard'` 选风声滤波，
而 `zone.weather` 是个对象 `{ type, windSpeed, cloudiness }`。
**一个字符串和一个对象比较**，两个分支都到不了，所以那条又冷又薄的风从来没在任何地方响过。
没有报错、没有缺文件、没有 undefined——和「四个动作没有人播」是同一个形状的洞，只是更安静。

这一轮补的是 `shared/src/world/weather.js`：和 `daylight.js` 同一个骨架，
因为这是同一个问题。

### 第 0 天必须是手写的那个区域，而且是一整天

全套里有约 500 条标定过的像素断言站在每个区域手调的 `weather` / `sky` 块上，
而每一个像素探针都钉了小时——**钉小时就是第 0 天**（`setWorldTime` 只用 `dayT` 造 epoch）。
所以 `weatherAt` 对第 0 天必须逐项 `===` 返回手写的那些数，
不是中午一个点，是一整天 1440 个采样点都不许漂。
`weather-check` 把这条写成了两个断言：node 半边六个区域逐项 `===`；
浏览器半边把第 0 天 15:00 和「晴朗」那个预报日 15:00 拍成两张图，
**差 0 个像素**——不是接近，是同一张。

### 作者只写两个数

一段预报是 `{ at: 小时, type, strength }`。
云量、风速、雾、严寒都从 type 的预设**朝这个区域自己的基线插值**推出来，
所以蒙德的雨还是蒙德的雨（绿、雾薄），不会每个区域下起同一场明信片式的暴雨。
`strength` 缺省即 1，没有 `type` 表示「回到这个区域的正常」——
而那必须是**逐位**的基线，不是 strength=1 朝预设插值：龙脊雪山手写云量 0.72、
雪的预设是 0.88，一个「回归正常」每次都云 0.16 就会一天天漂上去。

### 一场雨的类型要跟着「有没有东西在落」，两个方向都要

交叉淡入的时候画面该画哪种降水？先写的是「进来的那个如果会下就用它，否则用出去的那个」——
一场阵雨结束的瞬间不会突然变成 `clear` 把最后 30 秒的雨滴从空中删掉。
`weather-check` 抓到的是镜像的另一半：蒙德「晨雨」那天 00:00 整，
进来的段是 rain 但强度恰好是 0，于是 HUD 在一片干草地上写着「零星细雨」。
现在的规则一句话就够：**取交叉淡入里和「有没有东西在落」一致的那一侧**。

### 一个 HUD 会打印的数，必须在它被打印的那个区域里有意义

`coldMul` 原本对任何区域都算：蒙德一场 0.9 的暴雨得到 ×1.09，
tooltip 于是在一个**根本没有严寒**的山谷里写「严寒加剧 ×1.09」。
现在 `coldMul` 在没有 `mechanic.sheerCold` 的区域恒等于 1，
消费它的 `zoneInstance.js` 和打印它的 HUD 于是说同一件事。
门线两头都钉：龙脊雪山暴风雪必须 > ×1.2，蒙德暴雨必须 === ×1，
而且最坏的暴风雪冻满 100 要 73 秒、篝火回温 8.0/s 是它的 5.8 倍——
天气跑得比它自己的解法还快就不是难度，是墙。

### 云量涨了三倍，天空只动了 2.3 个亮度

`uCloudiness` 从 0.35 涨到 0.881，蒙德下午的天空从 rgb(188,205,221) 变成 (191,207,222)。
覆盖率确实涨了，但 `cloudLit` 几乎是白的，而 15:00 的晴空本来就有 lum 202——
**一片几乎全白的云盖在一片本来就很亮的天上不是暴风雨**。
新加的 `uStorm` 是「这个区域的云量被推过它自己基线多远」，
所以它在第 0 天恰好是 0——这是一个被 500 条标定断言压着的 shader 还能长出新项的唯一办法。
第一版把 dome 乘 0.80，只换来 6.4 个亮度：0.80 是**线性 HDR** 上的 0.80，
ACES 把肩部压完之后在 sRGB 字节上只剩 3%，和这个仓库里每一个显示算子缺陷同一个坑。
现在三件事一起做：把云盖压实（alpha）、把云自己的颜色拉向阴面灰、再把 dome 调暗，
从 150 m 高、抬 8° 量到的 dome 亮度 208.7 → 187.3。
另一头也钉了：阴天是灰的不是夜里（lum > 60、不许有通道压到 0）。

### 雨不是白纸片：一个 300 px 的近场 sprite

第一张暴雨截图是一片草地后面五十个**白色长方形**。
两个原因：`gl_PointSize = uSize * 300 / 距离`，所以离相机两米的雨滴画了 300 px 宽；
加上 additive 白色打在一片明亮的阴天上，每一片都过曝。
修法分两边——雨给 15 px 的天花板和 NormalBlending，
雪**一个字都不改**（`maxPx: 0`、additive 照旧）：
龙脊雪山的雪是 90 多条标定断言量过的那个样子，而雨从来没有出现在任何一张标定过的画面里，
所以它是唯一可以自由改的那一个。
还有一处形状错误：原本 `c.y *= 0.22` 把圆盘在 y 上**拉满**了整个 sprite 的高度、
宽度一点没变，得到的是一块圆角板砖。雨丝是窄的：`c.x *= 5.0`、`c.y *= 0.62`，
而两个系数在 `uStreak = 0`（雪）时都恰好是 1.0。
门线是一对：矩形边缘的量（草地矩形的 p95 从 142 只到 127，不许 +40 的过曝）
＋「藏起来证明它在」的 66629 个像素。

### 一场暴风雨要把它落下的那个世界一起调暗

`sky.stormDim`（= 1 - 0.35 × uStorm）由 `World` 分发给两个必须一致的地方：
照亮道具和角色的 `DirectionalLight`，和地形——地形的光照项是它自己的 `uSunColor` uniform，
**不走 DirectionalLight**，只调 `sun.intensity` 的话草地会留在正午亮度上。
而且这个系数是在 `applyDaylight` 里乘的，不是在 `applyWeather` 里：
强度每次都从 `ph` 重算，一场暴风雨来一百次也不会把系数累乘成黑夜。
蒙德那场雨：sun 2.5 → 1.785，地形 uSunColor #fff2d8 → #dcd0ba。

### 一个 buffer 变成两种暴风雨

`Weather` 的粒子 buffer 在建区域时分配一次，之后**不能长**。
所以分配按 `maxStorm(zone)`——预报能到的最重的那场，不是今天的天气：
蒙德基线是 `clear`，没有这条它的雨天就无处可画。
雨和雪的差别全在 uniform 上（速度、大小、颜色、拉丝、风、透明度、天花板、混合模式），
所以同一块显存可以**变成**任何一种；龙脊雪山的暴风雪 6400 点、雪 4000 点，
`setDrawRange` 一条线同时承担画质档和暴风雨强度两个杠杆。
`weather-check` 反过来也钉了：扫 12 天里出现过的每一种类型，
它的 `STORM_RANK` 都不许超过 `maxStorm` 分配的那一档。

### 验证

`node tools/weather-check.mjs`：**129 条断言全绿**。
（其中一条原来写成「蒙德开机就是晴天，所以画的粒子数必须是 0」——开机落在哪个预报日取决于时钟，
这条在 `check-all` 里遇到 `午后骤雨` 那天就红了，报的 `drawing 2101` 正是系统在正常工作。
现在先钉一个干日子、并且断言它真的干（`type === 'clear' && intensity === 0`），再读粒子数；
湿的那半边在下面的 A/B 里（`3600/4000`）。这就是「矩形要自证主体」那条教训的时间版本。）
Node 半边（82 条）：词表六项自洽 + 暴风雪在四个维度上都是最坏的、
HUD 三档措辞互不相同、词表与预报双向（没有不存在的类型，也没有到不了的预设）、
六个区域第 0 天一整天逐项 `===`、同一 epoch 幂等、四天一循环、
每区 12 天 × 每游戏分钟一步（范围、Δ强度 ≤ 0.036 即不许跳、跨日缝合、
雾不出基线的 1..2.5 倍、类型与强度互相自证、分配够画）、
三个室内区域每天每小时都是 `none`、严寒两头夹 + 篝火必须赢、返回值读者双向门（9 个键）。
浏览器半边（47 条）：第 0 天 vs 晴朗预报日 **0 像素**、
同一小时雨天/晴天 A/B（粒子数、云量、风、雾、类型、措辞）、
从 150 m 抬 8° 量 dome 的变暗 + 自校验矩形 + 不压黑、
雨丝的天花板与混合模式（雪那边反向钉住不许变）、
把雨藏起来对着一个测出来的噪声底（两张相同帧差 0 px，抽掉雨差 66629 px）、
HUD 天气 chip 的文字/隐藏/tooltip/强度透明度/上色、
龙脊雪山基线雪 vs 整日暴风雪（同一块 buffer、风 1.4 → 9、严寒 ×1 → ×1.225、tooltip 警告）、
室内外双向对照（洞里 0 px、地面 79516 px）、chip 跨区域切换不发霉。
`weather-check` 已进 `check-all.mjs` 的 `visual` 组，全套现在 41 个探针。

## 鼠标：主操作方式比副操作方式弱

`支持鼠标点击` 是目标里点名的一条，`client/src/game/input.js` 从第一天就把一次按下按「拖动 /
长按 / 单击」分类，`game.js:_leftClick` 再按射线打到什么把单击翻译成不同的命令。**这一整套
之前没有任何门禁**：拿 `mouse.down`/`mouse.click` 扫 41 个探针，只有 4 处调用，全都是点一个
DOM 按钮。于是 `tools/mouse-check.mjs` 把这套手势按玩家的用法真的驱动一遍。

### 操作说明里的一行，是一句需要被驱动的承诺

`MOUSE_CONTROLS` 是设置面板印给玩家的表，所以它是这套方案唯一的规格书。探针用一张
`GESTURES` 表跟它**双向**对：表里多一行没人驱动会红，探针驱动了一个表里没写的手势也会红。
第一次跑，第一行就红了——它写着「双击是跑过去」，而单击本来就是跑过去（`wish` 到 1、
上限就是 `RUN`），**这行承诺了一个不存在的区别**。

### 鼠标根本没有冲刺

键盘玩家按住 Shift 冲刺；鼠标玩家点多远都只有 RUN。补法不是给鼠标写第二套移动规则，而是
把冲刺变成**命令上的一个标记**：`setGoal(..., { sprint })` 存进 `LocalPlayer.goalSprint`，
然后全局只留一个「什么叫在冲刺」：

```js
const sprintHeld = input.isDown('sprint') || (this.goalSprint && !!this.goal);
```

速度上限、体力消耗、体力见底的锁、regen 的阻塞、以及广播给别人的姿态全读这一个量，所以
键鼠两条路不可能漂。体力耗尽时 `goalSprint` 自己解除（否则 RUN > RUN×0.9 会把 `regenBlocked`
永久钉住，一次双击就再也回不了体力）。探针量的是结果：单击峰值 5.20 m/s、体力 Δ0，双击
8.20 m/s、体力 Δ17、姿态里出现 `ACTION.sprint`、并且给队友掉了一个标记；单击那半边反向钉住
（0 个标记、姿态里没有 sprint）。

### 点在宝箱身上，落点是宝箱后面的地

`_leftClick` 原来只有「地面射线 → 找地面点附近的可交互物」。可交互物是逻辑点，prop 是合并
实例，所以点 NPC 的胸口、点长在土坡上的采集点，地面命中点会落在它身后或者身前好几米：探针
量到一次**离它自己点中的采集点 8.9 m**，然后角色从旁边走过去了。补的是 `world.pickInteractable`
——球对射线的最近距离测试，和 `actors.pickEnemy` 同一个形状——插在敌人、倒地队友之后，地面
射线之前。现在 `_leftClick` 有五个分支（敌人 → 倒地队友 → 光标下的东西 → 点中地面旁边的东西
→ 空地），探针按源码里的出现顺序钉住这个顺序，并且要求五个分支各给一个 clickRing、只有空地
那一支 ping 队友。

### 一个屏幕百分比不是一个世界断言

探针第一版点「画面 62% / 70%」那个像素。跟随相机是俯视的，画面下半是角色自己的脚，那一下
的命令落在 **1.4 m** 外，一帧就到了——于是「没走动」「峰值 0.00 m/s」「双击不冲刺」一连五条
假红。落点必须**从世界经同一个相机推回来**（`groundPoint`：沿 `rig.basis()` 前方 14 m、
用 `heightAt` 取地面、`project` 回屏幕），而且：

- 每一次点击前重新推一遍。相机会跟着走位转，敌人会朝你走；一个瞄点只在它被算出来的那一帧有效。
- 左右两侧那条规则要各自量自己那一下。两边都对着**最终**的相机基向量量，得到 +2.3 和 +7.7（同侧），
  把一条产品守住了的规则判成红的。
- 相机自己的取景也是瞄准的一部分。滚轮那一节把镜头留在缩放极限上，一个 4 m 外的丘丘人投影到
  画面上方 188 px（`MoveTargetOutOfBounds` 直接把整轮打断）。生怪之前先把 `pitch/dist` 放回
  默认值，瞄不到就横向扫一圈，实在瞄不到就按名字 SKIP，坐标一律 clamp 进视口。

### 分类器读墙上的钟，蓄力表读帧

`input.js` 的单击/长按判定用 `performance.now()`，所以「按住多久」得真的 sleep；`game.js`
的蓄力是 `_leftHold += dt`，`dt` 被 clamp 在 50 ms，所以「蓄多久」得数**渲染帧**——llvmpipe
这台机器 3 fps，600 ms 的墙上时间只蓄 100 ms，重击永远放不出来。`doublePress` 第一版在两次
按下之间等了 2 帧（≈600 ms），越过 `DBL_MS` 280 ms 的窗口，于是「双击不 ping」；两次按下现在
背靠背驱动，帧等待全放到最后。

### 探针自己的前提也要断言

同一轮里有四个「绿了但什么也没证明」的隐患，全部按名字钉住：

- `g.panels?.isOpen` 永远是 `undefined`（面板管理器在 `window.ui.panels`），可选链让一次
  什么都没做的重置看起来像一个干净的世界。现在先断言 `window.ui.panels` 存在。
- 采集完留着的面板会让第一次 KeyB **关掉它**而不是打开背包，于是「关掉之后世界收不回点击」
  假红。开门禁之前先断言世界没暂停、没有面板。
- `currentAction()` 返回的是协议里的枚举，不是剪辑名。跟 `'sprint'` 比字符串会红，而姿态本来
  是对的；现在从 `shared/src/protocol.js` import `ACTION` 来比。
- 目标死了之后「锁定自己解除」在一个从来没锁上的构建里也是绿的。锁没成的时候这条 SKIP。
- 420 点血在 3 fps 上要打 93 秒。35 秒的预算把「持续攻击」判成了坏的。而且这条预算本身就是错
  的方向：同一只丘丘人在 llvmpipe 上可能 7 秒死、也可能 119 秒才掉 108 点血，一次 `420 → 312`
  把「死亡时解锁」判成坏的，还让下一节跟着红——活下来的那只一直在追人，之后每一次点击都走了
  分支 1（有 target、没有命令）。要测的是「一次点击会一直打到目标倒下」，用产品自己的
  `hpMul`（深境异常用的那个旋钮）把血量降到 63 点，这句话读起来完全一样，而且有界。
  一节里造出来的怪，出节之前要用 `onEnemyKilled` 收掉——直接 `enemies.delete` 会留下一个
  客户端幽灵，`actors.pickEnemy` 照样打得到。
- 「一次点击持续挥」不能用轮询到的掉血次数来数：700 ms 的轮询比出手还慢，63 点血 4 秒打完只
  看到两级台阶。数 `me.on('swing')`。
- **点击点还得是「面板盖上去之后无害」的点。** 面板表头的页签就是面板导航（在背包里想看角色
  面板不该先关掉），scrim 上的 `mousedown` 是点外部关闭——两次假红都出在这：点到页签，后面
  那次 KeyB 就变成重新打开背包；点到 scrim，面板当场就关了。现在候选点要求
  `closest('.panel')` 且不是 `.tab`/`.close`，另外补一条「被吞掉的那次点击没有偷偷换面板」。
- **想测哪个分支，就得把别的分支排除掉**，而且要用产品自己的拾取器沿同一条射线问：只按
  `nearestInteractable` 过滤，仍然可能有个采集点正好在光标下（分支 3），当场交互、不下任何命令，
  于是「关掉面板之后世界又收到点击了」第二次假红。现在候选点要同时让
  `pickEnemy` / `pickPlayer` / `pickInteractable` / `nearestInteractable` 全部答「没有」。

### 验证

`DISPLAY=:99 node tools/mouse-check.mjs`：**85 条断言全绿、0 SKIP**。
Node 半边（20 条）：手势表双向、三个分类常数从源码里解析出来并且落在人手的范围里、
单击在 release 上决定、拖过/按久了不算单击、只有右键中键会转镜头、
wheel 是 `{ passive: false }` 且 preventDefault、失焦清空按键、
`setEnabled(false)` 连排队的点击一起丢、`setPaused → input.setEnabled` 有名字叫得出的调用方、
五个分支的顺序与五个 clickRing、只有空地那一支 `socket.mark`、
「冲刺」只有一个定义且键鼠共用、`clearGoal` 会把 `goalSprint` 一起清掉。
浏览器半边（65 条）：点地面走过去（命令投影回光标 1 px、离瞄点 0.0 m、ring 落在点击处）、
左右两侧、双击冲刺 + 标记 + 姿态（单击那半边全部反向钉住）、按住蓄力（charging 0.36→0.76、
放手是 charged）、左拖不转镜头/右拖中拖都转/拖动不算点击、右键单击停下并解锁、
滚轮进出与两端 clamp（1.90..13.50 m）、点敌人锁定 + 靠近 + 一次点击打死它 + 死后自动解锁、
点采集点身上给的是 interact 命令（离物体 0.00 m）并且真的走过去采到（`done true`）、
背包开着吞掉世界点击（0 ring）而关掉之后立刻收回、点头像换人（选的是产品自己认的
「非当前且活着」的槽）、点技能图标进 CD、全程 0 页面错误 0 HMR。
`mouse-check` 已进 `check-all.mjs` 的 `browser` 组，全套现在 42 个探针。

## 「今天的样子」不是前提

连着三次整套 `check-all`（42 个探针、2400+ 条断言）分别有 2 / 2 / 1 条红，五条全部不是产品的问题，
而是同一个错误：探针把**今天的样子**当成了规则。这五条比它们旁边的真 bug 都贵，
每条都要单独一轮 triage，而且都是写下来那天必绿、几周后才红。

| 红的那条 | 它其实依赖 | 改法 |
| --- | --- | --- |
| `weather-check`「蒙德开机是晴天」 | 开机落在哪个预报日（时钟） | 先钉一个干日子，并断言它真的干；湿的那半边另算 |
| `mail-check`「附件正是轮换给的东西」 | 当天奖励有没有过一千（`dom.js:num` 会加千分位） | 按数字比，不按面板印出来的字符串比 |
| `mouse-check`「一次点击打到目标倒下」 | 当次 llvmpipe 的帧率（7 秒 vs 119 秒掉 108 点血） | 用产品自己的 `hpMul` 把活儿变小，而不是把 deadline 拉长 |
| `questnav-check`「目标已完成」 | 服务器往返有没有在 1.6 秒内回来 | 轮询，别读一次 |
| `food-check`「高阶菜谱锁着、低阶的没锁」 | 探针账号的冒险等级（只会往上走，最高的菜谱是 5 阶） | 把等级构造出来（钉 AR 3 再读一遍面板），用完放回去 |

规矩：一条断言只要依赖日期、帧率或者格式化过的字符串，就要么**把那个状态钉住并断言钉住了**，
要么**用产品渲染它的同一个函数推出期望值**；长活儿用产品的旋钮限界，凡是要服务器确认的都轮询。
另外「一节里造出来的东西，出节之前要收掉」：那只没打死的丘丘人一直追着人，
之后每一次点击都走了分支 1（有 target、没有命令），把下一节也带红了——
收的时候要走产品的死亡路径（`onEnemyKilled`），直接 `enemies.delete` 会留下一个
客户端幽灵，`actors.pickEnemy` 照样打得到。

### 验证

第四次整套跑成了这份一直缺的证据：**`42/42 GREEN · 2527 条断言 · 0 not green`**
（`/tmp/check-all-20260907-211115/SUMMARY.md`，含 `art-*/` 每支探针的截图）。
前三次分别是 40/42、40/42、41/42，红的都在上面那张表里，五条改的都是探针，产品一行没动。

## 地板上的花纹：强度不是「看得见」的旋钮

`vault-cam.mjs` 把相机抬到上夹角去证明副本有顶；这一轮做的是同一句话的另一半——
把相机压到下夹角（pitch 1.0、吊臂 13.5 m，都是 `camera.js` 自己的夹值，玩家滚一下滚轮就能得到
这一帧）去看**地板**。要看的是一个从来没有人拍过的数字：`terrain.inlayStrength`。
地面着色器在竞技场里按 `inlayColor` 混进两道环（0.24R / 0.52R）、八根辐条和一枚中心徽章，
全部由这一个 uniform 缩放；而三个厅里只有黄金屋的 0.72 被手工量过一次，
另外两个厅共用默认 0.45，`grep -n inlay tools/*.mjs` 在这一轮之前只匹配到一条注释。

### 被测对象自己指出来：把它关掉

`tools/inlay-cam.mjs` 不写死矩形。同一机位拍六张：两张原样（互相之差就是**噪声底**）、
一张 `uInlayMix = 0`、一张 `= 1`、一张放回原值。**关掉之后动了的像素就是花纹**，
有多大就是多大，一个像素都没动就说明它从来没画出来（`tools/lib/png.mjs#diffMask`）。
噪声底不是形式：深渊试炼场两张连续帧之间自己就动 39k–51k 个像素（火盆闪、水晶亮、浮尘），
是关掉花纹所动像素的一半，所以每一处计数都先把「本来就要动的那些」减掉。

### 找到的东西：两个厅在用自己的地板色画花纹

| 区域 | 镶嵌色 | 地板 albedo | 花纹与旁边石头的最大通道差 |
| --- | --- | --- | --- |
| 深渊试炼场（改前） | `0x7a68c8` | `0x807ca8` | **15**（紫画在紫上） |
| 冰封洞窟（改前） | `0x8ec0da` (142,192,218) | `0x9cc0d4` (156,192,212) | **23**，而且整幅只有 9998 px 动过，大半是抖动 |
| 黄金屋 | `0x40796a` | `0xc98f3f` | 46（玉画在金上，能看见的那一个） |

两个厅的注释都在讨论**bloom 和强度**——「`0x7a68c8` 是亮紫，混得更狠会把辐条推进 bloom 门槛」、
「`0x8ec0da` 是亮冰，同深渊那套说法」——但可见性根本不由强度决定，
而由**镶嵌色离地板自己的 albedo 有多远**决定：冰封洞窟那两个颜色只有一个通道差 14 阶，
任何强度都救不回来（`mix(floorCol, inlayColor*dress, k)` 在两个颜色相同时对任何 k 都是恒等式）。
这和「写好了、没有人读」是同一类错误的颜色版：数据里有花纹、屏幕上没有。

改法按每个厅自己的余量走反方向：

- **深渊试炼场 `0xa8dcf0`**——地脉光纹。淡青是这间屋子唯一还没占用的色相（石头紫、穹顶辉光紫、
  火盆暖），也正是从同一块地板里长出来的水晶色。量出来 15 → **47**，亮度 1.52×，p95 148，
  离 bloom 还很远，而石头的缝、脉、磨损全部照旧穿过花纹（mask 内 std 20.4 vs 关掉时 14.2）。
- **冰封洞窟 `0x2f6f96`**——冰里的融水沟。冰地板往亮走没有余量（再亮就是白），
  所以对比只能往暗走：比区域自己的 `deepIce` 再深一步。量出来 23 → **31**，亮度 0.87×。

### 探针第一版有三条前提是错的

1. 「花纹要落在地板上，不在穹顶上」——这个 pitch 下**整幅画面都是地板**，
   所以 45%–62% 的「在 y>154 以下」既不能证明什么也不能否证什么。换成把数据投影回屏幕：
   两道环各取 72 个点、用**拍这张图的同一个相机**投影，落在 mask 里的要占 60% 以上；
   再取一组辐条之间（偏 22.5°）的空石头对照点，落在 mask 里的必须低于 25%。
   这条断言换机位也不会烂，因为它钉的是「截图里的环就是 `zones.js` 里的环」。
2. 「around = 画框里除 mask 以外的地方」——那是 60 m 的雾和满屋子的道具，
   量出来是光照不是 albedo。改成 mask 外 4–10 px 的一圈**衣领**：同距离、同一盏灯、同一条阴影带。
3. 噪声底见上。另外强度必须两头有界：`mix=1` 那一张给出满值位移，
   原值的位移要落在它的 0.2–0.92 之间（实测 0.58 / 0.31 / 0.62），
   一个下游的 clamp 或者被色调曲线吃掉的强度都会掉到界外。

### 门禁也补了反方向

`zoneGate.js` 原来只拦一头（没有 arena 的区域不许写 `inlayColor/inlayStrength`）。
着色器的兜底是 `?? 0.45` 和 biome #2 的颜色，所以**一个室内竞技场不写这两个键也照样画花纹**——
用它自己的地板色、用没有人选过的强度、数据里还什么都看不出来，正是上面那个缺陷的形状。
现在两头都拦：室内 + `terrain.arena` 必须把两个键都写出来。

### 验证

`tools/inlay-cam.mjs`：**45 passed / 0 failed / 0 skipped**（三个厅各 15 条），
改前是 38/4——四条红分别是深渊的可见性、以及那条错误的「在地板上」前提在三个厅各红一次。
中间还红过一次，红的是**探针自己的取样量**：黄金屋的场地半径 66 m，
辐条之间那组对照点按原来「每个扇区 1 个角度」只有 6 个落进画面，低于我自己写的 8 个下限。
修的办法是把取样加宽（每个扇区 3 个角度：0.28/0.5/0.72），不是把下限调低——
现在三个厅分别有 42 / 26 / 18 个对照点落在画面里，命中数 1 / 0 / 0。
截图在 `/tmp/inlay3/`（`*-auth-2.png` 是原值、`*-mix-0.png` 是关掉、`*-mix-1.png` 是满值）。
这支探针已经进 `check-all`（visual 组，43 支）。

### 站在被测对象旁边：中心徽章（原来是三个厅里唯一没拍过的花纹）

上面那一版量了环、辐条和「旁边的石头」，却漏掉了同一段着色器里的第四个特征：
中心徽章（`float medal = 1.0 - smoothstep(0.055R, 0.075R, rad)`）。原因是机位：
从 0.34R 往里看，徽章在画面顶端只有十几个像素，任何统计都是噪声。
改法不是换断言，是**换机位**——第二段框图站到 `0.095R`（刚好在徽章淡出之外）再往里看，
于是不管场地半径是 66 m 还是 26 m，徽章的边缘都在前面两三米处，占了三四万像素。

投影几何这一次也要自己带前提，两条都是实测踩出来的：

1. **参照区必须证明自己不是被测对象。** 第一版沿用上面那圈「衣领」（mask 外 4–10 px），
   结果三个厅同时红在同一句话上，而且**三个厅的最大通道差都正好是 2**——
   这个「三处一模一样」就是指纹：被测的圆盘取 0.052R，而徽章一直淡到 0.075R，
   衣领整圈都还在徽章里面，等于拿徽章和它自己比。参照区改到 **0.10R–0.13R**：
   过了徽章的淡出，又没到内环（0.24R）和辐条起点（0.16R）。
2. **站在环上就看不到环的另一半。** 改完之后黄金屋 SKIP 了，理由是「参照环没有整个进画面」——
   相机站在 0.095R，那圈 0.10–0.13R 的**远侧一半在相机背后**，投影出来不是空集而是垃圾。
   所以参照区不再填多边形，而是只在**确实落在画面里**的取样点上盖小方块
   （每半径 24 个点、每点 ±5 px，再把花纹动过的像素连同 2 px 膨胀一起减掉），
   少于 12 个点或不足 300 px 就 SKIP。三个厅分别有 72 / 71 / 67 个点在画面里。

量出来的三个厅（`uInlayMix` 分别 0.45 / 0.45 / 0.72）：

| 区域 | 徽章 rgb | 0.10–0.13R 裸地板 rgb | 最大通道差 | 亮度比 | 纹理 std 比 | 徽章强度 / 环的强度 |
| --- | --- | --- | --- | --- | --- | --- |
| 深渊试炼场 | `[90,127,194]` | `[60,70,155]` | 57 | 1.68× | 1.31× | 0.59 / 0.58 |
| 冰封洞窟 | `[91,152,189]` | `[121,165,189]` | 30 | 0.90× | 1.02× | 0.31 / 0.31 |
| 黄金屋 | `[93,102,54]` | `[143,88,33]` | 50 | 1.01× | 1.01× | 0.64 / 0.62 |

最后一列是这一节里唯一一条**推导出来的**断言：`uInlayMix` 通过同一个乘法同时缩放徽章和环，
所以两者「到满值的几分之几」必须是**同一个数**，不是相近的数（实测偏差 0.00–0.02）。

### 验证（第四轮：徽章）

`tools/inlay-cam.mjs`：**72 passed / 0 failed / 0 skipped**（原 45，三个厅各多 9 条）。
两个突变体，两次单区域跑：

- 把徽章的混色目标乘 4.2（`dress * 1.05` → `dress * 4.2`）→ 亮度 96.4 → 171.2。
  **只有那条推导断言红**（0.85 vs 环的 0.62）；「不是一盏灯」的亮度带（0.40–2.6×）和 p95 上限
  都放它过去了——深渊试炼场自己的徽章就有 1.68×，这条带没法再收紧，所以容差从 0.3 收到 **0.10**
  之后，那条推导断言才是真正管住「徽章不是自己的一幅画」的那一条。
- 把徽章的混色系数改成 0（`medal * uInlayMix * 0.0`）→ **4 条红**。
  这一次也暴露了一个「空集免费通过」：mask 为空时 `maskStats` 读回 `[0,0,0]`，
  「和旁边石头颜色不同」凭 143 个通道差通过。两条颜色断言现在自带被测对象的前提
  （`inside.count > disc.count * 0.5`）。

## 剪影的最上面那一行，不是头顶

同一轮全跑里 `motion-check` 也红了一条：
`climb reaches above where standing puts the head — top 83 vs idle 84`。
不是产品缺陷，是**两层不同的污染**叠在同一个数上，而且两层都是「框的最上面一行」这个量本身的问题。

### 一块 4 px 的天空，把每个姿势的框都往上撑了 177 px

`motion-check` 把角色藏起来拍**一张**背景，再拿 24 个姿势逐张与它相减取 mask。
背景那两张只差 700 ms（实测 0 px 漂移），但整轮姿势要拍半分钟，
到最后几张时天上有几个像素已经越过了容差。于是 idle 的框从
`95x305 @456,261` 变成 `95x482 @456,84`，**像素总数一个没变**（17452 → 17458）。

密度门槛救不了这个：原来的 `trimBox` 丢掉低于峰值行 2% 的行，
而峰值行才 90 px 上下，一行 4 px 的碎屑门槛只有 `max(3, 1.8) = 3`，照样过。
真正能分辨的是**连通性**——那块碎屑跟角色不挨着。
`tools/lib/png.mjs` 新增 `largestBlob(m, minFrac)`：8 邻域连通标号，
只保留不小于最大连通块 `minFrac`（默认 2%）的块，所以一把单独成岛的武器或一缕头发还在，
碎屑没了。实测每个姿势掉 44–159 px、37–101 个碎块，最多的一张只丢掉自己 mask 的 0.88%
（这一条也变成断言：掉得太多说明滤镜在吃角色本身）。

### 干净之后，最上面那一行是剑尖

把碎屑滤掉，climb 的框顶是 81、idle 是 261——差了 180 px，看着更「过」了。
把那一块裁出来放大看：是角色**举在手里的剑**，从头顶斜着伸上去 120 px。
也就是说这条断言写的是「头」，量到的是兵器，
一个身体完全没抬起来的 climb 也能靠一把剑过关。

所以每个姿势现在存**两个框**，谁说什么就读什么：

| 量 | 用哪个框 | 为什么 |
| --- | --- | --- |
| 像素数、框心在不在画面中央、有没有被画框切掉 | `box`（连通块的外框，含武器） | 玩家看到的就是这个形状 |
| 宽度、长宽比 | `box` | 挥出去的剑就是「四肢甩开」的一部分 |
| 框顶（头）、高度 | `body`（同一 mask 裁掉低于峰值 15% 的细梢） | 头是头，兵器不是头 |

按身体量，climb 的抬升是实打实的 61 px（200 vs 261）、身高 354 vs 299；
aim 的「还是站姿不是蹲」是 294 vs 299（原来读的是 477 vs 482，两个数都是被撑出来的）。
`sit`/`down` 的头顶也一起换成身体框：336 vs 261、425 vs 336。

### 验证

`tools/motion-check.mjs`：**150 passed / 0 failed / 0 skipped**（改前 148/1）。
新增的两条是「碎屑滤镜没有吃掉角色」和整轮的长基线漂移诊断
（`_world-c.png`，这一轮读 0 px——漂移是间歇的，碎屑不是）。
截图在 `/tmp/mc2/`。

## 元素护盾：写好了、验过了、画出来了，然后没有人读

深渊法师有 900 点**冰**盾，深渊使徒有 3200 点**水**盾。这两个 `shield.element`：

- 由 `data/enemies.js` 写好，
- 由 `enemyGate` 校验（「shield has no valid element」），
- 随快照发到每个客户端（血条上那条金色的盾条），
- 而 `entity.js#takeDamage(amount, sourceId, now)` **根本没有 element 这个参数**。

也就是说：物理、火、以及它自己那一种元素，掉盾的速度**完全一样**；
两面盾在血条上是同一条金色。对法师唯一正确的打法是「继续打」——
这不是一个机制，这是一条更长的血条。

### 倍率是推导出来的，不是第二张表

`shared/src/data/elements.js` 新增 `shieldBreakMul(incoming, shieldElement)`：
把盾当成一层**元素附着**，问 `resolveReaction(incoming, shieldElement)` 会起什么反应，
就用那个反应的倍率；同元素固定 0.5（`SHIELD_SAME_ELEMENT_MUL`）。
所以「什么破什么」这件事全项目只有一处定义，反应表改了它自己就跟着改，
不会出现「融化 ×2 但破冰盾 ×1.5」这种两张表各说一套的情况。

| 打冰盾（法师） | 火 2.0 | 光 1.8 | 风 1.2 | 物理/水/雷/岩 1.0 | 冰 0.5 |
| --- | --- | --- | --- | --- | --- |
| **打水盾（使徒）** | 光 1.8 | 火 1.5 | 雷/风 1.2 | 物理/冰/岩 1.0 | 水 0.5 |

盾**故意不附着**：如果冰盾同时算一层冰附着，任何火角色第一刀就白拿一次融化，
同一个反应会被结算两次（一次算在盾的倍率里、一次算在伤害里）。
所以打满盾的法师第一下火伤 `reaction === null`，
但这一刀**自己的**火附着照旧留下，第二刀该反应就反应。

### 结算：先按倍率扣盾，再把余量换回来

```js
shieldMul = shieldBreakMul(element, this.shield.element);
const eaten = Math.min(this.shield.hp, dealt * shieldMul);
this.shield.hp -= eaten;
absorbed = eaten / shieldMul;      // 换回「这一刀被吃掉了多少」
dealt -= absorbed;
```

那个除法是关键：正好把盾打空的一刀必须对本体造成 **0**，
如果直接拿 `dealt - eaten`，一刀 100 打空 200 点冰盾会顺手给本体 −100。

伤害事件里现在带三个字段，各有各的消费者：

| 字段 | 谁读 | 为什么不能合成一个 |
| --- | --- | --- |
| `amount` | 伤害数字、`maxDamage` 排行 | 玩家打出来的就是这个数 |
| `absorbed` | `game.js` 的血条预测：`hp -= amount - absorbed` | 否则 3200 点盾期间血条会抖十秒再开始动 |
| `shieldMul` / `shieldBroke` | 飘字与破盾特效 | ×2 和 ×0.5 得**说出来**，不能只让盾条掉得快一点 |

飘字三种：`破盾 ×2.0`（good）、`护盾抵挡`、`同元素 · 护盾吸收`（新的 `.dmg.reaction.weak` 灰字），
只对自己的伤害显示——八个人的话那是一面字墙。
盾条也不再统一是金色，而是 `linear-gradient` 到该元素自己的颜色。

### 门禁：两个方向都要能红

`enemyGate` 加了两条，都是「这份数据配得上一个机制吗」：

- 名册里最强的一种元素对这面盾**必须** ≥ ×1.5，否则「换个人来」根本不成立
  （风盾/岩盾全名册最高只有 1.2 → 报 `nothing counters it`）；
- `shield.element` 必须等于 `def.element`，否则血条上一只怪会挂两种颜色。

### 验证

`tools/enemy-check.mjs` 新增第 7 节：**48 passed / 0 failed**（原 34）。
逐元素量掉盾速度（火 200/100、冰 50/100、物理 100/100、光 180/100）、
盾没破时本体 −0、正好打空时本体 −0 且晕 2.00 s、
打穿时溢出按原值进血（−50.0）、
**sim 里掉得最快的元素必须等于表里倍率最大的那一个**（两个方向都钉住）、
以及两条门禁突变体都能红。
写这一节时还量出一个真缺陷：无主伤害（角色倒下后残留的领域、场景伤害）
走的 `applyDamageToEnemy` 那条 emit 漏了 `shieldBroke`，
破盾会变成「金条无声消失」——已补。

### 反过来：玩家自己的盾也有元素

同一个缺陷在**玩家**这一侧还有一份，找法是照着上面那句问「这个 key 谁读」：

- `resolveReaction()` 有两个分支返回 `shieldElement`（岩打附着 → 附着那一种；
  岩附着被打 → 打进来那一种），**没有任何人读**；
- `vfx.shieldUp(x, y, z, element)` 写好了、参数里就有 element、**全项目没有调用者**。

于是结晶盾、`磐岩壁垒` 的技能盾、`圣咏回响` 的溢出盾都是同一条元素无关的金条。
现在三条都走 `grantShield(hp, until, element, now)`，
吃伤害走的是敌人那面盾**同一个** `shieldBreakMul`——
「盾抗自己那一种、怕跟自己反应的那一种」这条规则玩家只学一次，攻防两边都用得上：
炎盾被水打 ×2.0，被火打 ×0.5。弱盾不顶替强盾也**不改写它的元素**
（否则一片碎晶能悄悄把 12 秒的岩盾变成 2 秒的火盾，下一刀的代价跟着变）。

被完全吃掉的一刀以前**一个事件都不发**：披着盾打一场架是全静音的——
没有数字、没有受击闪屏、没有硬直。现在 `dealt > 0 || sh.absorbed > 0` 都发，
带 `absorbed`/`shieldMul`/`shieldBroke`，客户端据此**不**播受击反馈、
也不显示光秃秃的「0」，而是 `护盾抵挡` / `护盾被克制 ×2.0` / `护盾破碎`。

### 那条盾条其实一天都没画出来过

`tools/shield-ui.mjs`（新，把画面当证据）第一次跑就红在这里：
玩家 HUD 的盾条宽度**恒为 0%**。原因只有一行——

```js
sh: Math.round(this.shieldHp > 0 && this.shieldUntil > Date.now() / 1000 ? this.shieldHp : 0),
```

`shieldUntil` 用的是**实例时钟**（`ZoneInstance.now`，从 0 开始数秒），
而右边是 1.7e9 的 epoch：这个条件对**任何一面盾都是 false**。
所以结晶盾、技能盾、溢出盾在模拟里存在、被扣、被 128 条断言量过，
而血条上那一格从来没有出现过一个像素。序列化里现在**不看时钟**——
过期由 `updatePlayer` 下一 tick（50 ms）清掉，
模拟还认的盾就是玩家该看见的盾。

这一条是「一个 key 有四个消费者也可能是死的」的最后一环：
数据、门禁、结算、飘字、颜色全都对，只要**上线那一格**用错了时钟，
玩家看到的就还是没有这个机制。

### 验证（第二轮）

- `tools/proc-check.mjs` 第 15 节：**123 passed / 0 failed**（原 92）。
  逐元素倍率（火 0.5 / 水 2.0 / 物理 1.0，且必须等于 `shieldBreakMul` 说的那个数）、
  盾没破时本体 −0.00、正好打空 −0.00 且 `shieldBroke`、打穿时溢出 −50、
  弱盾不顶替也不改写元素、过期连元素一起清、
  完全吸收的一刀**有**事件（`amount 0` + `absorbed`），无盾时**没有**那三个字段（对照组）。
  两个突变体都能红：`shieldBreakMul` 恒返回 1 → 10 条红；结晶不传元素 → 2 条红。
- `tools/shield-ui.mjs`：**27 passed / 0 failed**，隐藏 canvas 后量 DOM 上的两条盾条。
  队伍卡 68 px 的盾条：炎 `#e76027`、冰 `#82ceda`、雷 `#a362e7`、无元素 `#cdbc84`，
  每一条都必须**离自己那一种元素最近**（四个候选里比一遍，两个方向都钉）；
  敌人铭牌：法师 `#88c1c9` 离冰最近、使徒 `#515c7a` 离水最近，丘丘人根本没有盾条（对照组）。
  写这个探针本身踩了两次「等待不是证据」：
  ①「宽度 120 ms 没变」对一条**还没开始动**的条同样成立（llvmpipe 上刷新驱动 ~3 fps），
  ②所以先等**客户端状态**变到位（`game.me.shield`），再等宽度走到 inline 百分比对应的像素。

### 三个结果，三个声音（其中一个原来是完全静音的）

盾条说的是「这是什么元素」，没有说「刚才发生了什么」。
而盾只有三种结果，对应玩家三个完全不同的决定：

| 结果 | 玩家该做什么 | 线索 |
| --- | --- | --- |
| 升起 | 站住，别躲 | `shield`：往上扫的一声 + 开放五度，不定位（是自己身上的事） |
| 挡住了 | 继续打 | `shieldBlock`：闷、短、160 Hz 往下一点点 |
| 破了 | 撤 | `shieldBreak`：高频噪声散开（玻璃）+ 方波往下掉，**敌人的那一份带 `at`** |

中间那一条原来是**真的没有声音**：完全被吸收的一刀故意不放 `hurt`
（不闪红、不抖屏、不 flinch —— 一刀没打到身上却让角色叫一声是最糟的反馈），
于是一个法师躲在磐岩壁垒后面吃一整个丘丘人营地，除了一层壳什么都没有，
读起来像「游戏把这些攻击丢了」。现在它有一个自己的、绝不像受伤的声音。

破盾的声音**不按谁打的**过滤：法师的盾掉下来是全队等的那一刻，
谁补上最后一下都该听见；但它**带位置**（`{ at: [x, y, z] }`），
所以营地那头破的盾比眼前这面轻。自己的盾破掉则**不带位置**——
它不是世界上的一个点，带了 `at` 反而会被自己到听者的距离衰减。

### 验证（第三轮：音频）

- `tools/audio-check.mjs`：**79 passed / 0 failed**（原 68）。三个新线索自动进了
  第 1 节的双向词表（每个 `case` 要有 cue、每个 cue 要有 `case`、每个 cue 的 `from`
  文件里真的要有那句调用）和第 2 节的合成断言（每条配方至少起一个音源、必须走到
  **sfx** 总线、包络峰值 > 0）。
- `tools/shield-ui.mjs` 第 3 节：**37 passed / 0 failed**（原 27）。
  不 grep 代码，而是包住 `game.audio.sfx` 记账，再从**模拟自己的门**驱动
  （`grantShield` / `damagePlayer` / `playerHitEnemy`），走完
  sim → `S2C.DAMAGE` → `_onDamage` 的那条分支 → `audio.sfx` 整条链：
  升起响 `shield` 且不响 `hurt`；被完全吃掉的一刀响 `shieldBlock` 且**不响** `hurt`，
  本体 1030 → 1030；破盾响 `shieldBreak` **和** `hurt`，本体 1030 → 835；
  **对照组**：同样一刀在无盾时只响 `hurt`，一个盾字都不带（否则「挡住会响」
  对一个每次受击都响的音效同样成立）；敌人那份的 `at` 落在敌人身上（(-7.0, 17.0)，
  误差 < 1.5 m），自己那份 `opts` 是 `null`（位置也钉两个方向）。
  三个突变体一起上（去掉 `shield` 调用、`isMe && false` 掉 `shieldBlock`、
  把敌人那份的 `at` 摘掉）→ 正好 3 条红，一个突变体一条。
- 这一节自己也踩了一次「读得太早」：`game.me.hp` 是**快照**写的
  （`localPlayer.applyServer` 里 `this.hp = you.hp`），和带线索的 `S2C.DAMAGE`
  是两条不同的消息，所以在线索到达的瞬间读 hp 读到的是**打之前**那个数
  （第一版就报了 1030 → 1030 然后把已经生效的破盾判成红）。现在「掉了」用轮询等到，
  「没掉」等两帧之后再读，而且模拟侧和客户端侧两个数一起断言。

## 一个 `phase` 冻住了全游戏的腿，另一个 `phase` 没人报

这一轮的两个改动都在「敌人」上，而且都是**同一个词**引起的。

`gfx/enemies.js` 里每个 `pose()` 都把自己的步态时钟叫 `ph`，从
`st.phase ?? t * rate` 取——意思是「上层要是钉了相位就用它，否则跟着时间走」。
而 `ActorSystem.update` 传给 `actor.update` 的状态里，`phase` 是**战斗阶段**：
一个永远 ≥ 1 的整数。于是 `?? ` 一次都没有落到右边：全游戏五种走路的怪
（丘丘人、火斧丘丘人、遗迹守卫、霜狼、岩龙蜥）的大腿相位都是常数 1，
腿一动不动地滑过地面。修法是**把两个量的名字分开**：
时钟叫 `gait`（外加一个 `gaitOffset`，从 id 推出来的固定偏移，
这样一个营地里三只丘丘人不会像合唱团一样齐步走），战斗阶段只以 `phase2: e.phase >= 2` 的
形式进去——布尔值，没法被误当成弧度。

第二个 `phase` 是**换阶段没人报**：`Enemy.takeDamage` 里 hp 跌破 1/N 时阶段会加一、
并且硬直 1.2 秒，但客户端对此一无所知。现在四条通道一起给：
横幅（「第 2 / 3 阶段 · 硬直 1.2 秒」）、带位置的 `bossPhase` 音效、
名牌上的菱形（`◆◆◇`，填/空而不是数字，60 m 外也不会被读成等级），
以及血条上的**阶段刻度线**（3 阶段就在 1/3、2/3 处画两条），
画在填充**之上**——阈值本来就在当前 hp 底下，正是被填充盖住的那一段。

### 顺手挖出来的第三个缺陷：那块名牌一天都没在画面里

写探针的时候，35 m 外找不到暴风之主的名牌。根因不在名牌，在 `Overlay.project`：
它把 `sy < -160` 的点当作「太靠上，不用画了」直接 cull 掉。暴风之主高 9.9 m 还会飞，
在任何真打得起来的距离上，它头顶的锚点都投影在屏幕**上方几百到上万像素**
（35 m 处 y = −320，抬到相机自己的仰角上限时 y = −13357）。
而名牌是游戏里**唯一**显示 Boss hp、护盾元素和战斗阶段的地方——
也就是说这一轮新加的菱形和刻度线，在真正需要它们的时候一个都看不见。
修法两半都要：`project()` 多一个 `topMargin` 参数（Boss 传 `Infinity`，
其余全部保持原来的 160），以及只对 Boss 生效的顶部钳制
`Math.max(LABEL_TOP, p.y)`——横向仍然跟着怪走，这样它才读得出是**那一只**的血条。
只加钳制没用：cull 在前面，`label()` 早就 return 了。

### 验证

`tools/boss-check.mjs`（新）：**59 passed / 0 failed / 0 skipped**。截图在 `/tmp/boss-check/`。

- 第 1 节量**大腿俯仰角**，而且只量大腿：这些 `pose()` 里的头部摆动、尾巴滞后、
  呼吸全都另有一项只跟 `t` 走，整个 bug 期间它们一直在动——「有骨头动了」是句废话。
  五种怪各四条：0.5 s 时钟里摆幅 0.46–1.07 rad、同一个 t 两次给回同一个姿势（差 0 rad）、
  给一个四分之一周期的 `gaitOffset` 姿势要变、以及这只怪**真的**拿到了偏移。
- 上面全是手动摆姿势，把 bug 放回去照样绿——`ActorSystem` 建的那个状态对象根本没参与。
  所以再加一条**走真帧循环**的：放一只没钉住的丘丘人从 12 m 外自己走过来
  （靠近到 8 m 就再推回 13 m，让它一直在走），十几帧里读 `thighL.rotation.x`。
- 这条断言的第一版是**错的**，而且是突变测试抓出来的：丘丘人的大腿是
  `sin(ph) * 0.62 * run`，`run` 随速度从 0.5 爬到 1.0，所以就算相位冻死，
  光是加速这一项就让原始摆幅有 0.25 rad——门线 0.05，**bug 在场也是绿的**。
  换成两个与幅度无关的读数：符号翻转次数（活时钟会穿过零，冻住的永远一个符号）、
  以及把 `run` 除回去之后的摆幅（剩下 `sin(ph) * 0.62`）。
  修好：2 次翻转、除完 1.22 rad；bug 在场：**0 次翻转、0.0018 rad**。
- 第 2 节四条通道各自要有**像素**证据和**对照组**：不到阈值的一刀报 0 次
  （但血条确实动了，填充 70.0003%）；跨过去恰好报 1 次
  （事件 `["暴风之主",2,3]`、音效 1 次且落在 Boss 身上误差 0.0 m、硬直 1.2 s）；
  横幅那块区域 lum 13.1 → 41.5、p95 13 → 214；菱形 lum 13.1 → 75.9、
  颜色 `[94,73,48]` 而不是血条的红；刻度线在 1/3 处蓝 102、2/3 处 121，中间只有 70，
  而条子中段仍然是 hp 填充 `[228,100,70]`；以及一只普通丘丘人**没有**菱形、
  没有刻度、不报阶段。
- Boss 那条钳制也是两个方向：同一帧里抬到仰角上限，暴风之主的锚点 y = −13357 而牌子画在
  y = 41，旁边的丘丘人 y = −485 且**没有**被画出来（普通怪不许被吸到顶上）。
- 「客户端是在阶段 1 的时候先看见它的」单独断一条：`phase: nb.ph || 1`——
  一只以阶段 2 流进来的怪本来就不该报（那是「营地在 110 m 外流进来了」，不是「它换阶段了」），
  第一版把生成和挨打放在同一个 `evaluate` 里，于是 actor 直接以阶段 2 出生，把这条断言吞了。
- 突变体四个，一条红对一个：把步态时钟改回读 `st.phase`（真帧循环那两条红）、
  摘掉 `sfx('bossPhase')`（音效那条 + 双向消费者那条红）、
  摘掉菱形的写入（菱形文字/像素红，取不到 rect 的老实 SKIP 而不是假绿）、
  摘掉顶部钳制（两条钳制红，牌子在 y = −325）。
- 已挂进 `tools/check-all.mjs`（`browser` 组，`art: true`）。

## 腿会动了以后：脚还在地上打滑

腿一动起来就露出了下一个问题：**五种走路的怪，脚全部在地上滑**。
上一轮把步态时钟从冻死改成了会走，但那个时钟是**时间驱动**的——
`t * rate`，`rate` 是每种怪手写的一个常数。于是「腿摆一个来回」和
「身体前进了多少」是两个互不相干的量：一个周期里地面走过 `speed / rate` 米，
而脚在这一个周期里最多只能往后扒 `4 · hip · sin(amp)` 米，两者相差
丘丘人 2.42 倍、火斧 2.17 倍、遗迹守卫 1.92 倍、霜狼 1.64 倍、岩龙蜥 1.52 倍。
差多少，脚就在地上蹭掉多少。玩家角色的 `Animator` 一直是按距离积分的
（`basePhase += speed * dt / stride`），怪没有。

修法是把时钟接到**已经走过的地面**上，而 `stride` 不是推出来的、是**量出来**的：

- `client/src/gfx/enemies.js` 新增一张 `GAIT` 表，每种怪只写三样东西：
  摆幅 `amp`、跑起来的速度 `top`、以及**哪几根骨头会着地**
  （双足两只脚；霜狼是前腿一对 + 后腿一对，`ext` 表示要沿骨头再往下延一段到蹄）。
  姿势函数反过来读这张表（`Math.min(1, sp / GAIT.wolf.top)`），
  所以摆幅和步幅不可能各写一份而对不上。
- `measureStride()` 在建模时把这只怪的一个完整周期采 64 帧，
  逐个着地点累加它在前后方向上的行程，加起来就是这一步真能扒过去的地面。
  **推出来的那个「摆钟理想值」偏长 25–60%**：膝盖会往前折、髋部会上下颠，
  脚尖的实际行程比 `4 · hip · sin(amp)` 短得多——按理想值积分，
  滑动比是 0.62–0.77 且**与速度无关**（所以看不出是哪儿错）；按量出来的值积分是 0.98–1.04。
- 一个周期里每个着地点各有一段支撑相，要**逐个求和**：双足两段，霜狼的纵向奔跑是
  前腿一段 + 后腿一段。只算一只脚就少一半。
- `buildEnemy` 会在 `buildRigged` 之后整体缩放模型（`group.scale.setScalar(s)`），
  所以步幅必须乘上这个 `mScale`（`setModelScale()`），否则所有 `scale ≠ 1` 的怪照旧打滑。
- 摆幅顺手放大了约 18%（霜狼 0.84 → 1.00）：步子长了，同样的速度下步频就降回了
  能看的区间——丘丘人 2.5 Hz、遗迹守卫 1.25 Hz、霜狼 2.75 Hz、岩龙蜥 1.25 Hz。

验证（`tools/boss-check.mjs` 第 1 节，76 条断言全绿）：

- 每种怪两个速度各断一条**滑动比**：把它钉住（`ai=null`、`stunned=1e9`）、
  把 `group` 的位置和朝向归零以便按米读模型空间，然后手动以固定 dt 推 4 秒，
  找出「着地点相对身体向后移动」最长的一段当支撑相，量这段里脚走了多少、地面走了多少。
  修好之后 0.978–1.067，全速和半速都在带内。
- 步频、`speed = 0` 时腿不许动（30 帧摆幅 < 1e-6）、
  钉住同一个 `gait` 两次姿势必须逐位相同、换 `gaitOffset` 必须换姿势，各一条。
- 源码锁两条：四种怪都必须在 `GAIT` 表里声明几何（不许再出现
  `rotation.x = d * 0.62 * run` 这种就地写死的摆幅），
  以及时钟必须写成 `gait += (v * dt / stride) * 2π` 且 `stride` 来自 `measureStride`。
- 突变体三个，每个红的**位置不一样**：改回时间驱动 → 10 条滑动比全红
  （比值 0.32–0.75）外加遗迹守卫步频红（0.5 Hz）；
  摘掉 `mScale` → 只有模型缩放不是 1 的那几种红 + 源码锁红；
  摘掉 `sin(amp · run) / sin(amp)` 这个「慢走步子要短」的缩放 → **只有半速那五条红**
  （0.517–0.603），全速全绿。
- 滑动比的门线是被突变测试**收紧**的：原来是 0.75–1.30，摘掉 `mScale` 之后
  火斧丘丘人（模型缩放 1.12）读 1.17 仍然是绿的——12% 的步幅误差是看得出来的。
  这些读数不经过渲染器（自己按固定 dt 推 `update()`），干净值只有 0.978–1.067，
  所以带子改成 0.88–1.15，那一轮突变从 3 条红变成 8 条红。

上面全部是骨骼空间的数字，一帧都没拍。`tools/enemy-cam.mjs` 补的是数字盖不住的那一半
——**摆动有没有被画出来，而且画在腿上**（冻在 sin(1) 的时钟同样能摆出一个姿势；
摆在一根视图根本不渲染的骨头上，屏幕上一个像素都不动）：

- 侧面机位、钉住 `gait = π/2` 拍一张、原地再拍一张、`gait = 3π/2` 再拍一张。
  同一个相位两张必须是**同一张图**（差异 < 1%，实测 0 px），相反相位必须重画腿
  （丘丘人 7072 px、霜狼 7382 px、遗迹守卫 30350 px、岩龙蜥 8737 px）。
- 「腿的那个方框」必须先证明自己框住了怪：把模型 `visible = false` 再拍一张，
  差集就是剪影，数方框里有多少像素是怪。第一版**平视**拍，营地站在坡上，
  丘丘人的膝盖在山脊后面——一次是 20%（其实是它挥的手臂），另一次直接 0 px。
  改成俯视（相机抬到 3.6 m）并且**左右两侧都试，用剪影像素多的那一侧**，
  于是 40–75% 的方框是怪，摆动那条断言也改成对着剪影而不是对着方框算比例
  （被挡住的部分会**抬高**门线，不会降低）。
- **「这种怪该不该走」只许从表里读，不许从测量里读。** 第一版写的是「大腿没动就 SKIP，
  因为可能是不会走的怪」，然后一个把丘丘人大腿项冻成常数的突变体让整节变成 SKIP、
  报「0 failed」——出口条件正好就是被测的那个量。改成从源码里抽出带 `GAIT` 条目的
  4 种 kind（并断言真抽到了东西），凡是表里说会走的，「有大腿骨」和「相反相位大腿要动」
  都是**义务**而不是条件。
- 这一节自己也被突变过两次：只冻大腿项 → 骨骼那条红、像素那条仍然绿
  （小腿和脚还在跟着时钟摆，65% 的腿部像素照样重画，这是老实的分工）；
  把整个时钟冻成 `ph = 1.0`（就是当初那个 bug 的形状）→ 像素那条红到 **0 px**，
  而「方框在怪身上」（9333 px）和「同相位两张一样」（0 px）仍然是绿的，
  说明红的是那一条断言，不是探针塌了。
- 顺手修掉两个先前藏起来的洞：`shoot()` 在怪没有弱点（`s.eye` 为 null）时返回 `null`,
  于是「到场特效有没有画出来」整节对丘丘人这类怪直接抛异常退出——
  弱点相关的方框本来就在一个会 SKIP 的分支里，几何点不该跟着一起没。
  以及那节的对照方框原来放在**头顶**：1.7 m 的丘丘人整只站在自己 2 m 半径的到场光圈里，
  对照永远是红的，改成脚底往上 4.5 m（半径的 2.25 倍），一切换成 0 bytes。

## 把模型单独拍出来看：霜狼原来是一条带鱼

上一轮修完步态之后，`enemy-cam` 的侧面机位第一次把霜狼**整只**框进画面，于是看见了一件
和步态无关的事：**它的臀部、两条后腿和尾巴是一坨飘在身体后面 34 cm 的独立零件**。原因在
`KINDS.wolf.parts` 里：躯干那条 `sweep` 从脊椎局部 z = −0.10·bodyLen 开始，而 `hips` 骨在
−0.38·bodyLen（脊椎是往**前**长的），尾巴和两条后腿都挂在 `hips` 上。谁都没抓到它：所有
既有机位拍的都是**头**，而步态门禁读的是骨骼——骨骼一根都没错。

### 「身体是连着的」这句话，用像素证明比想象中难

先试了两种便宜的读法，两种都在**已知坏掉的模型**上是绿的：

- **沿脊椎走一条线**（`hips` → `chest` 投影到屏幕，48 个采样点看剪影盖不盖得住）：
  49/49 全覆盖。因为那坨孤立的臀部**照样画在那条线上**，只是没跟任何东西连起来。
- **对 `diffMask` 数连通分量**（拿「把模型隐藏」的那张做差集）：不行，隐藏模型的同时也隐藏了
  它的**投影阴影**，差集里于是多出一块贴在地上的大斑，谁碰到它都算连通。

所以改成**把模型单独拍出来**：场景里除了这个 actor 和灯光之外的直接子节点全部 `visible = false`、
`scene.fog = null`、清屏色改成纯黑。剩下的就是模型自己，背后没有山坡挡它、地上没有阴影桥接它，
而且——因为坡不在了——相机可以**回到平视**，这才是看剪影的机位。四个偏航角
（正面 / 侧面 / 背面 / 3/4）各一张，就是这个仓库一直没有的**模型三视图**。

三条断言守着这套证据本身：把模型也隐藏之后那一帧必须是空的（实测 0 px 亮）、四张里最空的
一张也得有 > 3000 px 的模型、以及最差偏航角的最大连通块 ≥ 97%（且 ≥2% 的分量不超过 2 个）。
门线定在 97% 是因为发丝缝闭合之后「整块」和「散架」之间没有中间值：霜狼、遗迹守卫、丘丘人、
岩龙蜥四种怪、八张图，全部读到 100.0%。哪天有一只怪的设计真的让某个部件飘在体外
（环绕的护盾之类），它会在这里红——那是需要人判一下的发现，不是误报，数字就在消息里。

### 连通性这条门禁能红的范围，比它听起来窄

老老实实做了突变：把 `bodyZ` 的起点改回 −0.10·bodyLen（就是当初那个 bug），剪影**还是
100% 一块**——因为钉住的 `gait = π/2` 把后腿甩到了前面，正好在投影上把那道缝架住了。
所以这一节的注释里写清楚了它能承诺什么：模型画出来了、画在一处、以及**人用来判断的那几张
图就是模型本身**。真正抓住这个缺陷的是「看」，不是断言。

顺手也把这条门禁的敏感度调对：遗迹守卫从**正后方**拍，脑袋是一个 3292 px 的独立分量，
第二个分量的框底边正好在躯干框顶边**上面一行**——衣领和头骨是贴着的，只是这个机位没有
一个像素同时属于两者。1-2 px 的发丝缝不是「模型散架」，于是加了 `dilateMask()`：连通性问的是
**闭合 2 px 之后**的掩码，而「有没有画出来」仍然数原始掩码。

### 模型三视图当场找出来的东西

- **姿势错了**：`pose(π/2)` 对狼来说是全速伸展（大腿 1.15 rad），前腿往后甩、后腿往前甩，
  两对腿都站到肚子底下，照出来像只两条腿的海豚。骨骼投影表（新加的 `bones ...` 那一行）
  才让这件事说得清。步态振幅按 `run = speed / GAIT.top` 缩放，所以**速度 0 就是各部件被
  作者摆出来的那个静止姿势**——模型三视图从此按速度 0 拍。
- **我自己上一版的修法过头了**：把 `bodyZ` 的跨度写成 1.30·bodyLen，于是 0.34·bodyLen 的躯干
  **捅到脑袋前面**去了，而前腿挂在 `chest` 上、不跟着躯干走，结果两对腿并排站在身体中段。
  一条 sweep 的**两端都是对某根骨头的断言**：现在从 −0.46（后腿之后，剩下的交给尾巴）
  到 +0.58（脖子根），共 1.04·bodyLen，并且加了 `bodyT(z)` 反函数，肩部装饰环直接由
  `chest` 骨的站位算出来，不再手写 0.71 这种会跟着跨度一起烂掉的常数。
- **尾巴是身体长度的三分之二**（3 × 0.22·h = 0.66·h vs 躯干 0.98·h），每段还插着 6 根 17 cm 的
  尖刺——照出来是一根钉锤。改成 3 × 0.15·h，尖刺缩短到 0.95·rr、每段两圈错开 7 根。
- **背上的深色鞍座根本看不见**：`body2` 是 0.66× 体色（是**深**的，不是浅的，原来的注释写反了），
  但宽度只有 0.56·bodyW，只是脊背正上方一条窄脊，除了俯视谁也看不到。加宽到 0.78 之后
  才铺过肩胛落到上腹侧——白狼在 cel ramp 下本来就是一整块白，明暗断面只能靠 albedo。
- **腹部那块**原来低于躯干表面 0.14·chestR，从侧面看是一条硬边梯形「裙子」；沉下去到与
  躯干底面齐平、只露 5 mm 防 z-fighting。
- **冰刺**（这只怪唯一的元素标记）在 0.72 半宽处只戳出几个像素，拉到 0.86、长度 ×1.5。
- **口鼻**是 1.45·headR 长、0.62→0.30 的锥——照出来是球上插了块砖，改成 1.20 长、0.56→0.22。
- **肩部鬃毛**原来是闭合的一圈：四根朝**下**穿过自己的胸口、两根朝前盖住脖子，
  三视图上肩背是一堆碎片。改成只留 `sa ≥ −0.40` 的上三分之二，长度 0.80 → 0.52·chestR。

### 验证

- `enemy-cam frostWolf` 16 passed / 0 failed / 1 skipped（skip 是霜狼没有作者标注的弱点），
  `enemy-cam ruinGuard` 24/0/0，`enemy-cam hilichurl` 16/0/1，`enemy-cam geoVishap` 18/0/1。
  最大连通块（闭合 2 px 之后）八张图全是 100.0%，「隐藏之后」对照全是 0 px。
- `boss-check` 76/0/0：霜狼的滑移比仍然是 1.003（全速）和 1.067（半速），
  尾巴和躯干改形不碰接触点，所以 `measureStride` 的读数一个都没动。

## 模型三视图推广到其余怪：两个深渊怪原来都没有脸

上一轮那套「把模型单独拍出来」的证据只在四种怪身上跑过。这一轮把它推到剩下的 kind 上，
过程里工具本身错了三次、每次都是**把工具的毛病报成产品的 bug**，修完之后它当场找出了一个
两种怪共有的美术缺陷。

### 先让它能拍到东西

1. **等级门**。深渊法师的营地在龙脊雪山（进入需要 AR 4），使徒在璃月（AR 7）。低等级账号的
   `enterZone` 会被服务端拒掉，而工具照样往下走，于是它在**蒙德**的地面上找不到这两种怪，
   报的是「这个 kind 没有营地」——听起来像刷怪表坏了。现在按 `zoneEntryRank(zone)` 先
   `raiseRank`，并且**校验落地**：`enterZone` 之后读回 `g.zoneId`，不等于目标就打印
   「asked for X, the game is in Y — the transition did not take」加上需要的 AR 然后退出，
   而不是拍一整套错场景的照片。
2. **相机埋在山里**。丘丘人射手的营地在陡坡脚下，它的「登场特效」那一帧是 1000×700 全是草：
   主体、特效、天空全在地形另一边，整帧和对照帧**一个像素都没差**，于是被报成「特效没画到屏幕上」。
   第一版修法是照抄产品自己的规则（`CameraRig` 永远把自己保持在 `heightAt + 0.35` 以上），
   把相机抬出地面——结果在璃月喀斯特石柱下面变成 95.9 m / 84.1 m / 35.0 m 的抬升：相机站到
   柱子顶上垂直俯拍，「全身」那两张里的使徒是个 4 px 的斑点。**这比埋在土里更坏**，因为埋在
   土里的画面一眼就看得出不对。所以改成**先环绕**：以 20° 为步长绕站位转一圈，就近优先，
   第一个完全不需要抬升的偏航角就停下；抬升只当兜底，两个数都打印出来。使徒现在是
   orbited −40° / −80° / 100°、抬升全 0，登场帧里的怪从 318 px 变成 103896 px。
3. **这一帧里到底有没有主体**。登场帧不再是一个固定机位，而是四个偏航角轮着试：每个都额外拍
   一张「把模型 `visible = false`」的对照，`diffMask` 数出「怪占了多少像素」，超过 3000 就用它；
   四个都没有就 **SKIP 而不是 FAIL**，理由写成「它站在坡上」。霜狼在 yaw 0 和 90 是 0 px，
   yaw 179 才有 13884。
4. **对照必须两头都钉住**。「……而且只在脚下动」这一条在射手那张死帧上是**绿的**，因为整帧
   什么都没动。现在它同时要求 `moved >= 8`：先证明有东西变了，再证明变的地方对。

### 一个亮度阈值分不清「深色材质」和「虚空」

丘丘人火斧手读到「最大连通块 92.8%、2 个分量」——**误报**。掩码当时的定义是「亮度 > 26」，
而它背面那条深红围裙的暗部是 rgb 60,16,24，luma **25.9**。掩码于是把连接髋部和腿的那半条裙子
丢掉了，右腿变成一个独立分量。背景亮度只有 3–5、空对照的最亮像素是 1–5：**对比度从来不是
问题，问的问题错了**。

改成对「空的隔离帧」做 `diffMask`（tol 16）。这正是上一轮在**世界帧**里被否掉的读法——因为
隐藏模型同时也隐藏了它的投影阴影，掩码里会多出一块地面斑把什么都桥接起来；而在隔离帧里
根本没有地面接影子。tol 取 16 而不是默认 8，是为了把 bloom 光环排除在外：光环会免费把两个
分量连成一个，那样这条门禁就永远不会红了。

新掩码做了突变测试才敢用：把丘丘人的头骨抬高 2.2 个头半径（47 cm），四个偏航角读到
80.6%–87.0% / 2 个分量，**新旧掩码结论一模一样**——换掉的是阈值的语义，不是灵敏度。

### 拍出来才看见：两个深渊怪都没有脸

- **深渊法师**的兜帽边缘、开口里的暗腔、两只发光眼睛，全部作者在 z ≈ 0.86·headR，而头本身是
  一个伸到 1.46·headR 的球。三样东西**封在自己的兜帽里面**：建好了、绑好了、也照到光了，
  就是一个像素都看不见，三视图上是一颗光滑的深蓝蛋加两根触角。
- **深渊使徒**的目镜条是同一个 bug：1.5 头半径宽的条在 z 0.86，头盔伸到 1.10，只有两端探出
  头盔侧面的部分被画出来——正面看是一根穿过脑袋、中间被咬掉一口的棍子。

规则（狼的口鼻早就这么做了，只是没写下来）：**每个 z 都从它背后那个部件的前表面推出来**。

- 法师：穹顶往后推 0.55·headR 并在 z 上压扁到 0.86，前极点落在 0.67；暗腔球心 z 0.30、半径
  0.72，前极点 1.02，比穹顶多出三分之一个头半径，才读得出是个「洞」而不是下巴；边缘环坐在
  穹顶自己的剪影圆上（1.02 偏轴处穹顶表面正好在 z 0.30），并且用中间调 `cloth`——`dark` 的环
  会和它框住的那个洞糊成一块；眼睛在 0.31 偏轴处，暗腔表面在 z 0.95，眼心放 1.00，三分之二
  露在外面、三分之一埋着，埋着的那部分是它「连在什么东西上」的唯一理由。
- 法师还有第二层遮挡：**躯干挡住了脸**。肩部体积深 0.99·shoulderW = 0.153·h，而脸只到
  0.117·h，所以一条长满的躯干站在兜帽前面，把开口下三分之二切成一条平的八边形线，正好压在
  眼睛下沿。头**不能**往上抬让开，因为躯干顶端的顶点软绑（`softBone`）在头骨上、会跟着一起走。
  改成躯干只长到 0.82·torsoH。
- 使徒：**一块平板贴不上一个曲面**。中心处头盔表面在 z 0.97·headR，±0.65 偏轴处只有 0.66，
  任何单一 z 要么中间埋着、要么两端飘空；推到 1.06 就换成另一个毛病——一块往前伸出
  0.47·headR 的架子，而且整条挂在左边：`plate` 是从原点往 +Y 方向 loft 的，把它转 90° 变横向的
  那个 Z 旋转同时把它整条长度挂到了一侧，本想把它压平的 Rx 反而把它的宽度掀进了 +z。
  最终改成**七根短棒排在头盔自己的前弧上**：每根落在 (1.012·sin a, 0.968·cos a) 这个椭球表面点
  上、按 a 偏航使长轴贴着切线，间距 0.19 而长度 0.32，重叠成一条连续的弧形缝。推出量从中心的
  1.035 递减到端点的 0.985、棒长同时收细——**任何贴在曲面外侧的东西都会在掠射角上越过这个
  曲面自己的剪影**，端点沉进头盔里才不会在 3/4 视角上变成一根探出脑袋的发光雪茄。

### 然后它抓到了一个真的产品 bug：三种史莱姆一直埋在地下

修好取景之后，三种史莱姆的「登场特效」还是四个偏航角**全部 0 px 主体**——而同一次运行里
隔离渲染有 47589 px 的史莱姆。模型没问题，取景也没问题：**怪不在它该在的地方**。

一个 30 行的小探针（读每一只已流式加载的怪的 `e.y`、`actor.group.position.y` 和客户端自己的
`heightAt`）把话说完了：

```
slimeWater   at 46.0, 64.4   net y 8.58   group y 0   ground 8.58
hilichurl    at 36.3, 56.0   net y 4.32   group y 4.32 ground 4.32
slimeElectro at 168.7,119.3  net y 29.82  group y 0   ground 29.82
```

服务端把史莱姆放在地面上（8.58 == 8.58），客户端把它画在**世界原点的高度**。原因是
`KINDS.slime` 的 `update()` 里一行 `group.position.y = hop * S.r * 0.55`：`group` 是
**actor 自己的节点**，`EnemyActor.setPose` 每帧往里写网络位置，所以这一行等于把地形高度扔掉。
于是蒙德第一个营地的史莱姆在地下 5 m，第三个营地在地下 20–30 m——**三种史莱姆在整个开放世界
里都是埋着的，而它是新玩家遇到的第一种怪**。

只有史莱姆会犯这个错，因为只有它是 `rigged: false`、自己手写变换；每个绑骨的 kind 都只动
`group` **内部**的骨头，碰不到它。改法是把弹跳加到三个部件自己的 `position.y` 上
（`S.r * 0.84 + hop * S.r * 0.55`），描边网格是各部件的子节点，跟着一起走。

这件事没有任何「状态」层面的检查能发现：怪流式加载了、模型建好了、材质和灯光都对、动画每帧
在跑，服务端的坐标也是对的。它只在**像素**里存在。

### 顺手

骨骼投影表原来是霜狼的一份**手写**骨骼名单，对史莱姆和两个深渊怪打印的是空行——一个在十种怪里
有五种是沉默的调试辅助，是「给一个模型写的辅助」。改成按声明顺序枚举 rig、每行 7 根。

### 验证

- `enemy-cam` 十一种怪逐个跑过：`slimeWater` / `slimeFire` / `slimeElectro` 各 11 passed /
  0 failed / 2 skipped、`hilichurl` 16/0/1、`hilichurlArcher` 16/0/1、`hilichurlPyro` 16/0/1、
  `abyssMage` 11/0/2、`ruinGuard` 24/0/0、`frostWolf` 16/0/1、`geoVishap` 16/0/1、
  `abyssHerald` 11/0/2。隔离帧的最大连通块全部 100.0%，「连模型也隐藏」的对照全部 0 px。
  （`stormTyrant` 只出现在秘境波次里，营地路径拍不到它。）
- 顺带修掉的第三个「工具自己的取景」：粒子透视那一节把镜头仰起来是写死的「10 m 外抬 6 m」，
  在第三个史莱姆营地那 16 m 的远粒子仍然落进坡里、读到 0 px——一条关于粒子缩放的 FAIL，
  实际说的是山坡。现在仰角是**推出来的**（逐级加大直到两个粒子都离高度场 3 m 以上），
  并且把离地间隙打印出来：远粒子埋在地下的时候，「远的更小」这句话没有意义。
  **但「离自己脚下的地面 3 m」也还不是要问的问题**：把它接进 `check-all` 之后第一次跑，
  `slimeWater` 就红了——两个粒子分别离地 3.4 m 和 4.7 m，远的那个照样 0 px。把那张
  `-sparks.png` 裁出来放大看，远粒子的屏幕位置正落在一面草坡上：**终点在山那边的谷里，
  视线本身穿过了中间那道脊**。所以现在检查的是**整条线段**（相机→粒子，每 5% 采一点，
  最低间隙必须 > 1 m），而且既然这一节唯一的主张是「两个距离」，**偏航角就是自由的**——
  先绕（0/±40°/±80°/±120°/180°）再加大仰角，和取景搜索同一条规则。`slimeWater` 于是
  spun −40°、线段最低间隙 3.4 m，远粒子 198 px、比例 30.6×。留下来的机位是**搜到的最好那个**
  而不是最后试的那个（有三个营地会把整张网格试穷，停在「抬 26 m、转 180°」这个网格角落上
  比停在最浅的那个更糟）；而如果整张网格都没清出来，远粒子读到 0 px 就**什么也证明不了**，
  这时候两条断言都 SKIP 并把「视线埋进地下多少米」写进理由，而不是报一条假的 FAIL。
- 同一节里第二个假红：`geoVishap` 远粒子读到 605 px、比例 5.9×（门线 8×），而其他十种怪都是
  190–236 px。把那 140 px 的框裁出来放大，远粒子就是雪坡上一个 9 px 的小球——**605 是框里
  别的东西变了**。加了一张第三帧（同样没有粒子、间隔 900 ms）当噪声底并打印出来，但它只看得见
  「会重复」的那一类噪声，而这一次的 605 没有重复（下一次跑同一机位读 226）。真正把问题解决的是
  改问法：不再数「框里变亮的所有像素」，而是数**离投影点最近的那一个连通块**（种子取最近的亮
  像素，因为 `project` 比截图早一帧）。粒子根本没画出来的时候，种子落在一个噪声点上、连通块只有
  几个像素，正好就是断言想要的「0 px」。改完之后十一种怪重跑一遍全绿，`geoVishap` 那一行现在是
  「box lit 390, 连通块 220」——两个数并排打印，差值就是这条修法的收据。
- 第三个假红，也是前两个的**根因**：接进 `check-all` 之后 `abyssMage` 报「近粒子 1 px」——
  这次埋掉的是 4 m 那颗。相机站位在坡里，于是 t≈0.15 的采样点就已经在地下，网格里**每一个**
  候选都是负的间隙，绕和仰都救不了。而这一节的相机高度**同样不承载任何主张**（它只量两个
  沿视线的距离，画面里根本没有主体），所以现在先把眼睛抬到 `heightAt + 2` 并打印抬了多少。
  效果是 `hilichurlArcher` 的线段间隙从 −2.9 m 变成 +2.4 m、`frostWolf` 从 −0.9 变成 +2.4，
  四个营地都在**第一个**候选（抬 6 m、不绕）上就通过——绕和加大仰角这才真正退回成兜底。
  「orbit 而不是 lift」那条规则说的是**给主体取景**的时候不要抬相机；这两帧里没有主体。
- **进套件**：会数断言的探针一律要列进 `check-all`，否则它就是一堆没人再量一遍的 PNG。
  `enemy-cam` 一个文件要按三个 kind 各跑一次（`ruinGuard` / `slimeWater` / `abyssMage`），
  而这两个真缺陷在 `ruinGuard` 上都是不可见的，所以套件里加了 `idOf(s) = s.label || s.name`：
  日志路径、`--only`/`--skip`、`--list`、SKIP/MISSING、结果行、`art-` 目录和 SUMMARY 表格
  全部改用它，否则同一个 `name` 列三次会互相覆盖 `${runDir}/${name}.log`。
  第一次真跑就是上面那条山脊：`enemy-cam-slime` RED（10/1/2），`enemy-cam-mage` GREEN（11/0/2）。
- 两个深渊怪的脸是**看**出来的：法师的头部特写现在有兜帽边缘、暗腔和两只眼睛，使徒的目镜是
  一条横贯头盔的连续亮缝。门禁能保证的还是那三件事（画出来了、画在一处、人看的那几张图就是
  模型本身）。

## 最后一个没被拍过的模型：暴风之主的脖子长在背上

上一节把 `enemy-cam` 推到十一种怪身上，末尾留了一句「`stormTyrant` 只出现在秘境波次里，
营地路径拍不到它」。那句话的实际含义是：**全游戏唯一的三阶段 BOSS 是唯一一个没有人看过的模型**。
这一轮先给探针补上波次路径，然后它当场找出了这个模型的缺陷。

### 怪从哪里来：两个来源，只有一个能被工具驱动

数据里的怪有两个出处——营地（`zone.spawns[]`）和**秘境波次**（`zone.chambers[].waves[][]`）。
`stormTyrant` 只在后者里：深境试炼第 8 层（80 级）、黄金厅第 3 层（80 级，需要 AR 18）。
所以查表要接着往波次里找，找到就记 `{ via: 'wave', floor }`，报错文案也从「没有营地」
改成「既没有营地也没有任何一层的波次」。

真正的门槛是**谁有权限凭空生一只怪**。答案只有单机：`LocalSocket` 把权威的 `ZoneInstance`
放在这个标签页里（`g.socket.inst`），于是 `inst.spawnEnemy(defId, level, x, z)` 就是产品自己
刷波次用的那条路（`boss-check` 也走它）；联机模式下 `g.socket.inst` 是 undefined，客户端不可能
生怪。而登录默认是 `'online'`，所以波次 kind 必须先点 `[data-act="solo"]` 再点 `[data-act="resume"]`。
生完就地冻结（`ai = null`、`stunned = 1e9`、`state = 'idle'`），并且**把状态打印出来**
（`mode` / `inst`）：如果因为哪天默认模式变了而落到联机，探针 ABORT 并说清原因，
而不是拍一整套「没有主体」的黑图。

### 站位得按模型的高度缩放

暴风之主是 9.88 m 高——开放世界里最高的遗迹守卫是 3.6 m。四张世界机位是照 3.6 m 校准的
（11 m 全身 / 4.2 m 特写），照抄过来只能拍到一只翅膀。所以站位乘 `max(1, height/3.6)`
（这里是 2.74×）并打印出来；已经校准过的每一种怪都正好是 1.00×，一张旧照片都没动。

### 拍出来才看见：头是飘着的

隔离三视图里侧面读到「最大连通块 79.1%、2 个分量」，裁出来放大看得很清楚：**一颗蛋形的头
悬在半空，和身体之间是一条黑缝，画面里根本没有脖子**。

原因是脖子的朝向是**手写的角度**，而头的位置是 `place()` 里写的偏移，两者从来没有对上：

- 头骨在脖子骨自己的坐标系里是 `(0, 0.52·neck, 0.58·neck)`——**往上偏前**；
- 而脖子的几何是 `loft(..., trs(0,0,0, -0.6, 0, 0))`，绕 X 转 −0.6 rad 把 +Y 送到
  `(0, 0.825, −0.565)`——**往上偏后**。

于是那根管子从鸟的**背上**长出来（在侧视图里就是头后面那片弧形的鳍），而头浮在它前面
半米处。这个缺陷正面看不见、**背面也看不见**：缝隙整个在 Z 方向上，从前后两个方向看都被
身体的剪影吞掉了——世界机位的 `back-head` 那张里它甚至看着挺对，头稳稳坐在一段管子上面。
只有侧面和 3/4 视角能看见它，而这两个视角只有隔离三视图会拍。

改法不是把 −0.6 调成别的数字，而是**让脖子的脊线从 `place()` 自己的头骨偏移推出来**：
从关节点扫到 `(0, 0.52·neck, 0.58·neck)`、再多扫 10% 让头骨把接缝吞进去，中段往后拱
0.09·neck 做出猛禽的 S 形弯；`ref: X_REF`，因为这条曲线整个在 YZ 平面里（沿 ±Y 的脊线只有
在 Z 分量足够强的时候才能用 UP_REF，否则截面的滚转会在拐点处翻面）。`softLen` 跟着改成几何
自己的 Y 跨度（`skin.js` 量的是部件局部坐标的 |y|），否则软绑的过渡区会落在管子外面。

一句话的规则：**任何连接两根骨头的部件，长度和方向都必须从这两根骨头算出来，不能作者一个角度**。
角度是「看起来对」的产物，两边各改一次之后就再也不对了，而且它坏掉的方向恰好是三视图之外的
那两个视角。

### 验证

- `enemy-cam stormTyrant`：修之前 10 passed / 1 failed / 2 skipped（`the model is one connected
  piece from every yaw`，侧面 79.1% / 2 个分量），修之后 **11/0/2**，四个偏航角全部
  100.0% / 1 个分量。两个 SKIP 是「暴风之主没有作者标注的弱点」和「`tyrant` 没有 GAIT 条目
  ——这个 kind 不走路」，都是正确的 SKIP。
- 波次路径本身也是被量出来的：第一行日志是
  `stormTyrant -> abyssTrial chamber floor 8 wave (level 80)`，登场那一节
  「六米外materialise 的怪有特效」13 个活体特效、「九十米外流式加载的营地没有」0 个，
  脚下 240 bytes 而 4.5 m 上方的对照 0 bytes。
- 进套件：`check-all` 加了第四行 `enemy-cam-boss`（`stormTyrant`），四行一起跑
  **全绿 4/4**，共 57 条断言。加进去的理由和前三行一样——不进套件的探针就是一堆没人再量的 PNG，
  而这一次的缺陷在 `ruinGuard` / `slimeWater` / `abyssMage` 三行上都是不可见的。

## 特写要照着骨头对准，包围盒不是剪影

上一节修好了脖子，但那一套照片里还有一个更基本的问题：**三张「头部特写」拍的不是头**。
发现它的过程很偶然——量发光材质有多少像素被削到纯白时，`stormTyrant-head` 读到 **glow px 0**，
而这个模型的冠羽整个是发光材质。不是停帧（`a-stale-frame-is-a-silent-zero` 那一类），
而是冠羽根本不在画面里：镜头对着下巴。

### 抬 0.90·height 对准的是命中盒，不是模型

四张机位的仰角一直是 `aim.y += height * 0.90`。`a.height` 是**命中盒**的高度：暴风之主是
9.88 m，而它的头骨悬在离地 **10.66 m**、冠羽尖到 **12.08 m**。0.90 × 9.88 = 8.89 m，
比头低了 1.8 m——在一个 3.6 m 高的人形怪身上这点误差看不出来，在一只 12 m 的鸟身上就是一张下巴照。

改法是**从骨架里取**：`view.bones.head` 有世界坐标，直接 `aim.copy(headPos)`。
没有骨架的 kind（史莱姆）继续走 `0.90·height` 的旧路，一张旧照片都没动。

### 对准了头，「头在画面里」就成了同义反复——所以要量头的框

镜头对着头骨，「头是否居中」这个断言就永远为真。有意义的问题是**整颗头有没有被裁掉**，
这需要一个投影出来的框。第一版拿整个模型的包围盒角点去投影，立刻报了两个**假 FAIL**
（`quarter` 顶边 y=−15、`back-head` y=−1386）。看照片就知道是假的：`back-head` 里整颗头
四周还留着空。

原因是**轴对齐包围盒不是剪影**：这只鸟的 AABB 是 21.2 × 9.9 × 22.7 m（group scale 2.59），
翅膀撑开的对角线角点离头有十几米远，一个把头拍满的机位当然会把那些角点甩到画面外。

诚实的头部边界是**头骨自己驱动的那些顶点**：从 `skinIndex` / `skinWeight` 里筛出对
`head` 骨权重 ≥ 0.5 的顶点，取局部 AABB，再乘
`headBone.matrixWorld · skeleton.boneInverses[hbi]`——几何数据在 bind space 里，而
`boneInverses` 正是在同一个空间里采下来的，这两个矩阵串起来就是那块几何的刚体变换。
于是断言变成两侧都夹住的：框的四条边离画面边缘 ≥ 4 px，**并且**框高占画面 12%–95%
（太小是拍远了，太大是快溢出了）。三张特写现在读 69% / 75% / 74%。

### 材质可以关掉，所以「眼睛画出来了没有」是可断言的

`materialsFor()` 里有一条专门的 `eye` 材质。把 `materials.eye.visible = false` 再拍一张、
和原图做 diff，就得到「眼睛到底有多少像素到了屏幕上」——`Material.visible` 是按 material group
生效的，所以一个 mesh 一个材质**数组**也能单独关掉一条（`merged-meshes-hide-materials` 的另一面：
判断这个模型用不用眼睛材质得写 `mesh.material.includes(mats.eye)`，`===` 永远是 false）。
断言是两条：头框内变化 ≥ 40 px（眼睛在），框外变化 ≤ max(40, 内部的一半)（关的是眼睛，不是别的）。

这条断言在暴风之主身上第一次跑就是红的隔壁——**648 px**，几乎全是一条边缘的反光。
原因和深渊法师的兜帽是同一个：**每一个 z 都得从它背后那块表面上解出来**。头是
`blob(headR, 0.86, 0.90, 1.20)` 的椭球，眼睛却按常数 `z = 0.40·headR` 摆——在
`x = 0.60·headR` 处表面已经收回到 z ≈ 0.86·headR·√(1−(0.6/0.86)²)，两颗眼球整个埋在颅骨里。
把 z 解出来（`1.20·√(1 − (EX/0.86)² − (EY/0.90)²)` 再加 0.02 的浮起量）之后是 **7889 px**。

但纯白的眼球读起来像两颗磨砂纽扣——**一个贴在眼球上的点永远不会穿出它所在的表面**
（和深渊使徒的面甲不同，那是一块平板），所以瞳孔用 `M.dark` 的小球再往前 0.16·headR。
最终 **6115 px 在头框内、0 px 在框外**，裁图看是两只有虹膜的眼睛。

### 验证

- `enemy-cam stormTyrant`：**17 passed / 0 failed / 2 skipped**（上一节结束时是 15/0/2，
  四条构图断言 + 两条眼睛断言里，构图断言在修 aim 之前是红的、眼睛断言在修 z 之前是红的）。
- 假 FAIL 是被照片推翻的，不是被推理推翻的：两个 y 值荒谬到必须去看图，而看图看到的是
  一颗完整的头。**一个断言报红的时候，先问它量的是不是你以为的那个东西**。

## 「正面照」拍的不是正面：一条断言推翻了整套怪物图鉴

上一节给 `enemy-cam` 加了两条眼睛断言，然后把它推到剩下四种没拍过的怪身上。**第一次跑就红了两条，
而且是同一个缺陷**：霜狼和地藏龙蜥的眼睛在自己的画面里各贡献 **0 px**——隐藏 `materials.eye` 之后
整幅图一个像素都没变。加上上一节暴风之主的 648 px，三个 kind 的眼睛全都埋在自己的颅骨里。

### 一条只写在注释里的规则会被重新写坏

这条规则本仓库早就写过（深渊法师的兜帽那一节），当时的原话甚至是「霜狼的口鼻部已经默默遵守了」。
一天之后，同一只霜狼的**眼睛**被证明是 0 px。所以这一轮把算术变成了函数，让每个 kind 都必须调用它：

```js
function onBlob(sx, sy, sz, x, y, out = 0.02) {
  return sz * Math.sqrt(Math.max(0.04, 1 - (x / sx) ** 2 - (y / sy) ** 2)) + out;
}
```

`blob(r, sx, sy, sz)` 是按轴缩放的球，(x, y) 正上方的表面就在
`z = sz·√(1 − (x/sx)² − (y/sy)²)`。作者手写的常数 z 在 x = 0 处是对的，而头在中间最宽——**眼睛
放得越靠外，它背后的表面已经往回收得越多**，所以常数恰好在要放眼睛的地方是错的。

光解出 z 还不够：**挡在前面的不一定只有一样东西**。霜狼的眼睛同时埋在颅骨里*和*口鼻部的根部
截面里（那一段 x 跨 ±0.56、y 跨 −0.64…0.40），所以 y 也得抬到口鼻部背上去。地藏龙蜥同理，
它的 y 0.28 在吻部顶面 (−0.16 + 0.46) 之下。修完：霜狼 0 → **1286 px**，地藏龙蜥 0 → **1707 px**，
两个都配了一颗 `M.dark` 瞳孔（元素色的眼球在浅色兽头上只是个亮扣子）。

### 然后是这一轮真正的发现：那张「正面照」是侧面

修完眼睛去看霜狼的特写，画面里是一颗**侧脸**：一只眼睛贴在天灵盖上，口鼻朝左。日志里写着原因，
只是从来没有人数过它——`camera orbited 100° to clear the ground`。

`shoot()` 一直有一条避免把镜头埋进山里的规则，而它**优先「绕」**：绕着主体转，距离、仰角、
主体大小都不变，只换一个看的方向。对一张不关心方向的照片这是免费的；而这四张照片的名字**就是**
方向。一次扫描里 **43 帧被绕过，其中 12 帧绕了 80°–120°**：「front-head」是霜狼的侧脸，
而我刚刚正是在用这张图判断眼睛的位置。

改法有三层，每一层都对应「哪个量是这张照片的承诺」：

1. **优先抬，不要绕。** 抬高保住偏航角，只花仰角，上限 0.35·dst（俯角 ≈ 19°）；只有连抬都不够时
   才退回原来的最小绕角。抬高自己的失控方向仓库里已经吃过一次（璃月喀斯特石柱下的营地要求
   95.9 m 抬升，镜头站到柱顶，BOSS 变成 4 px），所以上限是必须的，不是装饰。
2. **净空余量按距离缩放。** `+0.6 m` 对 11 m 的站位是对的；离狼头 1.5 m 时任何一点坡度都会触发它，
   那 100° 的绕角就是这么来的。改成 `min(0.6, 0.25 + 0.03·dst)`。
3. **把偏航角写成断言。** `every portrait was shot from the yaw its name claims`：四张照片没有一张
   绕出 20°。**一条被弯折而没人清点的构图，等于没人知道它被弯折过**——而这条断言当场在霜狼、
   地藏龙蜥、深渊使徒三个 kind 上报红。

### 山坡不是模型的错：把主体挪到平地上

三个红的原因都是地形：霜狼站在 23° 的坡上，**任何**站位都清不掉那座山。这套照片说的是模型，
所以现在会先把冻结的主体走到营地附近最平的一块地——同一个世界、同一套光照、同一个由服务器生成的
actor，只是脚下那块地不再挡在镜头前。只在需要时才走：四个偏航角本来就清空的 kind 一步不动，
校准过的构图一帧不变（暴风之主、丘丘人、遗迹守卫、史莱姆、深渊法师都是 0 m）。

「最平」的挑选顺序也有一条教训：**同一圈里先比高差，再比平整度**。深渊使徒的营地在喀斯特石柱脚下，
30 m 内绝对最平的一块地是**柱顶**——第一版一走就爬了 90.8 m，正是上一层刚修掉的那个错误换了个身份
回来。现在同一圈内高差最小的候选优先。日志把两个数都打出来：
`subject walked 6 m to flatter ground (-2.68 m in height): the hill stood 2.62 m into the worst
portrait, now -1.47 m`。

这套挪位又自己送来两个后续，都值得记下来，因为它们是同一类错误的两种形态。

**①「预测相机」必须和「真正拍照的相机」是同一台。** 挑平地时打的分是绕着 `group` 的 x/z 采样地形，
而 `shoot()` 是绕着**瞄准点**转的——四足动物的头骨节点在身体原点前方 0.8 m，在 2.77 m 的特写距离上，
这 0.8 m 让采样点挪得比整个抬升上限还多。于是它算出「四个偏航角都够用」，然后霜狼的 front-head
当场绕了 100°：**打分用的相机和拍照用的相机不是一台，就等于没打分**（和「量了一块空草地」是同一
个家族）。现在四个 shot 的描述直接在页面里从 `__subj` 重建（含头节点相对 group 的 x/z 偏移、
以及模型不一定正好贴在高度场上的 `float` 项），node 侧只传 `hs / headDst / camY` 三个数。修完这一条，
霜狼从 22/1/1 变回 23/0/1，而**深渊使徒根本不需要再挪了**——之前那次挪动本身就是错误打分的产物。

**②「更平的地」不能是悬崖上的一块地。** 同一圈里比高差只在**第一个有合格候选的圈**里起作用：深渊使徒
那次的 9 m 圈上唯一清空的点在石柱**侧壁**上，于是它 9 m 走出去、**爬高 48.58 m**——柱顶那个错误第三次
换身份回来。所以落脚点现在必须是主体**可能站得住**的地方，判据用产品自己的：
`findWalkable` 的默认 `maxSlope = 0.5`（`shared/src/data/zones.js`），既查落脚点本身的坡度，也查
「走过去」这段路的平均坡度（`|Δh| ≤ 0.5 · r`）。加上这条以后深渊使徒改成 **21 m 走出去、下降 9.18 m**
（坡度 0.44），16/0/4 照旧全绿。找不到可站的平地时就取可站范围内分数最好的那块，让偏航角断言把弯折
如实报出来——**一张说明自己被弯折过的正面照，胜过一张石柱顶上的照片**。

### 顺带修掉的两个构图常数

- **一个固定的「至少占画面 25%」下限，惩罚的是小怪。** 一只正确构图的 1.71 m 丘丘人在 11 m 外只占
  23%，1.25 m 的霜狼占 18%——而这张照片的距离是**玩法距离**（弱点那一节的断言原话是「11 m 外看得见
  这只眼睛」），所以占比是模型多高的函数，不是构图对不对的函数。参照量改成几何算出来的
  `modelH / (2·dst·tan(fov/2))`，断言变成「实测 / 预测」落在 0.6–2.0：每种体型都在 1.0 附近
  （1.06× / 1.14× / 1.10×），而它照样能抓住这条断言存在的理由——柱顶那 96 m 抬升会把真实距离
  乘上去，比值随之崩掉。
- **特写的距离要从头的包围球解，不能从头高解。** 按 0.5 m 的头高把镜头推到 1.49 m，霜狼 0.95 m 的
  口鼻部就从**画面侧边**出去了；地藏龙蜥的钻角从背后投出画面高度的 **123%**，因为一个「厚度和
  距离同量级」的盒子会在透视里张开。球没有朝向：`d = R / sin(0.85 · fov/2)`，并且只允许比校准值
  更近，于是已经拍得好的一帧都不动。相应的尺寸断言也改成量**较长的那条轴**——横着占 45%、竖着占
  34% 的口鼻部是一颗读得清的头。

### 验证

- 八个 kind 逐个跑 `enemy-cam`（最后一轮 `/tmp/s8-*.log`）：霜狼 **23/0/1**、地藏龙蜥 **23/0/1**、
  深渊使徒 **16/0/4**、丘丘人 **21/0/3**、暴风之主 **18/0/2**、深渊法师 **16/0/4**、
  遗迹守卫 **29/0/2**、水史莱姆 **13/0/7**，共 **159 条断言全绿**。
- 三条新断言各自都**先红后绿**：偏航角断言在霜狼/地藏龙蜥/深渊使徒上报红（100°、−40°、−80°），
  眼睛断言在霜狼/地藏龙蜥上报红（0 px），构图断言在丘丘人/霜狼上报红（23%、18%）。
- `check-all --only enemy-cam` 四行全绿。遗迹守卫那一行是最关键的对照：它有作者标注的弱点，
  弱点那一节要在同一张特写里量「眼下方 1.0 m 的装甲」，所以特写距离的下限就是这个矩形——
  它的 `close-ups at` 一行没有打印，说明距离仍是校准值 4.2 m，29 条断言一条没动。

## 三张免费的 SKIP：没有眼睛材质的脸

上一节那条眼睛断言只在「这个模型用了 `materials.eye`」时才跑，于是丘丘人、深渊法师、深渊使徒
三个 kind 直接 SKIP——**一条为自己找好豁免理由的断言**，而豁免恰好覆盖了三张最需要检查的脸。
把模型沉照片拉出来看，三张脸各自坏在不同的地方，而根因是同一个：**脸是用 `glow` 做的**。

- **深渊法师**：两只眼睛是 `glow` 球（emissive 1.5），在 ACES 后直接削平成纯白圆点——没有虹膜、
  没有瞳孔、看不出在看哪。修法是「削平的高光要用**暗**记号救」：`glow` 退到后面当眼窝的光，
  眼球本体换成 `eye` 材质（亮但不削平，带锐高光），前面再压一颗 `dark` 瞳孔。三层的 z 都从
  后一层的前极点推出来（0.97 / 1.05 / 1.14·headR），所以每一层都真的露在外面。
- **丘丘人**：面具上两个 `dark` 眼洞是对的，洞里什么都没有是错的——近景看是个空道具。洞的前极点
  在 0.965·headR，眼珠给到 0.99（前极点 1.03），只探出 0.065·headR ≈ 1.4 cm：再少就被不透明的
  暗球挡住不画，再多就变成贴在面具上的珠子。暗洞的轮廓保持眼珠的 2.6 倍，所以读起来是「洞里
  有眼睛」。
- **深渊使徒**：它是头盔，本来就没有眼睛，但**面罩缝**就是它的眼睛，而那道缝拍出来是一串珠子。
  上一轮把 7 根小球的间距压到「重叠 1.8 倍」，补上了洞却补不掉扇贝形的边缘：每颗球自己的轮廓
  会在邻居之间鼓出来，卡通渐变又给每个圆顶打一道高光。**一条线不是任何间距的一排点，它是一个
  扫出来的实体**——改用 `sweep` 沿头盔前弧扫一条带（截面的 `w` 是缝高、`d` 是缝深），两端自然
  收尖，35 个零件变成 3 个。同时补了一块中间调的**面甲**（前极点比头盔高出 0.03，自身轮廓 0.76
  小于头盔的 1.012，所以中间凸起、边缘沉进头盔）和一条**钢灰眉脊**，头盔终于不是一颗素蛋。

顺带修掉三处「装饰不贴曲面」的老问题：

- **弧上的带子要随高度收缩。** 原来的面罩缝在任何高度都用头盔的**赤道**半径（1.012 / 0.968），
  在 y = 0.25 还行，到 y = 0.50 就浮空 0.03·headR——眉脊第一版就是这么像根挂在脸前的箍。
  `seat(y) = √(1 − (y/半高)²)` 是 `onBlob` 在另一处曲面装饰上的同一条修正，加上它以后每条带子
  在任何高度都半沉在盔面里，剩下的数字只管「探出多少」。
- **怪物的眼睛要自发光。** `eyeMaterial` 的 emissive 是 0.10——为人脸调的（虹膜本来就亮，再加
  emissive 会推成白色透镜）。使徒的面罩缝因此在背光下和头盔同一个明度：漫反射把它吃掉了 65%。
  所以 `eyeMaterial(color, lit)` 多一个参数，`enemies.js` 传 0.42，人物脸继续用 0.10——
  **同一个材质函数，两种被照亮的方式**。
- **`metal` 默认值是给蒙德的遗迹机械调的暖灰**，压在使徒的深渊蓝头盔上像一根米色枯枝。
  改成在模型数据里写 `metal: 0x93a8bd`（`shared/src/data/enemies.js`），和它要夹在中间的
  那两个颜色放在一起。

### 验证

- 三个 kind 的两条眼睛断言从 SKIP 变成**必须过**，并且都过了：深渊使徒隐藏 `eye` 材质后头框内
  变化 **421 px**（面罩缝）、深渊法师 **1719 px**（两只眼睛）、丘丘人 **1728 px**（洞里的眼珠），
  框外分别是 0 / 1 / 0 px——**变的就是脸，别的什么都没动**。三个 kind 的 SKIP 数从 4/4/3 降到
  2/2/1，passed 从 16/16/21 升到 18/18/23。
- 受 `eye` 材质自发光改动影响的另外三个 kind 复跑全绿：霜狼 **23/0/1**、地藏龙蜥 **23/0/1**、
  暴风之主 **18/0/2**（`/tmp/s13-*.log`、`/tmp/s14-*.log`）。遗迹守卫的眼睛是 `glow` 而不是
  `eye`，所以它那节弱点亮度断言的校准值不受这次改动影响。
- `check-all --only enemy-cam` 复跑时**遗迹守卫那一行红了**（22/7/2），七条全在弱点那一节，
  三个矩形读出来是同一片草色（`[150,154,119]` / `[149,151,119]` / `[148,149,120]`）。
  不是这一轮的材质改动——是探针自己的一个洞，见下一节。

## 挡住主角的山不在相机脚下

上一节末尾那一行红是这么来的：`enemy-cam ruinGuard` 的四张照片里，**一张都没有拍到遗迹守卫**。
全身照是一整片草坡，头部特写是 1000×700 px 模糊的绿色（相机贴着山皮），于是「眼睛比装甲亮」
这类断言全在量草。而同一支探针一小时前跑同一只怪是 29/0/2 全绿——**怪自己走了 1.6 m、转了
3.3 rad**，正面方向从空地转到了自家山脊后面。一个跟着世界状态漂进漂出的红，比一个稳定的红更
危险：它会被当成"偶发"忽略掉。

两个洞，一个是产品级的判据错误，一个是断言的覆盖面：

- **判据错**：`shoot()` 一直只在**相机所在的那一个点**采地形高度（`heightAt(cam.x, cam.z) + margin
  > baseY` 就抬机位）。可挡住主体的山从来不在相机脚下，而在相机和主体**之间**。那一帧的日志因此
  写着 `lifted 0, orbited 0`——按它自己的判据，视野是干净的。改成沿整条视线采样：抬高 `dy` 只把
  视线在 t 处抬起 `dy·(1−t)`，所以 t 处需要的抬升是 `gap/(1−t)`，取全线最大值；margin 随 t 线性
  收到 0（主体自己的脚比头低，不能被当成遮挡物），t 采到 0.75 为止（除数别炸）。t = 0 时它退化成
  原来那条点判据，所以**已经校准好的机位一帧都不动**（这一点由复跑的像素数字兜着）。
  同一段几何在 relief（把主体挪到平地那一步）里复制了一份——[[no-change-means-wrong-camera]]
  那条「预测相机必须是拍照相机」的教训在这里就是「两处必须用同一条判据」。
- **覆盖面**：那一帧红的是弱点亮度，而**取景断言全是绿的**——「整只模型都在画面里，大小是身高预测
  的 1.05 倍」说的是一张只有草坡的照片。原因是取景断言把模型自己的 8 个角点乘上相机矩阵算出来的，
  **投影框不是照片**：模型在山后面，框还在原地。所以补一条独立的断言：把主体 `visible = false`
  再拍一遍同样的四个机位，模型框内的像素必须变（≥ 8% 的框面积、≥ 500 px）。它和上面那条判据故意
  不共享任何代码——遮挡规则再漏一次，这条就得红。
- **能构造的状态才算修好**：`--yaw R` 现在可以钉住主体朝向（在读任何世界坐标之前钉，否则整张表
  描述的是上一个姿态）。用出事的坐标把地形剖面在 Node 里重算一遍（`shared/src/data/zones.js`
  的 `heightAt` 前后端共用，不用开浏览器）：老判据四张全是 `need 0.00`，新判据是 7.90 / 1.41 /
  0.92 / 0.00 m——全身照那 7.90 m 超过它 3.85 m 的抬升上限，于是 relief 会先把守卫挪到干净地面。
  这就是那七条红的全部成因。

### 验证

- `check-all --only enemy-cam` 四行全绿：遗迹守卫 **30/0/2**、水史莱姆 **14/0/7**、
  深渊法师 **19/0/2**、暴风之主 **19/0/2**（各 +1 条新断言，`/tmp/ca-enemy3.log`）。
  弱点那一节回到 `eye [252,234,169] lum 233.4` vs `armour lum 148.1`、11 m 外 1272 px 暖色像素。
- 新断言的实测值（模型框内变化占框面积）：遗迹守卫 64/56/53/49%、水史莱姆 49/57/45/63%、
  深渊法师 39/45/37/45%、暴风之主 **13**/44/53/50%。下限取 8%：出事那一帧是 ~0%，而最紧的
  暴风之主全身照 12.6%——它的 AABB 里有一半是翅膀和尾巴之间的空气，这就是「投影框」的宽度上限。
- `enemy-cam ruinGuard --yaw -1.8`（出事那个朝向）：**30 passed / 0 failed / 2 skipped**，
  四张照片框内 60/54/49/51%（`/tmp/yaw18.log`）。

## 被乘过的颜色必须是饱和色：暴风之主的白色炸光

模型独照那一节（黑底、无雾、无地形）终于被**量**了一次，而不是只被看。指标很窄：在主体掩膜内，
三个通道都 ≥ 200 **且**通道极差 ≤ 12 的像素——「顶到天花板、还一点色相都不剩」。这种像素堆成的
形状没有体积可读。四种怪的实测值：遗迹守卫 0.0–0.3%、深渊法师 0.0–0.1%、水史莱姆 0.3–5.2%
（王冠水滴和内核是高光水，本来就该是白的），**暴风之主 1.5–11.1%**——从背后看，它的头不见了：
六根冠羽是一团白色炸光，连成一个 10 928 px 的无形状色块，外面还罩着一圈 bloom 光环。

三处原因，都不是「亮度调低一点」能解决的：

- **`glow` 的色值本身是白的。** `0xb9ffe8` 红通道占 73%，而 emissive 是它 ×1.5、glow 材质的
  fresnel 边缘光又用同一个色值：被乘过的颜色只能往白里走。**亮度由强度提供，色相由色值提供**，
  所以能挨得住乘法的色值必须饱和——改成 `0x2fe0c0`（红通道 18%）。`accent` 保持原来的浅色，
  因为没有任何东西乘它。
- **薄件上的边缘光就是整个表面。** `hideMaterial` 的 fresnel 是 0.34 的**白**、宽度 0.30；在躯干上
  是一道轮廓光，在一根 6 cm 粗的羽轴上是**整根羽毛**。所以多了一个 `thin` 材质
  （`scaleHex(bodyHex, 0.92)`、`rimStrength 0.10`、`rimWidth 0.20`）给羽毛、翎、刃、鳍用。
- **削平的高光只能靠旁边的暗色救。** 和深渊法师的眼睛同一条：每根冠羽现在是 `thin` 材质的**羽片**
  加一条窄的 `glow` 芯，芯在 `d` 上比羽片**厚**、在 `w` 上比它**窄**，所以它是一条两面都看得见的
  亮脊，而不是画在一个面上的条纹。尾羽同样处理（`glow` 从共享路径的 `u = 0.55` 开始，两个零件
  不可能各自漂走）。

### 验证

- `enemy-cam stormTyrant`：冠羽那一团 **11.1% → 0.0%（21–28 px）**，四个偏航全部 0.0%，
  20 passed / 0 failed / 2 skipped（`/tmp/boss2.log`）。照片里六根冠羽现在是分得开的青绿羽片、
  各带一条亮脊，头重新露出来了。
- `check-all --only enemy-cam` 四行全绿、86 条断言：遗迹守卫 **31/0/2**、水史莱姆 **15/0/7**、
  深渊法师 **20/0/2**、暴风之主 **20/0/2**（`/tmp/ca-enemy4.log`）。新断言的实测：0.3% / 3.0% /
  0.1% / 0.0%，门槛 7%。
- 门槛为什么是 7% 而不是 4%：同一只水史莱姆两次跑出 5.2% 和 3.0%，所以门槛必须站在**大的那个**
  之上——贴着小的那个设就是抛硬币（[[gate-what-you-just-fixed]] 的反面：修完再校准，但要按观测到
  的散布留余量）。

## 元素色值是给粒子写的：三只史莱姆的白刃、一条纸糊的狼、一条量错的火花，和一台站在草丛里的相机

上一节那条「不许有一块糊成没有形状的白」的断言只在 `check-all` 的四种怪上跑过。把它扫过其余
八种（`/tmp/sweep15.sh`，一种一次 `enemy-cam`，串行），出来三条红：

| 怪 | 断言 | 读数 |
| --- | --- | --- |
| 雷史莱姆 | 糊成白 | **7.1%**（门槛 7%） |
| 霜狼 | 糊成白 | **50.5%**——全游戏最高 |
| 火斧丘丘人 | 远处火花按距离平方变小 | **6.4×**（要 > 8×） |

三条的成因互不相同：一条是色值来源错了，一条是 albedo 太亮，一条**根本不是产品的问题，是量法的问题**。

### 元素表的 `glow` 是给 additive 粒子写的

三只史莱姆、暴风之主、深渊法师的 `model.glow` 都直接抄了 `ELEMENTS[x].glow`
（`0x9fd8ff` / `0xffc08a` / `0xe0b8ff` / `0xb9ffe8` …）。那一列是给**加色粒子精灵**写的：精灵把自己的
颜色加到背后的东西上，所以浅色是对的。材质的 `glow` 是被**乘**的——emissive = 色值 × 1.5，再加一圈
strength 1.2 的 fresnel 边缘光——浅色到了色调曲线顶上只剩白。所以三只史莱姆的元素冠羽都是一片
没有体积的刃：雷的是白的（7.1%），水的是白的（3.2%），**炎的是奶油色的**——亮到没有色相，但暖到
让那条断言的「通道极差 ≤ 12」永远不成立，指标一个字都没说，照片里它就是一块奶油色的刀片。

改法两条，和暴风之主的冠羽同一套：色值改成元素的**饱和色**再压一档
（`0x2f96f0` / `0xff5a12` / `0x9440f0`——亮度由 ×1.5 提供，色值只提供色相），几何从「一整片 `glow`」
改成「`thin` 材质的羽片 + 一小截 `glow`」。这里和暴风之主的差别值得记：boss 的冠羽长，`glow` 是顺着
它走的一条**窄亮脊**；史莱姆的冠羽在屏幕上只有 17 cm 宽，同样的窄脊塞进宽刃里**直接看不见**——
第一版改完是一根没有元素感的紫角。小零件上会发光的东西是**尖**：同一条 sweep 的最后 30%，`w` 比刃
略窄（刃仍然决定剪影）、`d` 比刃略厚（不在里面 z-fight）。路径是从刃的路径 remap `t` 得来的，两个
零件不可能各自漂走。

### 霜狼：91% 的 albedo 没有留给阴影的余量

`0xdfe9f2` 亮度 91%。cel ramp 的亮带、0.34 的**白色** fresnel 边缘光、天光反弹、元素光环全都加在
albedo 上面，所以 albedo 是唯一必须给它们**留位置**的那一项：最差偏航 **50.5%** 的剪影三个通道都在
离天花板 55 counts 以内、彼此又差不到 12——一只纸剪的狼。第一版只改暗（`0xa9bfd2`，亮度 74%）：
50.5% → 9.3%，剩下的失败像素平均 **(203, 211, 214)**——比「≥ 200」那条线高 1 counts，比「极差 ≤ 12」
那条线低 1 counts。**一条门禁问了两个问题，就得答两个**：最终值 `0x93b0cc` 既暗一点，又把 albedo 的
通道极差从 41 拉到 57（暖阳打在冷毛上会压缩这个差，所以要写得比看起来需要的更宽）。
2.0%，而且照片里终于能看出脖子、肩、鞍背和四条腿的分界。

### 那条 6.4× 是背景亮度，不是粒子

火花那一节量的是「近处一颗 40 cm 的火花 vs 16 m 外同一颗」的像素面积，比值应当在 16× 上下。
它原来的量法是「比无火花的那一帧亮 10（三通道之和）」的连通块——**一个绝对阈值**。火花是加色的、
之后还要过色调曲线：同一颗火花在明亮的天空前面，软边缘被曲线压掉了；在阴影里的山壁前面，没有。
翻回八种怪已经拍好的帧重算，同一对距离量出来是 **6.4× … 32.7×**；火斧丘丘人的远处那颗刚好落在
一道背光山脊上，读到 510 px，而别的怪都是 ~200 px（它的峰值 249，别人 111）。

改成**按这一块自己的峰值的 1/4 画等高线**（`max(10, peak*0.25)`，缺席时退回绝对下限，免得把噪点
撑成一块），同样八帧算出来是 **13.9× … 21.3×**——一条围着理论值 16× 的窄带。于是门禁也从单边
`> 8×` 改成**双边 8×–30×**：比值接近 1 是尺寸被 clamp（这一节本来就是为 `gl_PointSize` 90 px 天花板
写的），比值远大于 16 是远处那颗被缩了两次（透视除法叠在已经含透视的尺寸上）。

### 附带的一条红：高度场不知道有草

改完之后把 `check-all --only enemy-cam` 跑一遍，水史莱姆那一行红了，而且红在一条上一轮才加的
断言上：**藏起模型再和原帧做差，模型投影框里必须是它自己的像素**——读数是「框里 6440 px 变了
**0 px**，整帧变了 **0 px**」。翻出那张 PNG：1000×700 全是一片草叶，机位站在草丛**里面**。

日志里其它数字全是健康的：`lifted 0.5 m`、`orbited 0°`、模型框 70×92 px、
「是 0.96 m 的模型在 11.0 m 外应占面积的 1.10×」——**投影框的门禁在一张草叶照片上全绿**，
因为投影框只知道模型在哪，不知道模型前面有什么。机位的抬升是从 `heightAt` 解出来的，而草、
石头、树干都是 **prop**，高度场从来没听说过它们。

所以这条测量从「事后断言」升级成**取景循环本身**：每张肖像拍完就地藏一次、差一次，覆盖率不够就
**抬高机位重拍**，梯子是 0 / 0.14 / 0.30 / 0.55 × 站位距离（用比例，1.5 m 的头部特写和 11 m 的全身
才拿到可比的俯角）；偏航不动（标签就是偏航）、距离不动（尺寸门禁是关于距离的断言），只花仰角——
肖像里唯一不承载任何断言的那个轴（[[orbit-dont-lift]]）。四级都不行才让下面那条断言带着最好的一级
失败，也就是这个循环存在之前的行为。

这个恢复分支本身也得有人跑过，否则它只是「等世界配合才会执行的代码」。第一次尝试是 `--sink F`
（把机位压到地形规则解出来的高度**以下**）——**没用**：地形是单面的，机位在地下 2.2 m 照样把史莱姆
拍得清清楚楚，四个标签全部在第 0 级就通过了。改成 `--blind F`：把近裁剪面推到主体之后，直到机位
爬够 F × 站位距离——注入的不是「草」，而是这条循环真正读的那个**特征**（照片里没有模型，藏与不藏
差 0 px）。`--blind 0.2` 跑出来正是想要的形状：`front-full` 第 0、1 级各 0 px，第 2 级（+3.3 m）恢复到
54.6%；`front-head` 第 0 级 0 px、第 1 级 7.9%（差 0.1% 没过 8% 的线）、第 2 级恢复；整张单子
**15 passed / 0 failed / 7 skipped**。第一版 `--blind` 还漏进了 isolation 那一节（2228 px 的史莱姆变成
122 px，两条 FAIL）——**注入的故障跑到它不该测的断言上，就等于什么都没证明**，所以现在它由肖像
梯子单独 arm。

### 验证

- 扫描八种（`/tmp/s15-*.log`）：丘丘人 / 丘丘弓手 / 岩龙蜥 / 深渊使徒 / 炎史莱姆全绿，另外三条红如上表。
- 修完复跑（`/tmp/s16-*.log`、`/tmp/s17-frostWolf.log`、`/tmp/s18-*.log`）：
  水史莱姆 3.2% → **0.0%**、炎史莱姆 → **0.0%**、雷史莱姆 7.1% → **0.0%**、
  霜狼 50.5% → **2.0%**（25 passed / 0 failed / 1 skipped）、火斧丘丘人 6.4× → **16.2×**。
  五种怪的火花比值现在是 9.7× / 15.9× / 16.1× / 16.2× / 16.6×。
- `enemy-check` 48/0（改的是 `model.color` / `model.glow`，键的消费者没变）。
- `check-all --only enemy-cam` 四行全绿：**86 条断言 / 0 条不绿**
  （`enemy-cam` 31/0/2、`enemy-cam-slime` 15/0/7、`enemy-cam-mage` 20/0/2、`enemy-cam-boss` 20/0/2，
  `/tmp/ca-enemycam-r3.log`）。上一轮同一条命令是**红的**——红在草丛那张照片上，见上一节。
- 恢复梯子本身：`enemy-cam slimeWater --blind 0.2`（`/tmp/s22-slimeWater.log`）三个标签走完
  「0 px → 抬升 → 恢复」，单子仍然 15/0/7。

### 这条指标的盲区（上一轮记下，这一轮补掉）

「通道极差 ≤ 12」这个中性条件是**故意**的——亮而有色相是合法的（一只白狼不能因为它白就算缺陷，
它算缺陷是因为它**平**）。代价是奶油色的糊白它看不见。把极差条件换成**相对**形式
（`极差 ≤ 0.14 × 最大通道`）在现有帧上重算：炎史莱姆的奶油刃 0.0% → 7.6%（抓到了），同时
**深渊使徒 10.6%、深渊法师 4.2%** 也会亮起来——照的确是真的。下一节就是把这三件事做完。

## 宽面不能用发光材质：深渊使徒的四道白箍，和一条问了两个问题的门禁

上一节留下的活是「先修使徒和法师，再把糊白门禁换成相对版」。两件都做了，而且修法和三只史莱姆
**不一样**——不是换个色值就够。

### 一片 53 cm 的板子，任何色相都救不回来

把使徒单独拍出来（`/tmp/art-s15-abyssHerald`，背面）：裙摆上四道**纯白箍**、两块**纯白肩甲**、
两根白角、六根白爪。失败像素平均 **(216, 241, 243)**——极差 27，中性条件（≤ 12）一个字都没说，
相对条件（≤ 0.14×242 = 34）抓得住。

成因和暴风之主/史莱姆同源：`glow` 材质 = albedo + emissive ×1.5 + 一圈 strength 1.2 的边缘光，
**同一个色值被乘了三次**，所以 `0x62c8ff`（红 38%）出来就是白。但这一轮的教训是另一条：

- **比边缘光还窄的零件**（3–6 cm 的箍、1.7 cm 的爪）在 `glow` 里**整个表面都是边缘光**，
  再深的色值也只能救回色相，救不回体积。
- **一块 53 cm 的板子**（肩甲）连色相都不是重点：那么大的面必须**被照亮/被压暗**才读成一块甲，
  发光材质本来就没有明暗。

所以三种零件三种处理，写进了 `materialsFor` 的调色板：

| 零件 | 原来 | 现在 | 理由 |
| --- | --- | --- | --- |
| 使徒 4 道裙箍 / 法师 3 道裙箍 / 法师两只手球 | `glow` | **`trim`**（新增） | 亮、有色相、有高光，不 clip |
| 使徒两块肩甲 | `glow` | `metal`（阵营的冷钢，和眉脊同一个值） | 宽面要明暗，不要自发光 |
| 角、胸脊、爪、面罩芯 | `glow` | `glow`（保留） | 窄到能承受被乘三次 |

`trim` 的配方**就是 `eye` 的配方**（`eyeMaterial(glowHex, 0.42)`），但**故意开了第二个 key**：
`enemy-cam` 证明一张脸的方法是藏掉 `materials.eye` 然后要求**头框外面一个像素都不许动**，
裙箍一旦共用这个材质，那条脸门禁就不再是脸门禁了。

色值也一起压深（`0x62c8ff → 0x1d8ae8`、法师 `0x8fe3f0 → 0x2fc4e6`；后者原来直接就是
`ELEMENTS.ice.color`，红 56%）。

### 一条门禁问了两个问题：多少 vs 是不是一个零件

换成相对版之后要重新校准门线，而**只用「占剪影多少」这一个数不够**：使徒是个大 boss，一块纯白
肩甲摊到整个剪影上只有 2%，能混过去。所以现在量两个数：

- **占剪影的比例**（worst yaw）：门线 **4%**；
- **最大连通白块**占剪影的比例：门线 **1.2%**。

十二种怪各拍四个偏航跑完一遍（`/tmp/s23-*.log`），再拿历史缺陷帧用同一个公式重算：

| | 比例 / 最大连通块 |
| --- | --- |
| 修好后（十二种全部） | 霜狼 1.4 / 0.43，三史莱姆 0.8 / 0.83，火斧 0.8 / 0.78，守卫 0.3 / 0.29，暴风之主 0.4 / 0.09，使徒 0.0 / 0.02，法师 0.0 / 0.00，岩龙蜥 0.0 / 0.00 |
| 历史缺陷 | 霜狼 42.7 / 39.4，雷史莱姆 10.4 / 9.14，**使徒 10.5 / 3.24**，炎史莱姆 7.6 / 7.07，**法师 4.7 / 1.75** |

两条门线都是**两头有界**的：4% 是最差合法读数（霜狼 1.4）的 2.9 倍、最小缺陷（法师 4.7）以下；
1.2% 是史莱姆水珠高光（0.83）的 1.4 倍、法师那颗白手球（1.75）以下。史莱姆是两条线的余量来源
——它的冠珠和内核是**湿的高光，本来就该是白的**。

### 验证

- 使徒 **10.5% / 3.24% → 0.0% / 0.02%**，法师 **4.7% / 1.75% → 0.0% / 0.00%**
  （`/tmp/s23-abyssHerald.log`、`/tmp/s23-abyssMage.log`，照片见 `/tmp/art-s23-*`：
  箍是有明暗的青色管子，肩甲是灰钢板，手球是有高光的球）。
- 十二种怪 × 四偏航全部在两条新门线之下（上表），逐种 0 fails（`/tmp/sweep23.log`）。
- 换门禁之后再实跑五种确认不是纸面推算（`/tmp/sweep24.log`，两个读数和离线算的一致到小数位）：
  霜狼 1.4 / 0.43、火斧 0.0 / 0.01、使徒 0.1 / 0.03、炎史莱姆 0.8 / 0.81、雷史莱姆 1.0 / 0.83。
- `check-all --only enemy-cam` **4/4 GREEN、90 条断言 / 0 条不绿**
  （32 / 16 / 21 / 21，比上一轮多的 4 条就是新加的「最大连通白块」那条，
  `/tmp/check-all-20260908-122246/`）。
- `enemy-check` 48/0、`api-check` 280/0、`mp-check` 全绿（`model.glow`/`model.metal` 的消费者没变）。

### 同一块板子的第三种材质：门禁看不见的那种糊

修完之后按规矩去看照片（`/tmp/art-s24-abyssHerald/abyssHerald-front-head.png`），发现
**我把纯白板子换成了纯灰板子**：`metal`（`0x93a8bd`）落在 53 cm 的肩甲上，是整个头部特写里
**最亮、最大**的一片面，比 boss 自己的头盔还亮——navy 的身体上贴了两块泡沫板。而两条新门线
一个字都没说（最大连通白块只有 17 px），因为它不够白，它只是**平**。

**一个窄面上的亮值是高光，同一个亮值摊到整只怪最宽的一块面上就只是画面里最亮的东西。**
所以肩甲最终是第三种做法：**板身 `M.body`（中间调 navy）+ 一圈元素色唇边**，唇边是**第二块板**
——稍长、稍宽、**厚度更薄**，先画：薄所以除了边界一圈之外整块都藏在板身里面，这是不建模倒角
就把一道边缘光放到平板上的办法。上面那张表的第二行因此作废，改成：

| 零件 | 现在 | 理由 |
| --- | --- | --- |
| 使徒两块肩甲 | **板身 `body` + 2 cm `trim` 唇边** | 宽面要明暗；亮值只留在窄的那一圈 |

（没有改 `metal` 的色值：它同时是使徒的眉脊，阵营的冷钢应该只有一个值。`model.metal`
仍然有消费者——`gfx/enemies.js:1479`。）

验证：`/tmp/s25-abyssHerald.log` 21/0，糊白 **0.0% / 0.00%**（两条门线都在），照片
`/tmp/art-s25-abyssHerald/abyssHerald-front-head.png` 里肩甲是有明暗的深蓝甲片加一道青边；
`check-all --only enemy-cam` 仍然 **4/4 GREEN、90 条断言 / 0 条不绿**
（`/tmp/check-all-20260908-123403/`），`enemy-check` 48/0。

留在盲区里的一条：**「平且亮」目前没有门禁**。糊白门禁问的是「有没有失去色相」，
而这块灰板子有色相、只是没有梯度。可测的形式大概是「单个连通面片内部的亮度 std」——
和地表那条 std 门禁同一个思路，只是要落在模型的零件上，下一轮再说。

## 地上到底有没有影子：一条没人问过的问题，和三个假红

阴影这套装置写得很细——2048² 的 shadow map、PCF 半径 2.4、bias / normalBias、跟着玩家走的
正交视锥、每一组散布物单独决定 `castShadow` 且注释里写着理由——而 48 个探针拍了整个世界，
**没有一条断言地上落下过一片影子**。两件事让这个洞很难被看见：

- 仓库里每一张校准过的照片都拍 **12:00**。那时太阳在 53° 上，1.6 m 的角色影长 1.2 m，
  基本压在自己脚下：**「没有影子」和「正午的影子」是同一张照片。**
- `motion-check` 故意把角色的阴影关掉（影子跟着姿势动，会污染剪影 diff）。
  它是唯一一个从侧面拍角色的工具，于是也交不出阴影的证词。

`tools/shadow-check.mjs` 直接问这个问题，而且用唯一不会被草地自身斑驳糊过去的方式问：
**把投射者藏起来，拍同一帧。** 矩形不需要知道草长什么样，它需要的是同一批像素两次——
一次有那个应该压暗它们的东西，一次没有。

### 三个假红，全都在第一轮的照片里

**一、预测出来的矩形会打偏。** `h / tan(elev)` 是**平面上**站着的人的影子。第一轮量的是蒙德
出生草坡（朝相机倾下去），采样点贴回地形之后落在影子**旁边**：树那一段读到「暗了 0.4%」，
而 30 px 外的地面暗了 32%。现在的采样是沿影轴的一次**扫描**（±2 影长，0.1 步长），
每个点再加一条横向交叉线（±0.45 m 五点）——一条直射线在有一点倾斜的地面上会漂出半米宽的
影子，08:00 曾经在 3.7 m 影子的 1.5 m 之后整条读 0，纯粹是漂掉了。断言只管
**剖面最暗的那个点有多暗、落在轴的哪一半、大约多远**：像素负责找到影子，几何只负责同意位置。
探针还会先自己找一块最平的地站上去（拒绝 26 m 内的地标，在 2/4/7 m 三个半径 × 8 个方向上
最小化起伏，找到 (2, 26)，7 m 内起伏 1.04 m）。

**二、截图不是帧。** llvmpipe 大约 2 fps，Firefox 的合成器又落在 WebGL swap 后面，
所以第一轮正午那张「把角色藏起来」的照片是**开机相机的旧帧**：换了一座山，610702 px 不同，
一个谁都没碰过的对照矩形「变化」了 14%。排除过自动曝光（`setExposure` 只在换区域时调一次）、
排除过 `render(dt)` 写相机、排除过循环被重启。真正的修法是：**每张照片连拍两次，
只有两张 bit-identical 才收下**（循环停着，场景里没有任何东西在动，所以差值不为 0 就只能是
管线没跟上）。现在每个小节都有一条 `settled` 断言，正午那对是 `2 + 2 captures`。

**三、层级决定有没有 shadow map。** llvmpipe 把每个浏览器探针都开在 `low`，那里
`shadowMap.enabled === false`。所以钉到 `high`，并且**两个方向都断言**：low 时渲染器和太阳
两处都关，high 时开着、有 map、有视锥。「这个世界没有影子」和「这个层级没有影子」是同一张
照片，只有一个是 bug。

### 修完之后量出来的东西：阴影是好的

| 时刻 | 太阳高度 | 影长 | 最暗 | 位置 | 太阳侧对照 |
| --- | --- | --- | --- | --- | --- |
| 12:00 | 52.8° | 1.23 m | **暗 52.8%**（lum 132.5 → 62.6） | 1.11 m = 0.9 影长 | −0.1% |
| 16:00 | 23.5° | 3.73 m | **暗 45.9%**（113.1 → 61.2） | 2.99 m = 0.8 影长 | 0.0% |
| 08:00 | 23.5° | 3.73 m | **暗 50.7%**（125.2 → 61.7） | 1.12 m = 0.3 影长 | 0.0% |
| 9.1 m 橡树 | 23.5° | 21.0 m | **暗 51.7%**（123.1 → 59.5） | 6.31 m | 0.0% |

外加两条跨时刻的断言：影长随太阳下落而变长；**正午影子之外 1.7 m 处，中午亮着（0.0%）、
到 16:00 暗了 27.1%**——同一块地，一天里的两个时刻，这一条同时钉住了「影子会动」和
「白天的地不是天生就暗」。树那一侧还数了 `castShadow`：**340/340 个常驻 instance 都在投射**
（95 棵树，按 0.6 m 键位把 InstancedMesh 的矩阵并成每棵树的 AABB 数出来的）。

### 于是这一轮**撤回**了本来要做的改动

写这个探针的动机是一句诊断：「角色在低太阳下的影子很淡，把 sky.js 的 ±78 m 正交视锥收窄、
往前推」。测完之后这句话站不住——它是打偏的矩形和过期的截图合成出来的。照片里的影子好得很
（`/tmp/shadow-final/h16-avatar.png`），而动视锥会扰动仓库里 ~500 条已经校准好的像素门线。
**所以不改。** 探针真正的产出是把「现在是对的」这件事钉住，而不是一次改动。

### 我自己写的那条门线是唯一的红，而它是个意见

第一版里有一条断言：「一个 shadow texel 要装得下一条肢体，所以要 ≤ 5 cm」。实际是 7.6 cm
（±78 m / 2048²），滤波 ±18 cm，于是它红了——但同一份日志里，55 cm 宽的身体在四个场景里
都压出了 46-53% 的落差。**7.6 cm 明显够用，这条门线量的是我的偏好，不是缺陷。**
改成回归围栏：`≤ 9.0 cm`——视锥被拉宽到 96 m（9.4 cm）或 map 掉到 1536²（10.2 cm）会红，
而对「7.6 cm 够不够」不表态；那个问题由下面四条落差断言回答。

其余门线也是**测出来之后**才定的：四个场景最弱的是 45.9%，门线取一半 = **20%**，
一个数管三个时刻（测量说时刻几乎不影响落差：52.8 / 45.9 / 50.7），
对照侧 ≤ 2.5%。两轮之间数字逐位重合，所以这条门线的余量是真的。

验证：`node tools/shadow-check.mjs` **26 条断言全绿 0 红 0 skip**
（`/tmp/shadow-check-final.log`，照片在 `/tmp/shadow-final/`）；已进 `check-all.mjs` 的
`visual` 组（`needs: 'browser'`），全套现在 49 个探针，整套跑下来
**49/49 GREEN、2882 条断言、0 条不绿**（`/tmp/check-all-20260908-150009/`），其中
`shadow-check` 在套件里 56s / 26 条全绿，`daylight-check` 那条「每个像素探针都钉了小时」
也照旧是绿的（这个探针钉了三个小时，但它是显式 `setWorldTime` 钉的）。

## 脚步落在哪里：一张手写的步幅表，和一条没有支撑相的腿

`motion-check` 拍了 23 个剪辑的剪影，`enemies.js` 那一轮把五种怪的步态时钟接到了地面上，
玩家角色却一直没有人量过。原因很像上一条：**打滑不是任何单独一帧的性质**。
每一帧的剪影都可以完全正确，而脚照旧在地上蹭——它是「相位推进速度」和
「身体走了多远」这两个量之间的关系，必须把角色**推着走一段**才看得见。

推着走一段之后，量出来的第一件事是：**玩家角色的脚也在滑，而且比怪严重**。

- 三个剪辑各写了一个步幅常数：`walk 1.55`、`run 2.30`、`sprint 2.85`（米/周期）。
- 同一时间，腿把踝关节往后扒过的行程只有 **0.51 m**（lyra，身高 1.62）到
  **0.583 m**（ignar，1.86）。走路差 3 倍，冲刺差 3.1 倍。
- 在接地窗口里量支撑脚的世界位移，滑动比 **1.08–1.12**：脚跟着身体一起走，
  一步里 30–50% 的地面是蹭出来的。
- 而且**误差随身高变化**：步幅是一个写死的米数，摆幅是腿长的函数，
  14 个角色（腿长 0.77–0.93 m）没有一个对得上。

但真正说明问题的是把踝关节一个周期的轨迹整段打出来：
**踝关节在最靠后的时候最高，一个周期里有两个 y 极小值，而且全程都在往前移动。**
这不是「支撑相太短」或者「步幅调错了」——**它根本没有支撑相**。
那是一个摆钟，不是一条腿；摆钟没有任何速度能让它的脚停在地上。
顺带查出第三份步幅拷贝：脚步扬尘/音效按 `_stepAcc > (speed > RUN*0.9 ? 2.1 : 1.5)` 触发，
是手写的第四个数，而且**一个周期只响一次**（一个周期落两只脚）。

### 步幅不是写出来的，是推出来的

一个支撑相占周期的 `duty`，这段时间身体前进 `duty × stride`，
而支撑脚相对身体往后扒的行程就是 `sweep`。两者是同一段地面，所以

    stride = sweep / duty

在别的任何取值上，那只「站住的」脚都在地上滑。于是 `client/src/gfx/animator.js` 里
三个手写常数换成了一张表，表里只有两列，**而且都是无量纲的（以腿长为单位）**：

- `GAIT`：`v/legLen → (duty, sweep/legLen)`，八行，从站定到 14 腿长/秒。
  一条曲线管 14 个身高，所以 1.86 m 和 1.54 m 并排跑的时候步子是成比例的，不是一样长的。
  `duty` 从 0.70 单调降到 0.19：走路是双脚重叠，冲刺有 78% 的腾空相——
  **腾空相就是「跑得比腿伸得开还快」的那部分**。
- `gaitAt(speed, legLen)` 是全工程唯一一个步幅的出处；`strideAt()` 是它的公开出口。
  `walk/run/sprint` 三个剪辑改成 `paced: true`，谁也不再带自己的米数。
  剪辑之间的差别只剩上半身摆幅——腿由速度和腿长决定，**所以走→跑→冲刺的过渡不再有步幅跳变**
  （量出来 1.556 → 1.680 → 2.879 → 2.959，两个档位边界都是连续的）。

腿则改成解出来的：`legCycle()` 只写脚要去哪（前后位置、离地高度、踝角），
`solveLegs()` 用闭式两骨 IK 把腿弯到那儿。三件事必须这样才成立：

- **支撑相在相位上必须是线性的。** 身体是匀速前进的，所以要站住的脚必须匀速往后走。
  任何带缓动的支撑相就是打滑。
- **必须在髋骨自己的坐标系里解。** 骨盆会上下颠、会前倾、会左右滚，
  同一对髋/膝角度在这一帧把脚放在地上，下一帧就把脚插进地里。
  解算前先把目标点乘 `inv(hips.matrix)`，骨盆就能在一只不动的脚下面自由移动。
- **骨盆的上下颠不是写出来的，是让出来的。** 髋关节离一只踩住的脚不可能比腿更远，
  所以脚越往前/往后，骨盆就必须越低（`reach(z,y) = sqrt(legMax² − z²) + y`）。
  一个周期两次落脚 ⇒ **两次下沉，位置自动落在落脚点上**，幅度自动跟着步幅走。
  只有「踩着地的那只脚」参与约束；腾空相谁也不约束，骨盆就保持离地时的高度——
  这里插值回站立高度就是一只兔子。

### 这具骨架没有踝高，所以步子必须更碎

一个真人在 1.4 m/s 走 1.4 m 一周期，我们量出来只有 1.12 m。差的那 20% 不是 bug，是骨架：
`humanoid.js` 里 `thigh + shin = legLen` 而髋部就在 `y = legLen`，
**踝骨绑定在 y = 0**——这具身体没有「脚踝到地面」那一段（真人约 8% 腿长）。
于是一只脚放在半个腿长以外，骨盆就要按完整的直腿几何掉下去。每多一厘米支撑相行程，
都要用「骨盆永久低一点」去买。表里把这份预算花到走路 9%、冲刺 18% 腿长为止，
剩下的差额用**步子更碎、步频更高**去补（1.13–1.97 周期/秒），
而不是用打滑去补。同一笔预算还养出了两个免费的量：
`ANKLE_ROLL = 0.035`（支撑相两头踝关节抬起 2.6–3.5 cm，脚跟/脚尖滚过去），
`BOB_KEEP = 0.45`（骨盆只把可用余量收回 45%——真膝盖在支撑中段是弯着的，
贴着约束跑会颠出真人的两倍）。

lyra（腿长 0.81 m）量出来的一整排：

| 速度 m/s | 剪辑 | 步幅 m/周期 | duty | sweep m | 步频 周期/s | 骨盆起伏 | 支撑脚滑动 |
|---|---|---|---|---|---|---|---|
| 1.0 | walk | 0.887 | 0.625 | 0.555 | 1.13 | 1.0 cm | 2.5 mm |
| 1.4 | walk | 1.116 | 0.597 | 0.666 | 1.25 | 2.0 cm | 2.1 mm |
| 2.3 | walk | 1.556 | 0.486 | 0.757 | 1.48 | 3.1 cm | 1.2 mm |
| 2.6 | run | 1.680 | 0.461 | 0.774 | 1.55 | 3.3 cm | 3.4 mm |
| 4.0 | run | 2.309 | 0.362 | 0.837 | 1.73 | 4.1 cm | 1.7 mm |
| 5.2 | run | 2.879 | 0.303 | 0.873 | 1.81 | 4.6 cm | 2.6 mm |
| 5.4 | sprint | 2.959 | 0.296 | 0.877 | 1.83 | 4.7 cm | 3.4 mm |
| 8.2 | sprint | 4.161 | 0.222 | 0.922 | 1.97 | 5.4 cm | 8.3 mm |

支撑脚在一段支撑相里滑 **1.2–8.3 mm**，而这段时间身体走过 0.6–0.9 m：
**0.2–1.0%**，之前是 108–112%。残余的那一点是骨盆滚动的横向分量
（矢状面的 IK 消不掉）加上积分步长。

脚步提示也跟着改了：`localPlayer` 不再自己攒距离，改成读 `animator.takeSteps()`——
**放脚的那个相位和报脚步的那个相位是同一个**，所以扬尘和音效不可能和动画错开，
而且一个周期报两次（两只脚各一次）。

### 三条红线，两条是探针自己的

`tools/gait-check.mjs`（25 条断言）第一次跑出三条红，没有一条是产品的：

- **「落地时脚是平的」是我自己写的一条意见。** 门线定在 8 mm，
  而 `ANKLE_ROLL` 是这个模型**故意**写进去的：支撑相两头踝关节要抬起来滚过脚跟和脚尖。
  它唯一抓到的东西是 ignar 8.2 m/s 时的 34.5 mm 后跟——那正是模型在工作。
  改成**两头都有界**（1.5%–5% 腿长）：完全没有滚动是一块木板，滚太多是踩高跷。
- **一条只可能失败的断言。** 单调性检查里 `worstGap` 初值写成了 `1`，也就是门线本身，
  于是「所有档位都在长」时它报回来的还是 `×1.000`、`tightest null`。初值必须来自数据（`Infinity`）。
- **在折点上取最近样本。** 骨盆曲线在每个落脚点是个尖角（约束在那里换腿），
  取「最接近落脚相位的那一帧」会落在尖角旁边几毫米高的地方，
  于是同一条对称曲线报出了 L 7.7 mm / R 2.4 mm 的左右不对称。
  改成在落脚点邻域取**极小**、支撑中段邻域取**极大**，门线也改成**无量纲的**
  「上升量 ≥ 该速度自己起伏的 60%」——一个写歪相位的正弦会读到 −1，一个不动的骨盆由 `MIN_BOB` 挡着。

变异测试是这条门禁存在的理由：同一段行军，身体多走 30%（也就是「剪辑里的步幅常数和腿对不上」
这个原缺陷），滑动读数从 1.0% 跳到 **23.3%**，门线必须变红——它变红了。

### 第四条红线：一个不存在的组名，让新探针一次都没跑

把 `gait-check` 挂进 `check-all.mjs` 时写的是 `group: 'sim'`——**没有这个组**。
默认组集是 `data,http,browser,visual`，于是这一行被 `GROUPS.includes(s.group)` 静静滤掉：
`--list` 里有它，跑起来是「**49 probes … GREEN**」。
一条跑零次的注册，和一条全绿的注册长得一模一样，而且这次的沉默就藏在我用来当证据的那个东西里面。

所以组名本身也得有门禁，而且是**双向**的，就在 `check-all.mjs` 里、在任何探针启动之前：

- `SPEC` 里每个 `group` 必须在显式的 `KNOWN_GROUPS` 里，`--group` 传进来的也必须在，否则 `exit 2` 并打出是哪一个；
- 反方向：磁盘上每个 `tools/*-check.mjs` 都必须被某一行点到名（写完忘了登记，和组名写错是同一种沉默）；
- 再反过来：`SPEC` 点到名的文件必须存在。

四条都做了变异测试（`--group sim`、临时放一个 `tools/zzdummy-check.mjs`），都按预期 `exit 2`。
另外那行 `N probes:` 从此当断言读：**加一个探针，这个数必须涨一。**现在是 **50 probes**。

## 高光是加上去的，所以平面会白掉

改完组名之后跑的整套（50 探针）红了两条，两条都不是步态，而且都是**「同一份构建、两次不同结果」**那一类：

**一、`audio-check`：门线比产品自己的规则还严。** 「落地声音要随落差变大」定的是 `gain > 0.5`，
而产品的规则是 `localPlayer` 在 3.5 m/s 以上才发 `land`、`game.js` 要 `gain = min(1.6, speed/9)`——
**产品能发出的最轻一次落地是 3.5/9 = 0.389**。跳起来落在一段上坡上就是 4.2 m/s、`gain 0.47`，
于是一次完全正常的落地被判红。门线改成从产品推导出来的 0.389，
而「越高越响」这句话本来就不能用一个数验证（一个数高于门线有两种原因：声音大，或门线低），
所以另加一条：把角色抬 **2.5 m** 让产品自己的重力把他摔下来（`GRAVITY = -24` ⇒ 11.0 m/s ⇒ gain 1.22），
要求**比跳跃至少响 0.2，而且不许压在 1.6 的上限上**——第一版用 6 m，读数正好是 1.60，
那测的是上限而不是曲线。

**二、`enemy-cam`：遗迹守卫的小臂在某一个方位角上白成一片。**
同一份构建，两次跑分别读出 152 px 和 1291 px（门线 1.2% 一块），
中间的差别是**守卫自己朝哪边**：它归 AI 管，两次跑之间转了 3.3 rad。
把朝向钉住之后缺陷可以复现了——`node tools/enemy-cam.mjs ruinGuard --yaw -2.4`，
稳定读出 2050 px / 3.27%，两条断言全红。

原因在 `gfx/toon.js` 的高光项：

    col += uSpecColor * step(spec) * (1 - rough*0.75) * shadowAtten;

**加法是没有上界的**，而金属的 `uSpecSharp 0.88` 换算成指数是 ~194：
在任何曲面上这是一个针尖大的亮点，**在一个平面上却是全有或全无**——
小臂是 `SEC.rect` 拉伸出来的，整个面共用一条法线，所以到了角度整块一起翻白，
连 bloom 光晕一起。量出来那块楔形是平的 238、饱和度 0.014（探针的判据是「近白且没有色相」）。
两步修：

- `metalMaterial` 的注释一直写着「tinted reflections」，但 `specColor` 就没传，用的是默认的纯白——
  **一句没有兑现的注释**。改成反射自己的 albedo（往白色抬 0.34），这是金属该有的物理。
  单独这一步只把 2050 px 压到 1762 px：说明主项不是色相，是幅度。
- 高光从**加**改成**混**：`col = mix(col, uSpecColor, …)`。混不可能超过被混的颜色，
  所以一个面最亮也就是这个材质自己的反射色，而不是「本来的亮度 + 0.79」。
  同一个复现机位：**5.9% → 0.6%，最大连通块 2050 px → 148 px，整张 32 条全绿**，
  小臂上仍然有一条看得见的高光带（只是有色相、没有光晕）。

探针也补了两处，因为这个缺陷是**被随机性藏起来的**，不是被门线放过的：

- 隔离机位从 4 个偏航角加到 **8 个**（45° 一档）。一块面会不会翻白，取决于太阳和**相机**的半角向量，
  所以偏航角就是「这个缺陷有没有进照片」的那根轴。
- 被摄对象的朝向从「`--yaw` 可选」变成**默认钉住**（`--yaw free` 才交回 AI），
  并且在快门打开的那一刻**再断言一次朝向还在**——钉的时候在，一分钟后未必在。

## 字压在草上：HUD 的每一行都从来没和它背后的画面一起量过

50 条探针里有二十多条看 HUD，但它们看的是**文字内容**（「横幅写着章节名」）、
**矩形**（「446x456 在 577,236」）或者**自己的颜色**（「卡片 lum 88」），
而 `hide-the-canvas-to-read-the-hud` 那一轮之后，量像素的 UI 探针都是**把 canvas 藏起来**再量的——
那正是玩家永远看不到的那一帧。这游戏没有信箱框、没有不透明底条：同一行 12 px 的字，
可能落在正午草地（luma 150-230）上、夜里的山坡（luma 30-60）上，或者天上。
能不能读出来只由 CSS 的两样东西决定（颜色的 alpha 和 `text-shadow`），而**这个仓库从来没问过**。

不是假想缺陷：每日委托横幅的第二行是 `rgba(232,197,106,0.8)`、13 px、**自己没有描边**
（`.banner .t` 有，`.banner` 没有，而 `text-shadow` 是继承来的，所以副标题什么也没继承到）。
压在阳光下的草上量出来是 **1.87:1**，低于 WCAG 给大字定的 3:1 下限。
起因那张截图是 `/tmp/qe-fix/05-daily-done.png`：标题读得出来，下面那行是一团糊。

于是有了 `tools/legible-check.mjs`（`check-all` 第 51 条）。

### 一个字的背景是它自己的描边

`text-shadow` 起作用的方式**就是把周围压暗**，所以对比度的「背景」那一侧是**描边**，不是场景。
停掉主循环之后同一帧拍三张：

- **A**：玩家看到的 HUD。
- **S**：把每个被评分的元素设成 `color: transparent`。**描边还在**——阴影是按字形的 alpha 画的，
  不是按它的颜色画的——所以 S 恰好就是这笔墨**落在什么上面**。
- **B**：全部 `visibility: hidden`，留给「没被 HUD 动过的场景亮度」和「这行字到底画出来了没有」。

A 减 S 就是墨、而且只有墨。拿 A 去和 B 比是第一版的做法，那会把一条描边算成没用甚至负分。

### 三次「像是产品缺陷、其实是读数缺陷」

一、**用变化量找字形，在亮背景上找到的是描边。** 第一版把墨定义成 `|A-B| > 阈值`：
「46」是橙红色的，压在旅行者白色的外套上，于是它的「笔画核心」量出来是 `113,82,75`（黑色描边），
「周边」量出来是描边外面 2 px 的**阳光下的布**。结果**真的加强描边，分数反而更低**（1.38 → 1.24）。
改成逐像素解覆盖率：`A = α·cov·C + (1-α·cov)·S`，在 C 离 S 最远的那个通道上反解。

二、**画出来的均值不是墨的颜色。** 13 px 的抗锯齿汉字大部分像素是部分覆盖，所以均值会往背景滑：
46 px 的 `.banner .t` 量出来正好是它的 `--paper`，而同样近白的 13 px `.hud-player`
量出来是 `177,105,91`——已经滑到背后那座褐色山丘三分之一的位置。38 行里 35 行就这么「不合格」了。
WCAG 的定义是文字颜色对背景，所以前景就用**写在 CSS 里的颜色**（`color` 的 alpha 乘上每一层祖先的
`opacity`）合成到 S 上；画出来的均值只留着显示，并且在**覆盖率接近满**的行上被断言必须一致
（`pull`，见下）。

三、**`opacity` 会把你刚加的描边一起淡掉。** `.wlabel .lv { opacity: .8 }` 保留了 80% 的墨，
**也只保留了 80% 的描边**，所以再厚的描边也救不回来：它在正午草地上量 2.79:1，
而它旁边同一层描边、不透明的名字是 5.26:1。改成 `color: rgba(...)` 把淡化放进颜色里，描边就是整的。
同一个道理也划出了 `pull` 的适用范围：一个**半透明**的元素是**成组合成**的，
它的描边跟着它一起淡，真实差值是 `cov·(C-描边)` 而不是 `cov·(C-背景)`，
两块渐隐的名牌因此读出 pull 1.29 和 1.52——它们的**比值仍然成立**（那是对着它们真实拥有的淡描边量的），
只是不能再拿来验证颜色。

`pull` 就是那道缝：把最密的 15% 笔画核心的实测亮度，和「按这些像素**实测到的覆盖率**预测的亮度」相比，
1.00 是完全吻合。它管的是「CSS 里读到的颜色是不是屏幕上的颜色」——一个 `filter`、一个
`mix-blend-mode`、一个设在没被遍历到的子节点上的颜色，都会让上面所有数字看起来仍然合理而这条变红。
（预测必须按实测覆盖率做：Firefox 在线性光里混字形覆盖，而这套算术在 sRGB 字节里，
所以只有覆盖率接近满的时候这个近似才无害——15 px 的「12:00」峰值 0.92、读 0.84，
0.7 的「风与牧歌之地」读 0.53，都不是产品的问题。）

### 门线是借来的，而且是修完之后才提上去的

- **注入一对必须跨过门线的对照**：两行探针自己的字，肩并肩压在同一片地上，
  一行 `rgba(242,234,214,.5)` 无描边、一行 `#fff` 带 HUD 的描边。它们和别人一样走发现、走隐藏、走
  `grade()`，亮的那个小时必须一个在门线**下**、一个在门线**上**（实测 1.86:1 对 8.85:1，4.8 倍）。
  这一条就是能第一轮抓住上面那个抗锯齿 bug 的断言：一个把每行都读成不可读的指标，
  也会把**好的**那个对照读成不可读。
- **两个小时**，因为失效是双向的：淡字死在亮背景上，暗字死在暗背景上，一个小时只能看见一半。
- **元素是发现来的**，不是列出来的；另一个方向上还有一张必须出现的清单，
  否则一次「HUD 改成画在 canvas 上」的重构会让这条探针变空、并且照样报绿。
- **渐隐豁免是有价的**：`overlay.js` 把 45 m 外的名牌按 `1-(dist-45)/55` 淡出，81 m 的牌子只有 0.34 的
  alpha，任何描边都救不回来——也不该救。所以一行只有在**同一张图里同一个 key 在 alpha ≥ 0.7 时通过了门线**
  才被豁免，另外还有一条「豁免不许变宽」的断言（74 行里 2 行）。
- **门线本身**取 WCAG 大字的 3:1：借标准比自己定一个数好，因为我定的数只是个意见。
  而这不是写这个文件时 HUD 就能过的线——第一轮在 2.6 上就有 5 行产品文字在线下、最差 1.87:1。
  四处产品修改落地、两个小时都量过之后才把门线提到 3，实测最差的一行是 3.38:1（正午的
  `span[ping]`）和 3.1-3.5:1（夜里，是一块正在渐隐的名牌，它的读数随距离摆动）。

### 修的是什么

- `--ink-halo`：**一份写下来的描边**（`0 0 2px rgba(0,0,0,.9), 0 1px 5px rgba(0,0,0,.85)`），
  给所有「直接压在 3D 画面上的字」用——`.hud-player`、`.currency`、`.zone-name`、`.worldclock`、
  `.hud-status`、`.chatlog .ln`、`.tracker`、`.qnav`（这个原来**一点描边都没有**）。
  它们原来各自写着 `0 1px 3~4px rgba(0,0,0,.7~.92)`：单独一层软阴影之后，
  紧贴笔画的那个像素还有阳光草地 80% 的亮度。真正起作用的是那个 2 px 的紧层，
  宽的那层只是让边缘不至于看起来像刻上去的。
- `.banner .s`：从「没有描边」到 `var(--ink-halo)` 加一层自己的 12 px 宽层（1.87 → 3.69/6.06）。
- `.dmg` / `.dmg.crit`：伤害数字压在被打的那具身体上（正午 luma 210+），
  同样换成紧+宽两层；暴击原来最靠近字的是它自己的金色炫光。
- `.wlabel`：单独一层 4 px 在正午草地上不够；`.lv` 的淡化从 `opacity` 挪进 `color`，并从 .8 提到 .88——
  因为即使描边完整，这条 10.5 px 的行仍然是整个 HUD 最弱的一行（3.26:1），
  而「你即将开打的东西是几级」不该是需要看第二眼的那一行。

### 验证

`legible-check` 28 条断言全绿（`--out /tmp/leg12`）：两个小时各拍三张、每张都要有两次拍摄
在被读的矩形上一致（容差是被读区域的 0.05% 且峰值 Δ ≤ 24——实测最坏的一对是散在 509x571 区域里的
14 px、峰值 Δ10，而这里每个读数都是至少 14 个核心像素和几十个环像素的均值），
玻璃帧必须掉墨留描边（A→S 变了 2.5 万像素，S→B 变了 3 万），
隐藏帧必须隐藏的正好是被评分的那些，六类必须出现的行都在，
对照跨过门线，两个小时的场景亮度必须真的一亮一暗（均值 luma 105 对 45），
12 行满覆盖的不透明文字 pull 0.84-1.00。

## 一次抽样就是一次抽奖：`questend-check` 那两条随机的红

上一轮的全套跑（49/50）唯一的红是 `questend-check`，而它单独跑是 55/0——同一个 build。
这种「在套件里红、单独跑绿」的红最值钱：它不在产品里，在探针对时间的假设里。这一轮把两条都拆了，
两条是同一个毛病的两面。

### 「走了 28 m → stage 0」：读数和往返请求赛跑

`walkTo()` 走完之后 `await sleep(1600)`，然后立刻 `await quests()` 断言 stage 变成 1。
但推进阶段是一次 HTTP 往返（`POST /api/world/quest`，回包重写 `player.quests`），
1.6 s 是拍脑袋定的：机器空闲的时候赢，套件跑到第 40 个探针、后台还在编码 PNG 的时候输。
输了以后打印的诊断也没用——`walked 28 m` 是**出发时**的距离，看不出到底是没走到、还是走到了没说话。

改成三件事：

- `questsWhen(what, want, 12000)`：轮询到期望成立为止，超时仍然交给原来的断言判红。
  等待有界，所以「阶段永远不推进」照样是红的，只是红得有原因。
- `walkTo` 的到达判定用产品自己的停止距离（`max(1.4, radius*0.6)`，和 `LocalPlayer.update`
  里那行同一个式子），不再用手挑的 2.5 m；目标被别的东西清掉而人还没到，就**再点一次**
  （上限 6 次，并且计数——横穿 28 m 草地要点六次，那是产品缺陷，得看得见）。
- 对话框改成等出现（`.scrim`，上限 6 s）而不是睡 1.6 s。七天神像是「摸一下」不开对话框，
  所以等不到不算失败——真正的门是调用方的 stage 断言。

现在这条断言自己会说清它做了什么：`28 m → 1.4 m of 1.6 in 103f`（0 次补点，420 帧预算用了 103 帧）。

### 「opacity 0」：在动画里抽一个时刻，抽到了尾巴

第二条红是 `...on screen, as a painted strip and not an empty node — 268×122, opacity 0`。
横幅是**在 emit 时刻记录**的（上一轮的教训，见 `clear-the-log-before-each-action`），
这一步没错；错的是记录之后 `setTimeout(…, 800)` 只读**一个**时刻。
`bannerIn` 是 3.4 s 的 `forwards` 动画：0% opacity 0 → 14% 到 1 → 100% 回 **0**，而且末态保持。
llvmpipe 上这一页 3 fps，一个 800 ms 的定时器排在一帧长任务后面就可能落到 3.4 s 之后，
读到的正是那个末态 0——于是玩家盯了三秒的横幅被判成「没画出来」。

改成取**整个生命周期里的峰值**：120 ms 一次 `setInterval`，`Math.max` 累峰值，
下一条横幅接管这个节点就停（一条记录不会替另一条消息作证），同时也累矩形的最大宽高。
读之前不再 `sleep(900)`，而是等采样器自己收工（`x.done`，上限 9 s）。

峰值指标必须还能是 0，所以加了一条反向对照：注入 `.banner { opacity: 0 !important }`、
`game.emit('banner', …)` 发一条只给探针看的横幅、让同一个记录器读它。
两边一起才算数：真横幅 **18 次采样峰值 1**，对照 **12 次采样峰值 0**。

### 验证

`questend-check` 56/0（`/tmp/qe-h2`，比修之前多两条：反向对照，以及峰值那条现在带采样数），
其中三条以前是靠时序运气过的：两个阶段推进 + 横幅上屏。
随后在**满载的全套跑里**同样是 56/0（`/tmp/check-all-20260908-220420`，51 个探针 50 绿、2922 条断言），
也就是那个红出现的同一种条件下。

## 要钉的不是取景，是背景：远处火花那条「已知会飘」的门禁

上面那次全套跑唯一的红是 `enemy-cam-mage` 的
`the far spark is smaller… 2091 vs 57 px, ratio 36.7×`（门线 8-30×）。
这一条 README 一直是当作「已知抖动」记着的，理由写的是取景：机位是搜出来的，
远处那团火花在画面里只有 56-161 px，几十个像素就能把比值推走。
这一轮把它拆开看，结论是**取景从来不是那个变量，背景才是**。

### 为什么是背景

两颗火花是同一颗 40 cm 的 additive sprite，摆在相机前方 4 m 和 16 m（横向各偏 1.0 / 2.6 m，
所以真实距离是 4.12 m 和 16.21 m，理论面积比 15.5×）。它们唯一的差别本该是距离；
实际上还差一个东西：**身后是什么**。additive 之后还要过 tone map，
所以同一颗火花压在蒙德的亮天空上会被压掉柔边、压在暗山壁上不会——
深渊法师那次正是搜索走到尽头、爬到 30 m 高「每条视线都是天空」的角落，
于是远处那颗塌成 57 px（半径 4 px），近处那颗没塌，比值就成了 36.7×。

### 于是删掉了这一节几乎所有代码

原来为了对抗背景写了一整套：推导出的镜头抬角、自由的偏航、把眼睛抬出地面、
4×4×8 的取景搜索（打分函数是「相机→点这条线段上任何一处的最小离地高度」）、
以及搜不到时的 SKIP。全都删了，换成一件事：**用 `iso` 把世界藏掉**
（模型照相机那一节本来就有这个开关：黑底、无雾），把主角自己也藏掉，
两颗火花摆在同一片「什么都没有」上。

- 深度测试没有东西可测了，所以「被埋掉」这个失败模式不存在了，0 px 又重新只有一个含义。
- 面积改成量**直径**（`√(4A/π)`）：远处那团只有几十个像素，面积把量化误差算了两遍
  （57 px 和 74 px 只差 5 px 半径，却差 30% 的比值）。
- 门线不再是围着 15.5× 的一条经验带，而是「直径比 ÷ 实测距离比」——距离是量出来的（3.93×），
  断言写的是「按距离成比例」，−15%/+20%。

### 校准和变异测试

九种敌人 × 两遍（`/tmp/spark-cal.log`）：直径比 3.94-4.02×，对上 3.93× 的距离比，
也就是**声明值的 100-102%**；两个测量框里的噪声地板全是 **0 px**——这条现在是断言，
而不是只打印出来：黑底上前后两帧必须一模一样，否则这一帧就不是它声称的那一帧
（旧读数里，法师那个远处框里装着一整片天）。

变异测试把 `gl_PointSize` 的透视除法换成常数距离（`max(0.35, 4.12)`），
读数正好是 `⌀ 1.00× vs 3.93×（声明值的 25%）` 并且变红；
翻倍的透视除法会读到 400%。两头都还报警，所以这仍然是一条门禁，只是不再抖。

### 顺带补了两个机型的覆盖，和一条 2.17% 的发现

手工把九种可生成的敌人都跑了一遍（`enemy-cam` 的读数全是按机型算的，
没有行的机型就没有门禁），于是给 `check-all` 加了两行：
`enemy-cam-vishap`（雪地上的板背四足）和 `enemy-cam-herald`（宽袍白箍那位），
探针总数 51 → 53。

同一遍手工跑里**霜狼**两次都在同一条上红：背面机位的最大连通白斑 651 px = 剪影的 2.17%，
门线 2%。位置量出来在左肩上沿贴着轮廓的一个 56×31 楔形（RGB 213,217,221），
~~也就是切向边上的 fresnel 边光被拉宽，而不是一块被打平的面~~
（同一只狼在别的偏航上最大只有 289 px，远景机位 174 px）。
边光是共享材质里的项，改它会牵动所有角色的既有门禁，所以这一轮不改，
按读数记进 已知限制，也没有给霜狼加那一行——加一条注定是红的门禁不算覆盖。

> 上面划掉那句是**错的**，下一节量出来了：那块白斑在轮廓**里面 32 px**，边光到不了。
> 不要在没量之前给一个缺陷起名字，起了名字就会照着这个名字去设计门禁。

### 那块白斑不是边光，是一块被打平的面

上一节把霜狼那 2.17% 记进了 已知限制，并且给下一轮留了一句话：让门禁能区分
「贴轮廓的边光」和「被打平的面」，办法是按白斑到剪影边界的距离加权。
**这一轮第一件事就是先量这句话的前提，结果它是假的**：对剪影做一遍 Chebyshev 距离变换，
那块白斑的最大内嵌深度是 **32 px**，D6 的腐蚀之后还剩 649/651 px；
而边光是 `1 - N·V ≥ 0.70`（`rimWidth` 0.30），只可能贴在轮廓上。
再放大 6 倍看那 56×31 个像素：硬边、内部完全均匀的 (213,217,221)——
一块法线只有一个方向的平面。按原计划写的那条「距离加权」门禁在这只狼身上会读到 0 px 的边光，
一个字都不会变红。

所以这不是门禁不够聪明，是**一个真的美术缺陷**，而且它有两个来源，一个一个关掉才找出来：

- **不是高光**。`uSpecStep = 1.01` 可以把 stepped specular 整项删掉（它是 clamp 过的 cos 幂），
  这一帧（`iso-nospec-back`）里那块白斑还剩 **416 px**。
- **是漫反射的亮带本身**。`bands: 2` 的皮毛，亮面就是一整片 `albedo × 日光`；
  暖色太阳 + 中性天光把 albedo 里 29% 的通道落差压到到帧上只剩 **3.6%**。
  一块平面上这两件事叠起来，就是「整张脸一起过线」——所以是全有或全无，
  把高光的指数调得更锐利不解决任何问题。

修的是两处，都在数据和材质里：

1. **霜狼 albedo 第三步**：`0x93b0cc → 0x86a1bd`（亮度 0.67 → 0.61，通道落差 29%）。
   这一步是被测量框住的，不是猜的：最坏连通白斑 **651 px / 2.17% → 230 px / 0.43%**（门线 1.2%），
   背面那个机位从 651 px 掉到 **2 px**，整只狼的白斑总量 1.5%（门线 4%）。
2. **每只怪的高光都换成自己皮毛的颜色**（`client/src/gfx/enemies.js` 的 `hideSpec`）：
   把 albedo 按最亮通道拉到满值，再往白色混 0.34，作为 `specColor`。
   狼是 (208,232,255) 的冰蓝、丘丘人是 (255,216,170) 的暖褐、法师是 (173,173,255) 的冷紫。
   `col = mix(col, uSpecColor, w)` 本来就是有界的，界的是**亮度**；把 `uSpecColor` 留在白色，
   界不住的是**颜色**——一块平面吃满高光就变成没有色相的纸片。
   这一项写在 `materialsFor` 里而不是 `hideMaterial` 里，因为后者还在给 `props.js` 造树皮、
   石头、雪和菇伞，那些 prop 的门禁是另一批校准好的读数。

### 让「不许白」这条门禁付不起「那就别画高光」这个价

`hideSpec` 的第一版**同时**把 `uSpecStep` 跟着亮度抬高（`0.74 + 0.14 × lum`），
于是整只动物身上只剩 9-30 px 高光，而那张表里每一个白斑读数都变好了。
这是「豁免要有对价」那条老账的另一种形状：**「没有白斑」是一条删掉高光就满分的门线**。
所以这一轮给它配了一节对照，四张照片一个偏航，每张回答一个不同的问题
（`uSpecStep` 就是那个可移除的嫌疑人：推过 1.0 删掉高光，拉到 -1.0 让每一个亮面吃满）：

1. **同一帧拍两次**——噪声地板。怪身上的元素光环跟着 `uTime` 脉动，两帧永远不是逐位相同，
   所以「移动了 12 px」这句话在没有地板的时候没有意义。现在断言的是 `地板 × 3 < 移动量`。
2. **`uSpecStep = 1.01`**——这一项**在屏幕上存在**：有像素变化，而且带高光的那些像素更亮。
   这里故意不设面积门线（粗糙皮毛在 4° 的 lobe 上本来就只有几十个像素，狼是 10-42 px），
   不能接受的是 **0**。
3. **`uSpecStep = -1.0`**——洪水。几十个像素变成几万个，`uSpecColor` 的颜色从此是量出来的。
4. **洪水 + 页面里把 `uSpecColor` 改成纯白**——变异测试，不用重新构建。

第 4 条的门线自己错了两次，两次都是**单位错**，值得记下来：

- 先拿「洪水之后那片像素的均值色」去比 `WASH_SPREAD`（14%），读到 13.4%：**健康的构建也是红的**。
  均值被每一块只吃到一点高光的面稀释掉了。
- 换成「白斑占剪影的比例」，配一条绝对门线（≥25%）：狼是 67.6%，丘丘人只有 12.1%——
  皮毛够深的时候，吃满白高光也到不了 wash mask 那条「三个通道都 ≥ 200」的线。
  两种丘丘人于是各红一条，**而它们什么问题都没有**。
- 最后的形状：**比值**，而且只在「洪水真的照到的像素」上读——
  取「白色洪水把亮度抬高 ≥ 40 counts」的那些像素做掩码，两张洪水都在这一个掩码上量通道落差。
  暴风之主是把这件事逼出来的机型：它的光环和冠羽占了变化像素的一半，色相在两张里都有，
  于是真实的 5.2× 被稀释成 2.06×，压在 2× 的门线上。

### 灰色的机器没有色相可丢，所以那一条要有对价地 SKIP

遗迹守卫是唯一一个洪水读数分不开的机型（6.8% vs 2.6% = 2.6×），而这不是噪声是算术：
`hideSpec` 给的是**皮毛自己的色相**，一台暖灰机器自己的色相本来就几乎是白的
（`0x6b6a62 → 0xfffdf1`，落差 5.5%）。所以那一条对它 SKIP，条件是 `body`
（每个 builder 都用 `model.color` 派生 `body`/`body2`/`dark`，画的是大面积；
`accent`/`bone` 是滚边）的高光落差 < 10%。

按老账的规矩，SKIP 必须有对价，对价是两条**不用拍照**的 uniform 断言，每个机型都跑：

- `hideSpec` 的承诺可以写成一个恒等式：拉满值和混白都不改色相，所以
  **高光的通道落差 = albedo 的通道落差 × 0.66**。十二个机型逐个材质核对，误差 ≤ 1.5 个百分点
  （实测最差 0.2 个百分点：暴风之主 `body` 29.0% vs 29.2%）。
  这两个落差都在 **sRGB 字节**空间里读（`getHex()`）——`THREE.Color` 存的是线性值，
  0.66 这个关系不过传输函数。
- 而且**把它们涂白必须让上面那条不成立**（最有色相的那个材质从 29-51% 掉到 0.0%），
  否则上一条就是一条免费的门禁。

### 验证

- 十二个机型逐个跑 `enemy-cam`（`/tmp/spec-sweep*.log`，串行，一个 ~75 s）：
  **全部 0 failed**。霜狼 36/0/1、丘丘人 36/0/1、丘丘弓手 36/0/1、火斧丘丘人 36/0/1、
  三种史莱姆各 26/0/7、遗迹守卫 42/0/2、岩龙蜥 36/0/1、深渊法师 31/0/2、深渊使徒 31/0/2、
  暴风之主 31/0/2。
- 洪水的色相分离（授权色 vs 涂白，同一个掩码）：使徒 12.9×、丘丘人 5.4×、法师 5.3×、
  暴风之主 5.2×、弓手 4.9×、水史莱姆 4.8×、霜狼 4.6×、火斧 4.5×、火史莱姆 4.3×、
  雷史莱姆 4.0×、岩龙蜥 3.7×，门线 **2.5×**（最小余量 48%）；遗迹守卫 2.6× 走 SKIP。
- 霜狼那块白斑：**651 px / 2.17% → 230 px / 0.43%**，八个偏航的白斑总量 0.0-1.5%。
- `check-all` 补齐最后六行（`enemy-cam-wolf` / `-hili` / `-hili-archer` / `-hili-pyro` /
  `-slime-fire` / `-slime-electro`），十二个可生成机型现在**每一个都有自己的行**，
  探针总数 53 → 59。上面六行覆盖的是**骨架**，这六行覆盖的是**配色**——
  而白斑和高光色相这两节读的正是配色。
- 整套 `check-all` 在这个构建上跑完（`/tmp/checkall-wolfspec.log`）：
  **59/59 GREEN · 3242 条断言 · 0 条不绿**。这一轮改的是共享材质里的一项，
  所以画面里出现敌人的每一张照片都要重拍一遍才算数。

## 元素反应：伤害模型里最深的一层，屏幕上最看不见的一层

一次反应就是一个玩家看不到的乘数。它是这个项目里模拟得最细的机制之一（附着量、衰减、
克制、扩散、结晶盾），而它在客户端的**表现层**当时有三个洞，而且三个洞谁也不含谁：

1. `client/src/game/vfx.js` 里那一支写的是 `case 'frozen'`，而线上传的是
   `REACTIONS.freeze`。于是**全游戏最常见的那个反应**（水打冰、冰打水）掉进 `switch` 的
   `default`，画出来的是一团按**来袭元素**着色的通用光球；作者写的那套结霜是死代码。
   一个拼错的 `case` 加一个安静的 `default`，任何「有没有接上」的检查都看不见它：
   key 声明了，分支存在，画面是错的。
2. **反应完全没有声音。** 命中、暴击、破盾、换阶段、升级、开箱都有；把伤害乘两倍的那一下没有。
3. `_onDamage` 的 `target === 'player'` 那一半**根本没读 `d.reaction`**。服务端对玩家自己的
   附着走的是同一个 `resolveReaction`，`zoneInstance.js:714` 的 payload 里一直带着
   `reaction`——一个萨满把湿身的角色感电，机制上和玩家自己打出的感电是同一回事，
   而客户端把它当成一次普通挨打：没有光、没有声音、屏幕上也没有那两个字。

### `default` 是控制组，不是兜底

修法本身是三行字的事（改 key、加六个音效配方、把玩家那一半接上）。难的是**门禁**：
「这个 key 有没有画面」这个问题不能用「它画了东西吗」来回答，因为**它确实画了东西**——
那正是缺陷。掉进 `default` 的 key 会画一团光球，任何「非空」的断言都是绿的。

所以 `tools/react-check.mjs` 拿 `default` 分支自己的那一帧当**控制组**：把
`reaction: '__nosuchreaction'` 送进真正的 `_onDamage`，拍下来，然后要求 11 个授权 key
**每一个都和它不一样**。`vfx.js` 里的 `default:` 因此不再是实现细节，它是这一节的量具，
注释里写明了这件事。

拍照能拍成的三个前提，每一个都是这个仓库以前踩过的坑：

- **随机数按帧种子固定。** 每个火花的落点都来自 `Math.random`，不固定就是「什么都不一样」，
  两张图没法比。探针在每次拍摄前重设一个 mulberry32，然后断言**同一次拍摄重复一遍是逐位相同的**
  （0 px）。这一条同时是 llvmpipe 的「陈帧」检查。
- **循环停掉，效果自己按固定步长推。** llvmpipe 上这一页 3-4 fps，从活循环里采一个 0.4 s 的
  效果是在抽奖，而两次抽奖之间没有可比性。探针 `g.stop()` 之后手推 15 × 1/60 s，
  于是 11 个 key 拍到的是**同一个相位**。
- **画质档位钉住。** `autoQuality` 在 llvmpipe 上一定落到 `low`，而 `Vfx.setQuality('low')`
  把每个效果的粒子数乘 0.35。钉 `high` 这一步必须在**藏世界之前**做，因为
  `_applyQuality` 会把地形块丢掉重建——反过来的顺序会把刚刚变可见的地形塞回一张本该全黑的帧。

### 「画了光」和「画的不是兜底」得同时问

两个方向，因为任何一条单独都能被一种缺陷通过：

- 只问「和 `default` 不一样」→ 一个**空的 case 体**照样通过：`default` 那团光球的
  七万个像素全都「不一样」，于是一个什么都不画的反应是绿的。
- 只问「画了东西」→ 掉进 `default` 的 key 通过，也就是这一轮修的那个 bug。

而「画了东西」要减掉的不是黑帧：`reaction: null` 的那一帧里，打敌人那一支照样有
`vfx.hit` 的火花（7 129 px），打玩家那一支照样有护盾壳（39 250 px 暗像素）。
所以控制组叫 **plain hit**（同一个 payload，只摘掉 reaction），文件名也按它**含有**什么起，
不按它缺什么起。减掉它之后剩下的就是这次反应自己的光：最少的是结晶 13 683 px，
门线 800 px 在它下面 17 倍。

顺带被这一节抓住的还有探针自己的一个洞：第一版把来袭元素写成了 `'hydro'`——那是原神的叫法，
这个游戏里是 `water/ice/fire/lightning/wind/earth/light`。`elementColor` 对不认识的键
**不报错**，它安静地返回白色，于是所有「按元素着色」的分支都是在一个产品里永远不会出现的
颜色下拍的。现在这个元素是从 `ELEMENTS` 表里取的，而且有一条断言说它必须在表里。

还有一条把「差异是什么的函数」钉住的等式：**共用一个 case 的两个 key 必须逐位相同**
（蒸发/融化 0 px，扩散/绽放 0 px），**不共用的必须不同**（冻结/结晶 104 344 px）。
没有这一条，一个大差异也可能来自 key 本身（按 `kind` 取的颜色、按 key 取的偏移），
「和 default 不一样」就不再等于「它自己那一支跑了」。

玩家那一支拍的是**完全被护盾吃掉**的一次命中（`amount: 0, absorbed: 999`）——那是这一支里
最安静的真实路径（没有全屏红闪把帧洗白、没有受击硬直），而且它顺手把修法的**位置**钉住了：
如果有人把反应那一块挪进 `else`（没挡住）那一半，这一帧就会什么都拍不到。

### 声音：十一个反应六个声音

分辨的不是「哪两种元素」，而是「这一下发生了什么」：伤害被放大了（`reactAmp`，往上扫）、
炸了（`reactBoom`，低频塌下去）、麻了（`reactZap`，三颗随机高频爆点，断续的）、
冻住了（`reactFreeze`，往下停住 + 干净的高音三度）、碎了（`reactShatter`，硬起音、亮、
向上散开，故意不带 `shieldBreak` 底下那个塌下去的方波——碎的是敌人身上的冰，不是玩家的依靠）、
长出来了（`reactBloom`，软起音、五度堆叠）。六个都压在 0.1-0.2 的 gain 上：它们叠在
`hit` 上面播，要听得出来，但不能把自己触发的那一下打击盖掉。

`REACTION_SFX` 是一张查表，而查表的调用点**不含字面量**——`audio-check` 的调用点扫描认的是
`'([a-zA-Z0-9]+)'`，所以六个新 cue 会全部读成「没人要」。做法不是放宽扫描，而是给它一条
**挣来的**信用：只有当某个文件里真的出现 `sfx(REACTION_SFX[` 时，才把整张表的值记到那个文件
名下（`tools/audio-check.mjs` 的 `TABLES`）。删掉派发，六个 cue 同时失去信用。
另外一节按两个方向查这张表：每个反应都有声音、表里没有不存在的反应、每个反应音效都是声明过的
cue 和实现过的 case、每个 `react*` cue 都被某个反应用到，以及 `game.js` 里那两个派发点都在。

### 「逐位相同」是探针挣来的，不是天生的

第一轮跑出来两条红，都是 3-4 px：同一个 payload 拍两次差 3 px，共用一个 case 的扩散/绽放差 4 px。
两条都**可复现**（换一轮跑还是 3 和 4），所以不是噪声。差的像素也不是随机撒在画面上的：
一处是 x=540 上下三个像素，一处是 x=407 与 x=616 各两个——绕着画面中心镜像的一对，
即某个圆环外缘的左右两个切点，红通道差到 10 个 count。

先排掉的是几何：反应画在角色脚下、由机位拍，所以每一次比较的几何都是 `me` 与 `camera`
那六个数的函数。于是探针**每拍一张就记一次**这六个数，并断言全程没变（18 张全在
`-7 6.0628 8 -7 9.2817 1.3126`）——循环停了但 socket 没停，一条自己的快照到达就能把角色挪一毫米，
那是 2 m 光壳的**亚像素**位移，正好只在轮廓边缘掀起三四个像素。它没动，所以不是这个。

真正的原因是**池子的手递手顺序**：`MeshPool.clear()` 把活着的网格按**退休顺序**推回 `free`，
`take()` 从尾部弹，所以某一次光壳落在哪一个预建网格上，取决于此前所有捕获的历史；
`SparkField` 的 `cursor` 在 2 000 个槽里一直往前转，`clear()` 也故意不把它拨回去。
两者都会改变这些 **additive、depthWrite 关掉**的面到达 half-float target 的**顺序**，
而浮点加法不满足结合律——落到色调曲线暗端就是环缘上几个 count。这不是产品的问题
（真实游戏永远不会画两遍同一帧），是这个文件的问题，因为它每一条结论都是像素数，
其中两条要求**严格相等**。所以每次捕获前把池子恢复成规范状态（`cursor = 0`，`free` 按 `id` 排序），
之后两条红都变成 0 px，而且扩散与绽放连「和 default 差多少」都精确对齐到同一个数（71 548）。

### 验证

- `tools/react-check.mjs`：**134 passed, 0 failed**（`/tmp/react-check6.log`，
  34 张帧在 `/tmp/react-cam/`）。两个 target × 11 个反应 × 4 条（画了光 / 不是兜底 / 声音 / 名字）
  加上每个 target 的 6 条控制，以及档位/正午/隔离三条前提。
- **变异测试**（`/tmp/react-mutant.log`）：把 `case 'freeze'` 改回 `case 'frozen'`，
  **6 条红**——词表两条（`freeze` 没有 case、`frozen` 不是反应），照片四条，
  而照片那四条读的是 **0 px differ from default**：这正是「它掉进兜底了」这句话的像素形式。
  两个 target 各两条，说明玩家那一半也真的在拍。
- `tools/audio-check.mjs --no-browser`：**75 passed, 0 failed**（45 个 cue 全部在 sfx 总线上
  可闻）。变异测试：删掉 `freeze: 'reactFreeze'` → 「每个反应都有声音」红；
  把一个派发点换成字面量 → 「两支都通过表派发」红（1 call site）。
- `check-all` 加一行 `react-check`（`browser` 组，`art: true`，帧落到 run 目录），
  探针总数 59 → 60。
- **新探针自己先被老门禁抓了一次**：进套跑的第一遍里唯一的红是 `daylight-check` 的
  「每个量像素的探针都要钉住时刻」——它扫 `tools/` 里所有 `window.game` + `lib/png` 的文件，
  而 `react-check` 既没调 `setWorldTime` 也不在豁免表里（豁免是有代价的：必须证明自己把 canvas
  藏了）。修法是钉住正午并**断言钉住了**（`g.clock.label` = `12:00`，`pinned=true`），
  不是往豁免表里加一行：这一帧确实照不到太阳（无光照的 additive 面 + 纯黑底），
  但一条一行的前提，不该靠「我知道它无所谓」活着。
- 整套 `check-all`：**59/60 GREEN，3235 条断言，62 分钟**
  （`/tmp/check-all-20260909-025639/SUMMARY.md`），唯一的红就是上面那条 `daylight-check`；
  改完之后 `daylight-check` **154 passed, 0 failed**、`react-check` **134 passed, 0 failed**
  单跑复核过（`/tmp/daylight-after.log`、`/tmp/react-check6.log`）。

## 十七个招式画同一个圈：预告是一份可以兑现的承诺

`ATTACK_MOVES` 把每个招式的几何都写清楚了：半径从 2.2 m 到 8.0 m，龙尾扫是 137° 的扇形
（`arc: 2.4` rad），冲撞是 14-26 m/s 的直线，弹道最远 26 m。**服务器全都读**——
`resolveEnemyAttack` 按这些数判伤害。客户端画的是：

```js
const r = Math.max(1.6, (e.actor.def.hitbox?.r ?? 1) * 2.4);   // 十七个招式，一个圈
```

`hitbox.r` 是**生物**的碰撞半径，和招式无关。于是 2.4 m 的拳和 6 m 的地刺是同一张图，
风魔龙的四个招式（8 m 旋风、18 m 俯冲、26 m 羽暴、4 m 风牢）全都是同一个 4.8 m 的圈。
学会一个 boss 的招式，唯一的办法是每个招式都死一次。旁边还有一行
`this.emit('telegraph', …)`——**全仓没有任何 listener**。

### 一份几何，两个读者

新的 `shared/src/data/enemies.js#attackShape(mv, def)` 是这份几何的**唯一**描述，
返回五种形状之一：`disc` / `sector` / `lane` / `aim` / `ring`。
`resolveEnemyAttack` 和 `vfx.telegraph` 读的是同一个返回值，所以

> **画出来的边界就是判伤害的边界**：走出那条线，真的就不吃伤害。

关键是 `hit = radius + HIT_SLACK`（0.6 m，20 Hz tick 的容差）。伤害测的是 `hit`，
所以**轮廓也必须画在 `hit` 上**，不是画在 `radius` 上——否则那 0.6 m 就是白吃的。

顺带兑现了两个「写了没人读」的字段：

- `mv.range`：弹道原来是固定 `life = 4.0 s`，22 m/s 的 `tideLance` 写着 16 m 射程，
  实际带伤害飞了 88 m。改成 `life = range / speed`，由射程和速度**互相推出来**，
  实测 16.5 / 26.4 / 18.2 m（三发弹道，误差 ≤ 一个 tick）。
- `mv.shake`：四个招式写了震屏权重（slam 0.6、chargeRoll 0.5、divebomb 1.0），
  **一个读者都没有**。现在落地时按 `attackShape(...).hit` 做距离衰减
  （`hit` 之内满值，2× 处归零）——和音效的 rolloff 是同一个论证：一个营地在 110 m 外流进来，
  没有衰减就是整个分片的战斗贴着你的耳朵和镜头打。

### 贴地，因为最需要预告的招式都在斜坡上

decal 是 13×13 的网格，`telegraph()` 在生成时把每个顶点抬到 `world.heightAt` 上
（绝对 y，物体自身在 y=0），形状则在**片元着色器里按局部米数**画出来（`vP = position.xz`，
+z 是朝向）。所以一张网格能画五种形状，而 8 m 的圆盘铺在山坡上也不会把半边轮廓埋进土里——
埋掉的那半边，恰好是站在下坡的人要看的那半边。

写探针的时候发现了一个自己埋的雷：网格的边界原来正好取在 `hit` 上，
而轮廓是**跨在边界两侧**的（`1 - smoothstep(0, uEdge, abs(d))`），
于是整张图里最亮的那条线被网格自己的边裁掉了外侧一半；召唤环最惨——
它的亮带峰值在 `hit + RING_BAND`，比网格边界还远 0.9 m。修法是把网格按 `edge` 外扩，
并把这句话写成 `enemy-check` 的断言（`halfX === hit + edge`）。

### 那张「消费者注记」表本身在腐烂

`enemyGate.js` 的 `ENEMY_KEYS` / `MOVE_KEYS` 每个键都跟着一句「谁读它」——**纯散文，没人校验**。
逐条打开来看，14 条是错的：`arc` 记的是 `animator.js`（那里没有），
`shake` 记的是一个从来没写过的震屏，`range` 记的是 `def.attackRange` 做的决定，
还有几条指向不存在的函数和路径。现在这张表被机器读了：注记里的路径必须存在、
被指名的文件里必须有对这个键的**属性访问**（注释先剥掉）、`path#fn` 的 `fn(` 必须真的在那个文件里。
并且用一张**假表**做了变异测试——三条谎（死键、不存在的文件、不存在的函数）
要报出三种不同的错误形状，`lies.length === 3` 是不够的（少了一个文件会同时触发两条）。

### 验证

- `tools/enemy-check.mjs`：**74 passed, 0 failed**。含 17 个招式的形状 × 一致性、
  7 个圆盘招式在 `hit ± 0.05 m` 两侧的判定（`in true, out false`）、
  扇形的四个方位（内 / 边外 / 背后 / 超距）、三发弹道的射程、
  风魔龙四招四个不同面积（79.9 / 100.1 / 15.5 / 23.8 m²，旧圈是 23 m²）、
  斜坡上每个顶点贴地（最差 3.4e-7 m）、池子归还、未知形状返回 `null`。
- `tools/telegraph-check.mjs`（**新探针**，`/tmp/telegraph-run4.log`）：**43 passed, 0 failed**。
  藏掉世界、纯黑底、把相机放到形状正上方 40 m（`camera.up = (0,0,1)`），
  用 fov 反算出 20.5 px/m，再把 diff mask 的包围盒**换回米**：

  | 招式 | 形状 | 应画 | 实测 |
  | --- | --- | --- | --- |
  | basic | disc | 6.4×6.4 m | 6.3×6.3 |
  | slam | disc | 10.2×10.2 | 10.1×10.1 |
  | spikeField | disc | 13.9×13.9 | 13.9×13.8 |
  | cyclone | disc | 17.9×17.9 | 18.0×17.9 |
  | tailSweep | sector | 9.3×4.9 | 9.1×4.8 |
  | chargeRoll | lane | 6.8×29.2 | 7.0×29.8 |
  | tideLance | aim | 2.2×18.2 | 2.2×18.6 |
  | summonMinions | ring | 14.5×14.5 | 14.5×14.5 |

  加上「五种形状不是一种形状的五个尺寸」：扇形只覆盖同半径圆盘的 **40%**（`arc` 算出来是 38%），
  召唤环中心 **0.0% 亮**而同半径圆盘 **101.6%**（同一个矩形、同一台相机、两个方向都问），
  瞄准线只有 2.2 m 宽；再和旧的 `hitbox` 圈两头对比——旋风比它宽 1.9×，长枪比它窄 0.4×，
  一个数不可能同时做到这两件事。
- **变异测试**（`/tmp/telegraph-mutant.log`）：把那一行改回 `max(1.6, hitbox.r * 2.4)`，
  **23 条红**——源码两条、八个形状的尺寸和 uniform 各两条、
  以及「五种形状」那一整节（扇形变成同半径圆盘的 68%、召唤环中心 67% 亮、
  长枪 5.6 m 宽比旧圈还宽）。
- **地面的误差被算成预算，而不是假设**：第一版探针在离出生点 12-28 m 内找「最平的一块地」，
  用的是**以生物为中心**的方框——可 22 m 的冲撞直线是**朝前**铺开的，
  它脚下真实起伏 7.44 m，探针于是自己报了红（`±10.9% GROUND TOO ROUGH`）。
  改成按**所有形状真正覆盖的那块地**（x ±9、z −9…+26）打分、搜索半径放到 52 m，
  每一发再从 decal 自己的 169 个顶点读出脚下起伏，把
  `(|平面偏移| + 起伏/2) / 40 m` 当成这一发的容差；超过 8% 就 **SKIP 并把数写出来**，
  因为那时候地形对投影的干扰已经大于要找的缺陷。八发全部落在 0.14-2.16 m 起伏上，
  最后一条断言是「**被量到的形状数量**」（8/8），免得一节靠 SKIP 混成绿的。
- `tools/react-check.mjs` 复跑（`vfx.js` 动过）：**134 passed, 0 failed**；
  `daylight-check --no-browser`：**112 passed, 0 failed**，新探针在它扫到的 26 个像素探针里
  钉住了正午。`check-all` 加一行 `telegraph-check`（`browser` 组，`art: true`），
  探针总数 60 → 61。

## 你自己的攻击也是一份承诺：同一份几何，玩家这一侧

上一节把**怪物**的招式对齐了：`attackShape` 一份几何，`resolveEnemyAttack` 判它、
`vfx.telegraph` 画它。然后把同样的问题问玩家自己的攻击，答案更糟：

| 动作 | 服务器判的 | 客户端画的 |
| --- | --- | --- |
| 普攻 / 重击 | `weaponReach + 2.2 m` 的扇形，张角 `0.85π` | 一道 `weaponReach * 0.66` 宽的斜线弧 |
| 元素爆发 | 每个角色自己的 `burst.radius`（4.0 - 8.0 m） | 十四个角色，一个 **7 m** 的圈 |
| 穿刺技 | `(radius*0.6) × pierce` 的一条直线（最长 9 m） | 脚下一个 `radius` 的圆盘 |
| 自动靠近 | `attackReach + 目标碰撞半径` | `AUTO_ATTACK_SLACK`，一个私有常数 |

`weaponReach * 0.66` 是真正被扫到的那块地的**三分之一**：玩家一直在打自己看不见的范围，
或者更常见的——以为打得到，其实站在弧线里挨打。

### 一份几何，两个读者（玩家版）

`shared/src/data/characters.js#playerAttackShape(action, def)` 现在是**唯一**的描述，
返回和怪物那侧完全同构的 `{kind, radius, hit, arc?, length?}`：

```js
const sh = playerAttackShape(kind, def);                 // handleAttack 里
const targets = sweep(inst, entity, sh.hit, sh.arc ?? Math.PI * 2, aimYaw);
```

```js
this.vfx.strike(sh, this.x, this.z, Math.atan2(dir.x, dir.z), col, 0.2, heightAt, 0.5);
```

`MELEE_SLACK = 2.2` / `MELEE_ARC = 0.85π` 从 `actions.js` 搬到数据里，因为它们现在有两个读者；
`HIT_RANGE_SLACK` 和 `AUTO_ATTACK_SLACK` 两个私有常数删掉（`grep` 先确认零引用）。
`strike()` 和 `telegraph()` 共用同一个 `_decal()`——同一张贴地网格、同一个片元着色器，
差别只有时钟的方向：预告是**承诺**（`uFill` 从 0 长到 1），打击是**报告**（落地瞬间就是全尺寸，然后淡出）。
爆发的广播里 `radius` 也删了：客户端拿 `charId` 自己问 `playerAttackShape`，
「客户端猜一个半径」这件事不再可能。

### 加法混色没有上界

上一轮把这套画出来之后，`legible-check` 变红了。原因不在几何，在混色模式：
decal 是 `AdditiveBlending`，而它是全游戏**最大的一块加法表面**。

- 正午草地 `126,155,75` → `177,180,177`：绿被冲成灰。
- 23:00 一张 8 m 的水系圆盘 → `244,244,244`，铺满半个屏幕，
  比正午的阳光地面还亮；站在上面的怪物名牌只有 **1.44:1**（门线 3:1）。

改成 `NormalBlending` 只解决了一半：mix 的上界是**颜色本身**，而 0.38 的 alpha 在
**线性 HDR** 里混向一个满强度的色相，压在 0.006 的夜晚地面上，实测还是 luma **154**（世界是 20）。
所以内部改成**颜料**而不是光：

```glsl
float lit = max(uLight, 0.55);                                  // 白天用世界的天光，夜里有下限
vec3 col = mix(uColor * (0.30 + filled * 0.22), uColor * 1.35, outline) * lit;
```

`uColor * 0.30` 比任何被照亮的地面都暗，所以它**沾染**而不是**发光**：正午把草地压下去、
夜里把黑地抬起来一点，这正是颜料干的事；轮廓保留 1.35 的抬升，因为边界才是那句承诺。
`uLight` 是 `daylight()` 的 `day` 经 `0.16 + 0.84 * day` 而来——正午**恰好等于 1**，
所以仓里几百条钉在正午的像素门禁一个字节都不动。

还有一个只有探针会遇到、但玩家也会遇到的坑：`uLight` 原来只在**生成**时写一次。
`legible-check` 会 `g.stop()` 把循环停在预告的半途，于是 12:00 生成的那张圆盘
带着正午的亮度进了 23:00 的画面——名牌背后 luma **182.6**、**2.36:1**。
现在 `Vfx.applyDaylight` 把值写进 decal 池里**所有**材质（`free` 和 `live` 都写），
同一张圆盘在 23:00 的背景降到 **27.6**、**3.47:1**。

### 一个饱和了的读数看不见任何变化

`telegraph-check` 第 5 节问「扫掠是不是真的在长」，原来数的是超过 `A_TOL = 14` 的像素数。
换成 mix 之后内部的洗色**在 fill 0.12 时就已经超过 14**，于是两帧都饱和：
`63817 px → 64000 px`，仪器再也看不见要找的东西。改成量**亮度**——
在轮廓包围盒里对空帧取每通道最大差的均值：`67.4 → 157.2`（×2.33），
中间没有悬崖，测的也正是那句话（内部 alpha 从 0.14 走到 0.38）。

### 验证

- `tools/telegraph-check.mjs`：**87 passed, 0 failed**（上一轮 43 条 → 现在 87 条）。
  第 7 节按同一台正上方相机量玩家自己的动作，走的是产品自己的入口
  （普攻走 `me.attack`，法术走 `PLAYER_ACTION` 进 `_onPlayerAction`）：

  | 角色 · 动作 | 形状 | 应画 | 实测 |
  | --- | --- | --- | --- |
  | lyra 重击（`charged.spin`） | disc | 10.2×10.2 m | 10.0×10.1 |
  | volt 普攻 | sector | 12.1×6.1 | 11.9×6.0 |
  | volt 穿刺技 | lane | 4.1×13.1 | 4.0×13.1 |
  | kaelen 技能 | disc | 5.1×5.1 | 5.1×5.1 |
  | aurel 爆发（8 m） | disc | 16.7×16.7 | 16.8×16.7 |
  | nyx 爆发（4 m） | disc | 8.5×8.5 | 8.4×8.4 |
  | elira 技能 | disc | 7.6×7.6 | 7.6×7.6 |

  加上两头夹的几条：4 m 和 8 m 的爆发**不是同一张图**（8.4 vs 16.8 m），
  而旧的那**一个** 7 m 圈（14.0 m 宽）**对两个都是错的**；
  穿刺技是 4.0 m 宽 × 13.1 m 长的一条道，不是它原来画的 6.4 m 圆盘；
  一刀扫过同半径圆盘的 **42%**（`0.85π` 算出来 43%），剑的重击扫满整圈；
  纯弹道的技能（sylvi）**一张 decal 都不画**，同样是法器的 elira 画一张——
  「没有形状就没有边界」两个方向都问。
- 第 8 节是**新加的一节**，专门盯这次的混色缺陷：把世界放回来（`__tgHidden` 记的就是它藏掉的那些），
  同一张圆盘在 12:00 和 23:00 各拍一次，先要求**两个小时真的拍成了两个小时**
  （圆盘外的地面 133.5 → 10.8，不然整节 SKIP），再两头夹：

  | | 地面 | 内部 | 轮廓 |
  | --- | --- | --- | --- |
  | 12:00 | 137.8 | 152.5（Δ14.8） | 177.0 |
  | 23:00 | 19.8 | 78.2（Δ58.4） | 120.1 |

  「夜里的贴花不许比正午的阳光地面还亮」（78.2 < 133.5）、
  「地面还得透得出来」（两个小时都要有 Δ 且不许糊死）、
  「不许洗成灰」（夜里 `96,77,37`，通道差 59.1）、
  「轮廓仍然是最亮的部分」。加法混色那一版这四条会同时红。
- `tools/legible-check.mjs`：**28 passed, 0 failed**（修之前 26/2）。
  23:00 最差的一行是名牌的 `2.36:1` → 现在 `3.47:1`；37 行共享的场景亮度均值
  12:00 99.0 / 23:00 48.7（坏的那一版是 79.1）。
- `tools/char-check.mjs`：`charged.spin` 的消费者从 `world/actions.handleAttack` 挪到
  `data/characters.playerAttackShape`——这条注记表本来就要求「被指名的文件里必须真的读这个键」，
  重构之后它自己红了，这是它该干的事。它自我满足的那个洞见下一节。

## 两个门禁自己给自己发了绿灯：一张表能自证，一块底板能让一行字消失

同一轮里修的两条红，形状是同一个：**门禁的证据和门禁的主张住在同一个地方**，
于是主张自己就把证据凑齐了。两条都不是靠读代码看出来的，都是靠「让它红一次」看出来的。

**一、`char-check` 的键→消费者表：切掉声明块还不够。**
`charged.spin` 的消费者从 `world/actions.handleAttack` 挪进
`data/characters.playerAttackShape` 之后，`data/characters` 第一次成了「消费者模块」，
而这个模块**就是角色表本身**。`consumerProblem()` 干两件事：被指名的函数名要在文件里出现，
键名要在文件里出现。第二件事在这个模块上**永远不可能失败**——
`stamina`、`radius`、`spin` 这些叶子名，本来就作为**数据**写在上面几百行的角色卡里。
把 `KIT_FIELDS` 整块从源码里切掉（上一节做的）只堵住了「表自己提到自己」这一半，
键的那一半是**空的**：随便把哪个键指向 `data/characters.任意一个真函数`，都会绿。

发现它的方式很朴素：我给自我测试加的那条断言（用 `skill.buff.atkPct` 证明表被切掉了）
**自己红了**——因为 `atkPct` 也是这个文件里的数据（两个角色的 `buff` 和三个角色的
`ascensionStat` 都写着它），所以「只出现在表里」的前提是错的。一条为了证明扫描器有效
而写的断言，红出了扫描器真正的无效之处。

修法是把这个模块的键扫描**缩到被指名函数的函数体**里（`functionBody()` 做大括号配对）：

| 自我测试的分支 | 期望的回答 | 它证明了什么 |
| --- | --- | --- |
| `skill.notAKitKey` → `world/actions.handleSkill` | `notAKitKey unread in world/actions` | 键不存在会被报出来 |
| `skill.cd` → `world/actions.noSuchFunction` | `world/actions has no noSuchFunction` | 函数不存在会被报出来 |
| `skill.cd` → `nope/nope.x` | `unknown module nope/nope` | 模块名写错会被报出来 |
| `skill.cd` → `data/characters.liveStats` | `data/characters has no liveStats` | `liveStats` 在 `characters.js` 里**只**作为表的值出现，所以这条只有在表真被切掉时才成立 |
| `charged.stamina` → `data/characters.playerAttackShape` | `stamina unread in data/characters.playerAttackShape` | `stamina` 是这个文件里的数据、但不在那个函数体里，所以这条只有在扫描缩到函数体时才成立 |

**二、`legible-check` 的名牌等级：一块底板同时修好了对比度、也逃掉了检查。**
上一轮遗留的那条间断红是敌人名牌上的 10.5 px 「Lv.12」：
它和旁边 12 px 的名字用同一份 `--ink-halo`，但笔画细一圈，
阴影在它周围**积不起来**——正午草地上环里量到 `152,157,145`，名字量到 `106,117,91`，
两行对着同一条 3:1 的杠读出 `2.12:1` 和 `3.70:1`。只在世界亮的那一半失败，
这就是「间断红」的样子。修法不是再叠阴影，是让这行字**自带背景**：一块
`rgba(6,8,12,0.55)` 的小底板，左右各留 4 px（比探针的 `RING = 2` 宽），
让环取到的是底板而不是草地。NPC 没有等级，所以 `:empty` 要收起来，否则头顶会多一块 8 px 的黑斑。

底板确实把这行修好了——**但探针也不再量它了**。发现的那一步有一条豁免：
祖先链上任意一个 `background-color` 的 alpha ≥ 0.55 就算「坐在面板上，背后的画面不是它的问题」。
0.55 正好踩线，于是这一行**从被评分的集合里消失**，探针报 28/0，
而消失的正是刚刚失败的那一行。这是一次教科书式的「免费绿」。

| | 环（halo） | 场景亮度 | 比值 |
| --- | --- | --- | --- |
| 修之前（只有阴影） | 152,157,145 | 196.0 | **2.12:1**（红） |
| 底板 0.55 + 旧豁免 | — | — | **这一行根本没被评分** |
| 底板 0.55 + 新豁免 | 72,75,71 | 196.7 | **6.19:1** |
| 同一行在 23:00 | 33,34,37 | 84.4 | 10.59:1 |

豁免改成算**整条链的透光率**（`sceneLeak`：把每层背景的 `1 - alpha` 乘起来，
`backdrop-filter` 和 `background-image` 算作完全封死），只有透光 ≤ 15% 才豁免。
一块 0.5 的半透底板在 luma 220 的草地上仍然给字留了 luma 99 的背景——
那正是这条门禁存在的意义。并且给豁免配一条**必须被评分**的对照：
`[ctl:scrim]` 是一行淡字压在 0.5 底板上，它要是从评分集合里不见了，两条断言就红。

变异验证（`--leak 0.55` 把旧规则原样接回来）：

```
panel-exempt: … nm > span.lv(leak 0.45) nm > span.lv(leak 0.45) div(leak 0.5)
FAIL the panel exemption did not swallow a line on a half-transparent scrim — the scrim control was panel-exempt (leak 0.5)
FAIL every panel-exempt line really is behind a sealed backing — 27 exempt readings, worst leak 0.5 (bar 0.55)
legible-check: 28 passed, 2 failed
```

顺带一条读数：现在真正被豁免的 20 行读数，透光率**全是 0**（聊天面板、技能键位、
头像栏这些是实心底），也就是说 0.55 那道门**从来没有一个正当的使用者**，
只有我自己新加的那块底板走过去。

验证：`legible-check` **30 passed, 0 failed**（新增两条断言，最差的产品行
12:00 `span[ping]` 3.39:1 / 23:00 名牌 3.48:1）；`char-check` **26 passed, 0 failed**；
两条变异都按预期红（`--leak 0.55` → 2 红；`charged.spin` 指回 `world/actions` → 1 红）。
名牌被 5 个探针量过，改完 CSS 之后 `boss-check` 76/0、`mp-view` 43/0、`shield-ui` 37/0 都仍然绿。

## 两套 `check-all` 抢一个显示器：三条红全是误伤

跑全量验证的时候，一次后台启动**变成了两个进程**（相隔 46 秒，同一条命令被执行了两次），
两个都往同一个 `>` 重定向里写，两个都在驱动 `:99` 那一块显示器。
我是按错误的顺序读懂它的，这个顺序本身值得记下来：

1. 控制台的行开始**名字重复、内容缺失**——`GREEN solo-check   GREEN mp-view   RED mp-view  64s   RED mouse-check`。
   两个进程各自 `>` 截断同一个文件、各按自己的偏移量写，于是互相盖掉了。
2. 三条红：`mouse-check` 的「右键停下角色」读出 `goal null → null`，
   `death-check` 的「锁住的锚点会给提示」读出 `(no toast)`，
   还有一行标着 `RED mp-view`、而它自己的日志写着 `43 passed, 0 failed`。
   **一条红，如果它自己的日志和汇总行对不上，那要看的是跑测的那个东西，不是探针。**
3. `ps -ef | grep check-all` 看见两个 `tools/check-all.mjs`，
   `ls -l /proc/<pid>/fd/1` 看见两个都指着同一个日志文件——一条命令，两条各花了 23 分钟的废运行。

所以 `check-all` 现在**拒绝当第二份**。这条门禁有三个坑，我每个都先踩了一次：

- **只有后来的那份可以退出。** 第一版两份互相看见、两份都退出——一次谁都没跑的验证，
  比它要防的那次碰撞更糟。用年龄决胜负（`/proc/uptime` 减 `/proc/<pid>/stat` 的第 22 项），
  同一秒内则 pid 小的赢。
- **`pgrep -f` 会找到自己的壳。** 启动它的 `bash -c` 的命令行里就写着
  `node tools/check-all.mjs`，`-f` 一匹配就把自己的壳当成「已经有一份在跑」。
  改成走 `/proc`：`argv[0]` 必须是 `node`，且 `argv` 里必须有这个脚本。
- **真的去撞一次才算验过**：先起 A，等它跑到 40 秒，再前台起 B，
  读到 `exit 2` 和「pid 1817400 (40s in)」，然后确认 A 还在跑。

两条被误伤的断言顺手加固了——它们的红是碰撞造成的，不是产品的毛病，但那两个**准备步骤**本来就脆：

- `mouse-check` 第 5 节：「右键停下角色」原来把**准备**（先点地面下一个走路指令）
  和**断言**（右键把它取消掉）挤在一条 `check` 里，于是准备失败也会以产品的名义变红。
  现在准备自己占一行，`findGround` 换四个横向偏移重试，并且和第 1 节一样要求
  「点到的是 canvas 不是 HUD」；整帧真的没有可点的地面时两条都 SKIP。
- `death-check` 的锚点提示：toast 是 3.5 秒后自己删掉的 DOM，
  而那一行是在 `sleep(1500)` **加三帧**之后去 DOM 里找它的——
  在 llvmpipe 2 fps 上这三帧就超过两秒。改成开点之前先订阅 `game.on('toast')`，
  记录**说过什么**，而不是事后去看还剩什么（和 `puzzle-check` 同一个做法）。

## 那条红是 0.6% 抽中的：期望值不能写成「最可能的那个结果」

全量验证剩下的唯一一条红在 `wish-check` 的面板一节：

```
FAIL one pull snaps every injected row back to the server's own state
     — pity5 "0 / 90", 累计 "11", 当前 "0.60%"
```

这一行的用意是对的：它先往客户端塞一份假状态（`pity5 80 / total 120 / 双保底`），
再真的抽一发，要求面板把每一行都换成服务端自己的数——**塞进去的 80 不许留下来**。
错的是它把「服务端自己的数」写成了常量 `11 / 90`。

第 11 发抽到五星的概率是 0.6%，而抽到五星 `pity5` 就归零。
那一次就抽中了：相邻那条 PASS 写着 `✦星辉 2 → 12`（+10，正是一枚未满命五星的兑换），
面板打出的 `0 / 90` 和 `0.60%` 跟服务端完全一致——**一致的是产品，错的是断言**。
更难看的是，同一个坑二十行之上就已经补过了：十连那条
`...and 五星保底 moved with it` 早就写着 `hitFive ? 归零 : +10`，
注释里还写着「不然大约六次里会红一次」。单抽这条只是没照着抄。

改法：期望值从这一发**自己的结果**推出来。

```js
const backFive = /\br5\b/.test(back.cardChange[0]?.cls || '');
const wantBackPity  = backFive ? 0 : pityAfter + 1;
const wantBackTotal = String(Number(after.rows.total.text.replace(/[^0-9]/g, '')) + 1);
const wantBackRate  = `${(wishRate5({ rate: shown.rate5, pity: shown.pity5 }, wantBackPity + 1) * 100).toFixed(2)}%`;
```

`pityAfter` 是**注入之前**读到的真实计数，所以这条门禁没有变松：
两个推出来的数都远低于注入的那两个（`pity ≤ 11` vs `80`、`total 11` vs `120`），
补丁只要漏掉任何一行，那一行就还是 80 或 120，照样红。

### 变异测试（两个分支各一次）

- 把三元反过来（`backFive ? pityAfter + 1 : 0`）→ 红：
  `pity5 "3 / 90" want "0 / 90"`。顺带说明这一跑里十连**真的**出了五星
  （`pityAfter` = 2），十连那条靠 `hitFive` 过的，不是运气。
- 把 `backFive` 直接钉成 `true`，强制走五星分支 → 红：
  `pity5 "11 / 90" want "0 / 90" (a 5★ reset it), 累计 "11" want 11, 当前 "0.60%" want 0.60%`。
  这三个期望值和上面那条真红打出来的读数**逐字相同**——所以改完之后，那一次抽奖是绿的。
- 还原，`122 passed, 0 failed, 1 skipped`。

## 两座秘境没人有理由去：有门、有八层、有奖励箱，就是没有任何任务提到它们

一次逐项对照目标的清点里，最实在的一条缺口不是画面也不是功能，是**内容**：
六个场景里，`frostCavern`（冰封洞窟）和 `goldenHall`（黄金屋遗迹）两座秘境
有完整的地形、房间、敌人配置和终点宝箱，却没有**任何**任务的任何一个阶段提到过它们。
玩家能进，但游戏从来没给过一个进去的理由。

### 为什么它们没法自己招待任务

`offerableQuest()` 里有一条很早就成立的规则：**给任务的 NPC 必须站在任务自己的 `zone` 里**
（`zoneGateReport` 也在守它）。而这两座秘境的 `npcs` 是空的——秘境里不放人，这是设计，不是遗漏。
两条规则叠起来，结论就是「秘境永远不可能挂自己的支线」。

出路是 `questNav.js` 已经写好的东西：`enterZone` / `chamber` 这两种阶段的定位器
会顺着**目标场景的 `dungeon` POI** 回溯到它的母场景（`gateTo` / `elsewhere`），
所以任务可以由母场景的 NPC 交付、把人送进秘境。四条新任务的十二个阶段逐个跑 `questTarget()`，
两条送人进秘境的都拿到了 `via`：

```
sq_frost_relic   s1 enterZone frostCavern → zone frostCavern via dragonspine  hint「从龙脊雪山的冰封洞窟进入」
sq_golden_ledger s2 chamber goldenHall:3  → zone goldenHall  via liyue        hint「从璃月群峰的黄金屋遗迹进入」
```

### 第二波内容：支线/世界任务 6 → 10

| id | 类型 | 交付 | minLevel | 阶段 |
| --- | --- | --- | --- | --- |
| `wq_snow_supply` | 世界·雪线 | 龙脊雪山 explorer | 26 | 抵达星银矿洞 · 采薄荷 ×6 · 讨伐深渊法师 ×3 |
| `sq_frost_relic` | 传说·雪葬之都 | 龙脊雪山 explorer | 32 | 进入冰封洞窟 · 第 3 间房 · 华丽宝箱 ×1 |
| `wq_liyue_leyline` | 世界·地脉 | 璃月群峰 adeptus | 38 | 点亮古老的石灯 · 遗迹守卫 ×3 · 水晶块 ×6 |
| `sq_golden_ledger` | 传说·账本 | 璃月群峰 merchant | 55 | 进入黄金屋遗迹 · 第 3 间房 · 混沌核心 ×3 |

`ly_puzzle2`（古老的石灯）本来就在场景表里，只是四十多个 POI 里唯一没有任何任务指过的那一个——
这一波顺手把它接上了。奖励一律不手写：`extraRewards()` 拿 `nearestStory(minLevel)` 的一半，
所以它们自动骑在等级/冒险阶位那两条超线性曲线上，`questGateReport()` 会检查
「minLevel 更高的支线，报酬不许更低」：`16000 → 20000 → 20000 → 60000` 摩拉，单调。

### 写着写着差点做出一把开不了的锁

`sq_golden_ledger` 初稿写的是 lv 50。这两个数是两套互不相识的算术：

- 送任务看的是 `rankForLevel(minLevel) = max(1, ceil((level - 20) / 2))`，lv 50 → **阶位 15**；
- 秘境的门看的是 `zoneEntryRank(zone)`，黄金屋是 **18**。

也就是说，一个 lv 50 的号会被塞一张「进黄金屋」的任务单，然后在门口被 403 挡回来。
改成 lv 55（正好 rank 18）能解决这一条，但这种「两个常数默默耦合」的坑值得变成门禁，
所以 `zoneGateReport()` 里加了两条：

1. **每座场景都得有人提到它**：把所有任务的 `zone`、`enterZone` 的 target、
   `chamber` 的 `zone:floor` 前缀收成一个集合，场景表里不在这个集合里的，报
   「no quest happens here and no stage sends anyone here」；反方向也查——
   阶段指了一个不存在的场景 id，同样报。
2. **送人去的门，接任务的时候就得开得了**：支线/世界任务的
   `rankForLevel(minLevel)` 必须 ≥ 目的地的 `entryRank`。主线豁免，因为主线是靠
   `next` 一条条给的，`minLevel` 只是建议——注释里把这个豁免和它的理由都写下来了。

### 门禁自己的对价

新门禁在现有数据上是干净的，而「干净」什么也证明不了，所以两条都通过
`zoneGateReport({ zones })` 这个注入口做了变异测试，落在 `tools/api-check.mjs` 里：

```
ok  a zone no quest ever mentions is reported
    ghostVale: no quest happens here and no stage sends anyone here, so nothing in the game gives a player a reason to come
ok  an extra quest that sends the player through a door their rank cannot open is reported
    quest "sq_frost_relic" (lv 32 → rank 6) sends the player into frostCavern, whose door needs rank 90
```

第二条断言写的是 `>= 1` 而不是 `=== 1`：`sq_frost_relic` 有 `enterZone` 和 `chamber`
两个阶段都指向冰封洞窟，同一个问题会被报两次。这不是缺陷，但把它写成 `=== 1`
就会在下一次有人加第三个阶段的时候变成一条假红。

### 验证

`api-check` 294 / 0（含上面两条新的变异断言）、`balance-check` 32 / 0、
`quest-check` 15 / 0、`questnav-check` 77 / 0（逐个阶段枚举定位器）、
`questend-check` 56 / 0（逐个任务枚举结局卡）。任务总数 24、阶段总数 59。

然后是这棵代码树上的一次完整全量：**`61/61 GREEN · 3508 assertions · 0 not green`**
（`/tmp/check-all-20260909-101859/SUMMARY.md`）。上一次全量是在两套 `check-all` 抢显示器
那一节之后跑的，这一次是在四条新任务、两条新门禁都进去以后重新挣的。

## 帮朋友打了一管血，一分钱没拿到：最后一刀是唯一的收据

多人这一侧逐项清点下来，最难看的一条不是同步，是**分账**。
`onEnemyKilled(enemy, byPlayer)` 从第一天就只认 `byPlayer`——也就是**打出最后一刀的那个人**。
两个人围着一个遗迹守卫打，一个人把它从满血砸到 1%，另一个人轻轻补一刀：
经验、掉落、摩拉、「讨伐丘丘人 ×3」的计数，全归补刀的那个。
出力的那个连一行掉落播报都没有。合作打怪在这种规则下是纯做慈善。

### 账本早就在那儿，只是没人当收据用

不需要新表、也不需要看队伍名单（看队伍就会给挂机的人发钱）。
`Enemy.takeDamage(amount, sourceId, now, element)` 为了仇恨已经在写一张
`threat: Map<playerId, damage>`——**谁打了、打了多少，逐笔都在里面**。
分账就是在这张账本上做一次查询：

```js
killCredit(enemy, byPlayer) {
  const paid = [];
  if (byPlayer) paid.push(byPlayer);            // 补刀的人一定拿（也覆盖 byPlayer=null 的坠落/环境击杀）
  for (const [pid, dmg] of enemy.threat || []) {
    if (!(dmg > 0)) continue;                   // 挂零的不算
    const p = this.players.get(Number(pid));
    if (!p || paid.includes(p)) continue;
    if (Math.hypot(p.x - enemy.x, p.z - enemy.z) > ASSIST_RADIUS) continue;  // 打完就跑的不算
    paid.push(p);
  }
  return paid;
}
```

`ASSIST_RADIUS = 45` 不是随手挑的：`AOI_RADIUS` 是 130 m，那是「你能**看见**」的距离，
拿它当分账半径等于全屏白拿；45 m 是「你还在这场架里」。

发钱的策略照原神：**每个人独立掉落**（各自 `rollEnemyLoot`，不是分一份），
经验、摩拉、任务计数全额；但**「击败」类被动只给补刀的人**，`kills++` 也只给他，
排行榜那一列 `kills: assist ? 0 : 1`——击杀榜问的问题就是「谁收的尾」。

### 探针抓到的其实是一根少焊了一脚的线

`shared` 这侧改完，`enemy-check` 九条断言全绿，看着就完事了。
接上真网关跑 `mp-check`，助战方的 LOOT 里 `assist=undefined`。原因在 `manager.hooks()`：

```js
- onKill: (inst, player, enemy, loot) => this.handleKill(inst, player, enemy, loot),
+ onKill: (...args) => this.handleKill(...args),                // 一个 hook 就是一根线
```

这个包装函数把形参一个一个列了出来，于是 sim 新加的第五个参数 `{ assist }`
被**静默丢掉**：助战方照样收到钱，但永远不知道为什么。
一个只转发的包装器列出形参，就是给自己埋一颗只在加参数那天引爆的雷。

### 三层验证，每一层都先变异成红的

| 层 | 文件 | 它能证明、别人证明不了的事 |
| --- | --- | --- |
| 进程内（9 条） | `tools/enemy-check.mjs` §10 | 走开的助战、一刀没砍的旁观者、`byPlayer=null`——这些状态用 socket 造不出来 |
| 真网关两个 socket（5 条） | `tools/mp-check.mjs` | 网关真的付了第二份：第二次 `grantKillRewards`、第二条 LOOT、带 `assist` |
| 浏览器（2 条） | `tools/mp-view.mjs` | 「助战」这两个字真的画到了屏幕上 |

`mp-check` 这一段里没有任何一条断言压「B 负责补刀」——那是两个 0.24 s 冷却之间的赛跑。
杀手和助战是**从结果里反推的**：`ENEMY_DIED.by` 指谁谁就是杀手，另一个就是助战，
所以两种结局落在同一条断言上。同理，敌人的方向每一次挥砍都重新算一遍
（它一直在朝仇恨目标走），候选敌人按 `e.a === 1 && e.lv <= 8` 过滤——
蒙德同一个场景里既有 lv 3 的史莱姆也有 lv 14 的遗迹守卫，后者能耗死两个 lv 1 的客人。

四次变异，四种不同的红：

```
MUT1  只付 byPlayer          → 「一具尸体付两个人」红；helper 那一路全部消失
MUT2  ASSIST_RADIUS 45 → 8   → 「留在圈里的助战照付」红
MUT3  无视 threat（给全屏）    → 「一刀没砍的旁观者不给钱」红、「走开的不给钱」红
MUT4  HUD 去掉「助战 」前缀    → mp-view 的「助战字样出现」红（另一半「不该出现时不出现」保持绿）
```

MUT1 顺手还改进了探针本身：`paid[0].loot !== paid[1].loot` 在变异下抛
`Cannot read properties of undefined`，把 §10 后面四条一起带走了——
先判 `paid.length === 2 &&` 才是一条**在变异下也只红自己那一条**的断言。

### 验证

`enemy-check` 83 / 0（新增 §10 九条）、`mp-check` 35 / 0
（`killer 2256: assist=undefined / helper: assist=true`，助战方 `48 xp, {"mora":80}`）、
`mp-view` 45 / 0（`助战 获得 摩拉 ×7`），
以及改动落地后重新挣的一次完整全量：**`61/61 GREEN · 3524 assertions · 0 not green`**
（`/tmp/check-all-20260909-113633/SUMMARY.md`，63 分钟）。
断言总数比上一节的 3508 多出的 16 条，正好是这一轮新加的 9 + 5 + 2。

## 探索度：一个百分比不是一个计数器，是一次查询

「这个区域我探到多少了」是开放世界最基本的一句反馈，而这个游戏里一直没有。
更麻烦的是它**很容易做错**：一眼看过去的做法是给存档加一个 `explored` 计数器，
每开一个宝箱 +1。那样一来，「涨了多少」这件事就有了第二个真相来源——
数据库里躺着九行 `world_progress`，存档里躺着一个数字，两者第一次不一致就再也回不去了
（补发过的奖励、回滚过的事务、老账号根本没有那个字段）。

所以 `shared/data/exploration.js` 里没有任何新状态。三条路线从第一版起就在写行：

| 类型 | 行的形状 | 谁写的 |
| --- | --- | --- |
| 锚点 / 神像 / 篝火 | `{unlocked:true}` | `POST /api/world/unlock` |
| 宝箱 | `{opened:true}` | `POST /api/world/chest` |
| 谜题 | `{solved:true}`（单块石碑是 `p:<id>` `{lit}`，**不算**） | `POST /api/world/puzzle` |

探索度就是在这些行上做一次查询，`EXPLORE_TYPES` 是那张对照表。
好处不是省了一个字段，而是三件顺带成立的事：**追溯生效**（老账号打开地图就有数字）、
**不可能漂移**、**不可能重复计数**（行本身就是幂等的收据，这也是 `data/achievements.js`
里「成就是一条阈值，阈值是一次查询」同一套道理）。判断类型看的是**载荷的形状**而不是键名：
`{opened}` 是宝箱、`{solved}` 是谜题、`{lit}` 是一块石碑、`{at}` 是采集点。

### 秘境不算探索度——因为「差一个宝箱」和「新账号白拿 50%」是同一个数

第一版 `explorationSummary` 把所有区域都算了进去，结果新账号一开地图就是
**「最高探索度 50%」**：秘境只有 1 个锚点 + 1 个奖励箱，入口锚点按定义免费，
1/2 = 50%。这个 50% 不是成就，是白给——`survey`（踏遍此地）的第一档正好是 50%。
所以 `EXPLORED_KINDS = new Set(['open'])`：秘境的进度是**层数与星数**（`chamber_records`），
不是探索度。`exploreGateReport()` 再从两侧把这件事钉住：

- `POI_PROPS`（POI 类型的词汇表）必须等于 `EXPLORE_TYPES ∪ UNCOUNTED_TYPES`，**双向**——
  新加一个 POI 类型，要么它进分子分母，要么它得在「不计入」里写明理由，
  不能悄悄把每个区域的百分比都拉低，也不能凭空消失；
- 每个开放区域至少要有 **5 个**可探索物，否则一个宝箱就是 20% 甚至 50%，
  这种粒度的百分比是在骗人。

新账号现在读到的是 11% / 11% / 12%（每个区域各 9 件，只有入口锚点是免费的），
第一档 50% 要真的走出去挣，最后一档 100% 又确实够得着（9 件里差一件就是 88%）。

### 拿的是同一个数：三个读者，一份推导

```
zoneExploration(zdef, zoneProg)   →  { pct, found, total, byType }
  ├─ client/src/ui/panels.js  地图区域行 22% / 页脚「探索度 22% (2/9) · 锚点 1/3 · 宝箱 1/4 …」
  ├─ server/src/routes/world.js  三条路线的回包里多一块 explore: { pct, gained, … }
  │                              → 客户端弹「探索度 22%（+11%）」/ 100% 时改成横幅「探索完成」
  └─ server/src/db/repo.js    achSnapshot 的 exploreBest / zonesExplored
                              → 成就 踏遍此地 [50,80,100] 与 大地的图册 [1,2,3]
```

地图上的钻石图标和这个百分比也不能各说各话：锚点算不算「找到了」走的是
`isAnchorUnlocked`（区域的默认锚点不需要行就能传送），页脚、区域行、图钉三处共用它。
`pct` 只在 `found === total` 时才是 100，其余一律 `Math.min(99, floor(...))`——
8/9 = 88.9% 不许四舍五入成 100%，因为 100% 是要发横幅的。

### 顺手撞出来的洞：`POST /api/world/unlock` 谁都能激活

写「谁是这行的写者」这张表的时候才发现，`unlock` 路线**根本没有类型过滤**。
它只按 `poiId` 找 POI，然后写 `{unlocked:true}`。于是：

- `POST /api/world/unlock {poiId:'mond_chest1'}` 花 5 原石**把这个宝箱废掉**——
  `chest` 路线开头问的是 `if (worldProgress[zone][poiId])`，于是它返回 409 `already_opened`，
  一箱子东西再也拿不到了；
- `achSnapshot` 数「七天神像的指引」时数的是 `{unlocked}` 行，
  所以拿宝箱、石碑、秘境门都能把那个成就刷上去。

两条后果都是**静默**的：没有报错，没有日志，玩家只会觉得「这个宝箱坏了」。
修法是失败关闭，并且用的就是上面那张表——不再写第二份类型清单：

```js
if (EXPLORE_TYPES[poi.type]?.writer !== 'POST /api/world/unlock') {
  return reply.code(409).send({ error: 'not_an_anchor', type: poi.type });
}
```

### 探针照到了一个从没被照过的画面：开宝箱

`shared`/`server` 这侧 21 条断言全绿之后去接客户端，才发现 `client/src/game/game.js` 里
`_openChest` 的最后两行是：

```js
this._reportLoot(res.loot, it);      // ← 这个方法在 client/src 里根本不存在
this._applyQuestUpdates(res.questUpdates);
```

`class Game` 不继承任何东西、没有 mixin，全仓 grep 只有这一处引用。
也就是说**每一次开宝箱都在 `_interact` 的 try 里抛 TypeError**：
弹一个红色的错误提示（东西其实已经到账了）、不播报任何掉落，
而且因为抛在中间，下一行 `_applyQuestUpdates` 永远不执行——
「开启宝箱」类任务的计数在客户端一直不动，直到别的东西把存档拉一遍。

44 个探针、一个 REST 级别的宝箱测试，全都是绿的：**服务器从头到尾都是对的，
只是没有任何一个探针照过「开宝箱」这个画面**。
`tools/explore-check.mjs` 现在照它，而且是用产品自己的输入路径：
鼠标点击 6 m 外的宝箱 → 走过去 → 到达时交互（和在射程内按 F 是两条不同的代码路径）。
补上的 `_reportLoot` 顺手把装备实例的命名收进 `shared/data/items.js` 的 `equipName()`：
背包面板原来是唯一一处会拼「角斗士的终幕礼·生之花」的地方，
而宝箱要播报一件五星圣遗物，也得会拼——两份拼法就是其中一份哪天打印出 `setId` 原文。
证据在日志里：`获得 🫧史莱姆凝液 ×2、💰摩拉 ×1308、🪶雷鸣的召唤·死之羽`。

### 变异测试：五次，五个不同的地方红

```
MUT1  把 _reportLoot 改名（复现原缺陷）  → 「开宝箱不该有错误提示」红：
                                          [{"text":"this._reportLoot is not a function","kind":"bad"}]
MUT2  弹窗里的百分比 +1（自己编一个数）   → 「弹的数就是行里的数」红：23% vs 行 2/9 = 22%
MUT3  去掉 .explore.full 的金色规则      → 「满探索是金色」红：rgb(242,234,214) ≠ --gold
MUT4  EXPLORED_KINDS 加回 dungeon        → 「新账号只探到一点点」红：11 11 12 50 33 50
MUT5  100% 不发横幅（退化成弹窗）         → 「探索完成用横幅播报」红 +「不该再弹一次探索度」红
```

MUT4 顺手暴露了探针自己的一个漏洞：`dungRows.every(...)` 在空列表上恒为真，
而 `dungeonZones` 是从 `EXPLORED_KINDS`——**正在被测的那个集合**——推出来的，
所以把秘境算进探索度会让「没有一个秘境行显示百分比」这条断言**因为无事可看而通过**。
当时救场的是另一条区间断言（新账号 ≤ 20%）。现在两条断言各自先要求自己那份名单非空，
这和 `no-outline-inside-a-silhouette`、`one-sided-controls-prove-nothing` 是同一个教训：
一条只往一个方向问的断言，在词汇表被改动时会先失效、再变绿。

「满探索是金色」这条也刻意不看 `classList`：`.full` 在的同时 CSS 规则可能根本没生效
（变量改名、选择器被压过），那时候玩家看到的和没探完的区域**长得一模一样**。
断言比的是 `getComputedStyle(...).color`，两侧都钉：
必须等于主题里的 `--gold`，且必须不等于同屏一个未完成区域的颜色。

### 验证

`api-check` 316 / 0（新增 22 条：涨幅、分类小计、409 `not_an_anchor` 且不扣钱不写行、
被拦下的宝箱照样能开、秘境返回 `explore: null`、88% 不进 100%、门禁四个分支）、
`explore-check` 36 / 0（浏览器，六张截图：11% → 22% → 88% → 100% 的地图面板）。

全量：**62 个探针 61 GREEN**（`/tmp/check-all-20260909-131245/SUMMARY.md`，63 分钟，
各行断言合计 3581，比上一节的 3524 多出 57 = api 的 22 + explore 的 36 − 下面那 1 条）。
唯一的红是 `questend-check` 自己的一条**静态**断言：它要求
`shared/data/items.js` 里不出现 `document|window`（意思是「共享数据不碰 DOM，能在 node 里测」），
而这一轮新加的 `equipName()` 注释里写了一句「每件装备是一份带着自己词条的 document」——
比对的是原文而不是去注释后的代码，于是一句散文把探针弄红了。
修的是探针（改成 `nocomment(code.items)`，并把这段经历写在断言旁边：
**声明是关于代码的，散文不是代码**，否则下一个人学到的是「注释要写得更含糊」），
单独重跑 `questend-check` **56 / 0**。

## 探索度要付钱：一条百分比的奖励，只允许多存一个数

上一节把 `pct` 做成了一次查询。但**走完一整个区域到底能得到什么**？
在这一轮之前的答案是：几乎什么都没有。探索度只通过两个**全局**成就付钱——
`survey`（踏遍此地，读的是**最高**那一个区域）与 `atlas`（大地的图册，数**完成了几个**区域）：

| 玩家做的事 | 探索度这条线付的钱 |
| --- | --- |
| 走完第一个区域（9 件） | survey 三档全清 + atlas 第一档 |
| 走完第二个区域（9 件） | atlas 第二档；survey 一分不涨（最高还是 100%） |
| 把第二个区域从 11% 走到 88% | **零** |
| 把第三个区域从 12% 走到 88% | **零** |

同样的路、同样的箱子、同样的谜题，第二遍开始不给钱。
这是 `constants-on-superlinear-curves` 那条教训的反面：**奖励没有用曲线本身计价**，
于是曲线一涨到头，后面的努力就没有计价单位了。

### 定价只有一句话：「走完一个地区的探索度 = 付这个地区宝箱那一份」

不再发明一张奖励表——那样就有了第二个需要维护的常数，而且第一次加区域就会忘。
一个区域的探索度值多少，由**这个区域自己的宝箱**说：

```js
zoneChestValue(zdef)   // Σ 该区域 chest 的 CHEST_TIERS 档位：mora 取区间中点，原石按面值
milestoneRewards(zdef) // 按 阈值/Σ阈值 分给 [20,40,60,80,100] 五档
```

蒙德平原 = 21,250 摩拉 / 17 原石，于是五档是
`20%:1,417/1 · 40%:2,833/2 · 60%:4,250/4 · 80%:5,667/4 · 100%:7,083/6`；
龙脊雪山 14,300/12，璃月港 17,250/15。走完一个区域等于**再开一遍这个区域的所有宝箱**——
一句能背下来的定价，比五个手写常数经得住加区域。

**分配必须累进取整。**第一版把每档的份额各自 `Math.round`，17 原石的五份加起来是 15——
少的那 2 个不会报错，只会永远不到账。正确做法是对**累计值**取整再作差：

```js
const upToMora = Math.round((total.mora * cum) / denom);  // cum = 已累计阈值
out.push({ pct, rewards: { mora: upToMora - paidMora, … } });
```

这样对任意阈值表都精确到最后一枚原石，而且 `exploreGateReport()` 和两个探针都在断言
**Σ 五档 === `zoneChestValue`**（原文见 `parts-must-sum-to-the-whole`）。

**最低一档必须高于「白给」的那个数。**新账号进区域，默认锚点不需要行就算找到，
所以一开地图就是 11% / 11% / 12%。第一档如果定 10%，那就是登录礼包。
门禁不相信这段注释，它**去算**：`zoneExploration(zdef, {})` 的结果必须严格小于
`milestones[0]`——数据变了它自己会红。

### 只多存一个数：`x:explore` 是一行 `world_progress`

探索度本身没有状态，奖励却必须记住「付到哪一档了」。这一个数存成**同一张表里的一行**：

```
world_progress(player_id, zone, key='x:explore', value={"pct":80})
```

没有迁移、没有新表、没有新的线上格式（`loadPlayer` / `publicPlayer` 原样带过来），
而且**追溯生效**：这一轮之前的老存档打开地图就能一次领到 80%。
防重复只有一句 SQL——`repo.claimExploreMilestone` 里那个**带 WHERE 的 UPDATE**：

```sql
ON CONFLICT (player_id,zone,key) DO UPDATE
  SET value = jsonb_build_object('pct', $4::int), at = now()
  WHERE COALESCE((world_progress.value->>'pct')::int, -1) < $4::int
```

返回空行就是「没轮到你」，路线回 409 `already_claimed`。
它刻意**不**走 `saveWorldProgress`（那个无条件覆盖，等于退款重领）。
两个并发请求打同一个区域：`200/409`，purse 只涨一次——和 `dedupe-rows-are-receipts`、
`spend-after-asking` 同一套门。

### 一行新键要过三个读者，而三个读者认行的方式各不相同

这是这一轮真正需要动脑的地方：`world_progress` 已经有三个读者，
它们**判断一行是什么**用的是三种完全不同的依据。

| 读者 | 怎么认 | `x:explore` 为什么隐形 |
| --- | --- | --- |
| `zoneExploration` / `isFound` | 按**作者写下的 POI id** 取 | 多出来的键根本索引不到 |
| `repo.achSnapshot` | 按**载荷形状**（`{opened}` `{unlocked}` `{solved}` `{lit}`） | `{pct}` 不匹配任何计数器 |
| `client/game/world.js applyProgress` | 按**键前缀**（`p:` 石碑、`g:` 采集点） | ← 只有这个需要显式跳过 |

第三个必须显式写 `if (poiId.startsWith('x:')) continue;`：
让它掉进 `poiById → null` 也「能跑」，但那条路径同时也是**POI id 写错**的样子，
于是两种情况再也分不开。断言写在消费者这一侧而不是写者这一侧：
领完之后 `found/total` 必须没变、四个成就计数器必须没动。

### 是「领取」，不是自动发；一次按键结清所有欠着的档

自动发会有第二个真相来源（发的时候玩家不在线怎么办、老存档怎么补），
所以做成按钮。而**梯子是一条水位线、不是一个队列**：89% 欠 20/40/60/80 四档，
一次按下全部结清（分四次按是同样的钱，但会让玩家以为丢了一档）。
按钮两个状态都要有信息：

```
可领：  领取探索奖励 ×4 · 摩拉 ×14,167 · 原石 ×11
不可领：下一档 100% · 摩拉 ×7,083 · 原石 ×6      ← disabled，但仍然在报价
领完了：探索奖励已全部领取
```

hover 出整条梯子（`20% … ✓ / 40% … ✓ / 100% … ←可领取`），
所以玩家在走之前就知道这趟值多少钱。

### 颜色不是消息：🎁 在文字里，而青色必须不等于金色

区域行的做法抄的是 `assert-style-not-class` 与 `ink-against-its-own-halo` 的教训：

- 有奖可领时，`22%` 变成 `22% 🎁`——**符号在 `textContent` 里**，
  颜色只是加强。只靠颜色的提示，在截图里和在色弱玩家眼里都是不存在的；
- 颜色用 `.ready`（`--accent` 青）而不是复用 `.full`（`--gold` 金）。
  因为 **100% 但最后一档没领** 的那一行**同时带着两个 class**：
  如果两者同色，全游戏最大的一笔奖励，恰好在唯一有它的那个区域上是隐形的。
  探针在那一帧同时钉三件事：`row.full === true`、`color === --accent`、`color !== --gold`。

三处播报也都从 `explore.claimable` 推出来，而不是各写一遍文案：
弹窗（`探索度 22%（+11%） · 探索奖励可领取（M 键 → 领取）`）、
100% 的横幅（同一句尾巴）、地图区域行的 🎁。
`MUT6` 专门证明这两条分支是**各自独立**被钉住的：只把横幅那一句删掉，
只有「100% 横幅也说了有奖励在等」这一条红，弹窗那条照旧绿。

### 变异测试：六次，六个不同的地方红

```
MUT1  .explore.ready 选择器改名（class 还在，像素不在）
        → 「有奖的区域是青色，没奖的不是」红：mondstadt rgba(242,234,214,.62) ≠ --accent
        → 「100% 未领是青色而不是金色」红：拿到的是 --gold rgb(232,197,106)
MUT2  去掉行文字里的 🎁（只留颜色）
        → 「有奖的行在文字里就有标记」红："22%"（ready 仍然是 1）
MUT3  每档按自己的权重计价（独立取整那个 bug 的形状）
        → 「整条梯子加起来等于该区域宝箱」红：Σ 7,083/6 vs 宝箱 21,250/17
        → 「整条梯子付了一个区域的宝箱」红（这条量的是真实钱包差）
MUT4  服务器只付最高那一档（标签仍然承诺四档）
        → 「钱包涨的正好是按钮上的和」红：+5,667/4 vs 14,167/11
        → 「弹窗列出了结清的档位」红（文案对、数字不对）
MUT5  disabled 的按钮不再报价
        → 「页脚在第一档能领之前就给它报价」红："下一档 20%"
        → 「按钮给还付不起的最后一档报价」红
MUT6  只从 100% 横幅里删掉奖励提示
        → 「100% 横幅也说了有奖励在等」红（弹窗那条仍绿 = 两条分支各自被钉）
```

MUT4 是这一组里最像真实事故的一个：**UI 承诺四档、服务器付一档**，
没有任何报错、没有任何 500，`took` 里还老老实实列着四个档位。
能抓住它的只有「钱包实际涨了多少」这一条断言——
`name-every-payer-in-a-delta` 的做法在这里是刚需：
最后那条总账刻意用**两次实测差之和**，而不是「最后余额 − 最初余额」，
因为中间还手开了一个宝箱，那笔掉落会混进同一个钱包。

### 奖励只在地图面板里，等于没有：HUD 上的那颗 🎁

上面这条梯子有三个出口——地图的区域行、地图页脚的按钮、过档时的那句弹窗。
前两个都**在面板里面**，第三个只活 3.5 秒。于是这条奖励对**第一个区域**是好的
（新手一路开箱，每过一档就有一句弹窗），对第二、第三个区域是隐形的：
把龙脊雪山走到 40% 的那个玩家，除非自己想起来再按一次 M，永远不会知道有钱在等着。
而第二、第三个区域**正是这条梯子当初被造出来的理由**——它修的就是「第二遍开始不给钱」。

所以 HUD 的货币行上多了一颗 🎁，和已有的 ✉（邮件）、★（成就）并排：

| 出口 | 什么时候看得见 | 说的是 |
| --- | --- | --- |
| 地图区域行 `22% 🎁` | 打开地图 | 这个区域欠着 |
| 地图页脚按钮 | 打开地图**并且**选中该区域 | 欠几档、值多少、能不能按 |
| 过档弹窗 / 100% 横幅 | 过档后那几秒 | 刚刚解锁了一档 |
| **HUD 的 🎁** | **所有面板都关着的时候** | **一共欠几档、最富的那个区域是谁** |

三条规则，都是仓库里已经在用的做法：

- **推导，不推送**：`exploreClaims(worldProgress)` 就地把每个区域的 `exploreClaim` 加起来，
  没有新事件、没有轮询、没有第二份状态。刷新挂在 `playerState` 上——`_applyPlayer`
  是每个 REST 写者都会走的那一行（`join-snapshot-is-not-live-state`）——
  **外加一次挂载时的写**（`state-ui-needs-a-mount-write`）：只挂事件的话，
  上次走到 44% 的存档登录进来看到的是一个空角落。
- **会带路的角标必须知道去哪**：邮件和成就各只有一个目的地，探索奖励是**按区域**的。
  点击带上 `zone`，而面板必须在 `open()` **之后**才应用它——`open()` 会把地图的选中项
  重置成玩家当前所在的区域（`panels.js` 的 `this._state.mapZone = g.zoneId`），
  先写就会被它覆盖，点击落在错误区域的页脚按钮上。
- **数的是档，不是区域**：一次登录看到 `4` 和看到 `1` 是两回事。
  颜色借地图行的青色（`--accent`），不发明第四种：三颗角标、三种颜色、三个目的地。

门禁也是同一条规则换了单位。`exploration.js` 的审计原来只有百分比那一头
（「一个区域一进去就白送一档」= `free >= milestones[0]`），现在多一句
**「一个没有任何 `world_progress` 行的存档不许欠任何一档」**——
同一件事，从玩家真正看得见的那颗角标这一头再说一遍。
这一句能用 `zones` 参数点燃（已有的 `arrival` 假区域把两头都点得亮），`api-check` 里点着。

这颗角标自己也过了一遍变异测试，七次，每次只让**该红的那一条**红：

```
MUT1  角标永不隐藏（'hidden', false）
        → 「什么都不欠的时候它是安静的」红：hiddenClass false / w 25
        （另外三处「领完就收起来」同时红 = 同一条规则的四个时刻）
MUT2  点击不带区域（_giftZone = null）
        → 「点角标把地图开在欠钱的那个区域」红：sel mondstadt
        （关于角标本身的断言全绿 = 这一条量的就是「带路」这件事）
MUT3  聚合按区域计数（rungs += 1）
        → 「数的是档，不是区域」红：n 1（应为 4）
MUT4  区域在 open() 之前应用
        → 同 MUT2 那一条红：sel mondstadt（这个顺序是承重的）
MUT5  角标沿用邮件的金色
        → 「它是地图行的青色，不是邮件的金色」红：gift = mail = rgb(232,197,106)
MUT6  提示里去掉区域名
        → 「角标点名了要去哪、值多少」红："22% · 1 档 · 摩拉 1,417 · 原石 1"
MUT7  删掉挂载时那次刷新（只留 playerState）
        → 只有「带着欠账登录时角标就在」红：n 0 w 0
        （会话内的每一条都绿——它们前面都刚好有一次 playerState）
```

MUT7 是这颗角标最可能真写错的样子，而**只有重登抓得到**：探针在最后把龙脊雪山推过第二档、
`p.reload()`、从「继续冒险」回来（模式按钮会重置成多人在线，得先点回单机），
在任何事件之前读那颗角标。

带路那条断言还需要一个**对照**，否则在蒙德是空的：地图本来就开在玩家站着的区域，
一颗根本不带 `zone` 的角标也会「看起来对」。所以探针先把蒙德整条梯子领完，
再用 REST 把龙脊雪山推过第一档（`/api/world/unlock` 没有等级门禁，这个 guest 是冒险等阶 1），
让「欠钱的区域 ≠ 站着的区域」，然后两头钉住：
`M 键 → 选中蒙德，页脚写「探索奖励已全部领取」`、
`点角标 → 选中龙脊雪山，页脚按钮亮着、报着 摩拉 ×953 · 原石 ×1`，再按下去钱包正好涨这么多。

### 验证

- `api-check` **347 / 0**（这一节的 24 条 + 角标的 7 条：新存档 0 档 / `best` 为空 / 不显示、
  蒙德满档 + 璃月推到第一档 = `6 rungs · mondstadt 100% ×5 · liyue 25% ×1` 且排序按钱多的在前、
  合计 `22,400 摩拉 / 18 原石` 等于两个区域各自的数之和、一个把每行都开了的秘境仍然只有 6 档
  且永远不在名单里、写上 `x:explore {pct:100}` 之后蒙德掉出名单（`best` 变成璃月）、
  两个都付掉 = 0 档 / `best` 为 null，以及门禁新那句「一个空存档不许欠任何一档」被点燃；
  原有 24 条：一次结清 20/40/60 且钱包真的动了、
  `x:explore` 写成 `{pct:60}` 而 `found/total` 不变、四个成就计数器都没动、
  第二次按 400 `nothing_to_claim` 且 `next === 80`、秘境 409 `no_exploration`、
  未知区域 400 `bad_zone`、并发两次 `200/409`、全领完之后 `paid===100 / next===null`，
  以及**按参数点燃**门禁的每一条新分支：梯子空/不升序/越界/末档不是 100、
  键前缀不合法、到达即达标的假区域、没有宝箱的区域、未定价的宝箱档位、
  POI id 撞上 `x:explore`）；
- `explore-check` **73 / 0**（浏览器，12 张截图：11% 报价 → 22% 出 🎁 → 88% 一次领四档 →
  100% 青色未领 → 领完变金 → 角标带路到龙脊雪山 → 重登之后角标还在）。
  36 → 56 是上面那条梯子（20 条，都在那六个变异下红过），
  56 → 73 是这颗角标（17 条，都在上面那七个变异下红过）。

全量：**62 个探针 62 GREEN**（`/tmp/check-all-20260909-164748/SUMMARY.md`，各行断言合计 3650，
比上一节那次的 3626 多出 24 = api 的 7 + explore 的 17）。
两轮都没有出现任何产品红。上一轮唯一改过的既有断言是 `explore-check` 里两条**被新 UI 作废**的
等值比较（22% 的弹窗现在还带着奖励提示；100% 的行在最后一档领掉之前是青色而不是金色），
它们不是变松，是搬到了正确的时刻——「满探索是金色」现在断言在**领完之后**那一帧。

## 三个秘境只装得下一个人：私有分片不等于独自一人

目标里写着「多人在线」，也写着「多个游戏场景和关卡」，而这两条在秘境上一直是互斥的。
`pickInstance` 见到 `kind === 'dungeon'` 就发私有分片——这是对的，没人希望陌生人走进
自己正打到一半的挑战——但 `JOIN_ZONE {follow}` 对**任何**私有分片一律答 `friend_is_solo`：

```js
if (String(tInst.shard).startsWith('p')) return fail('friend_is_solo');
```

于是深渊试炼场 8 层、冰封洞窟 3 层、黄金屋遗迹 3 层，一共 14 个关卡，**永远只装得下一个人**。
`world/manager.js` 里那个「给实例里每个玩家结算」的循环（`handleChamberClear`）写了很久，
它的第二个玩家从来没有出现过；`C2S.REVIVE` 那条「扶起队友」的消息在秘境里也没有存在的意义。
这一节把这条路打通，两个方向都钉住：**队友能跟进来，不是队友的好友仍然不能**。

### 一行 OR 里的两个 bug

```js
const solo = follow ? false : (world.solo.has(playerId) || zdef.kind === 'dungeon');
```

「这个玩家要单机」和「这个实例是私有的」是两个不同的问题，第二个问题 `pickInstance`
自己会答（它认得 `kind === 'dungeon'`）。把它们压进一个变量，代价是两处：

- `join()` 会把这个 `solo` 记进 `world.solo` 这个 Set，而且只在传 false 时才删。
  所以**进过一次秘境的账号，这一整个会话剩下的时间都待在开放世界的私有分片里**：
  好友一个都看不见，队友走到面前也不在快照里，而且没有任何提示——它长得就像联机坏了。
- `ZONE_STATE.mode` 报 `solo`，客户端 `this.mode = d.mode || this.mode` 把它锁住，
  于是客户端**自己**的联机 UI（邀请组队、前往Ta的世界、复活队友）也一起关掉了。

现在这一行只问玩家自己声明的模式（`world.solo.has(playerId)`），私有与否交给 `pickInstance`。

### 私有不等于独自：分片归**队长**

一个队伍必须落进同一个实例，否则「组队打秘境」这句话没有指代。分片名原来取
`[...this.parties.get(partyId)][0]`——一个 Set 的插入顺序，它只在队长没退过队的时候才等于队长。
现在队长是**记下来的**（`partyLeader: Map<partyId, playerId>`），
`privateShardOwner()` 一处回答「这个私有分片归谁」：在队里就归队长，声明了单机就归自己
（单机的模拟跑在他自己的浏览器里，他谁也招待不了）。
探针把这条钉成一句可以红的话：**让 B 先进秘境，分片名仍然必须是 `p{A}`**（A 是队长）。

`preferShard` 也从「公共分片专用」提到了最前面。它只由跟随那条路设置，而那条路已经检查过
谁有资格进去；如果私有分支抢在它前面自己算一个名字，跟队友进秘境就会开出**第二座一模一样的
空秘境**——两个人各自站在一个看起来完全正常的实例里。这条的门禁在下面「比队伍活得久」那一节。

### 「可跟随」是一个**和问的人有关**的属性

`/api/social/friends` 的 `joinable` 原来是 `!!pres && !pres.solo`，而 `pres.solo` 又是
`String(inst.shard).startsWith('p')`——两个不同的事实压成了一个字段。现在 presence 分开报：
`private`（分片是私有的）和 `solo`（这个玩家在单机）。`joinable` 于是不再是一行数据的属性，
而是一次**关于观察者**的判断：

```js
joinable: !!pres && !pres.solo && (!pres.private || (!!myParty && myParty === pres.party)),
```

同一个好友，队友看到「加入Ta的秘境」，别人看到「（秘境／单人世界）」且没有按钮。
网关那侧用的是同一条规则，两边必须同时成立：只改网关会留下一个玩家永远看不到的入口，
只改面板会留下一个按下去必被拒的按钮。所以探针在**同一次响应**里两头取值——
队友 B 的 `joinable === true`、同样在自己秘境里的好友 S 的 `joinable === false`，
再让 S 真的按一次 `follow`，必须收到 `friend_is_solo`。

### 一个 8 秒的自动站起，让「团灭」永远发生不了

`updateChamber` 的失败条件是「**每个**玩家都倒下」，而 `updatePlayer` 里有一条
「倒下 8 秒没人扶就送回锚点」。两个人打一场，先倒的那个总是在后倒的那个之前就已经
**在 52 m 外的入口站起来了**——`allDown` 结构上不可能成立，联机秘境唯一的输法是时间到。
（单机不受影响：一个人倒下就是全员倒下。）现在秘境跑动期间不自动站起：

```js
const inRun = this.chamber?.state === 'running';
if (!p.alive && !inRun && this.now - p.downedAt > AUTO_RESPAWN_SEC) this.respawnAtAnchor(p, { auto: true });
```

这同时把 `C2S.REVIVE` 变回有意义的东西：如果计时器免费发同样的东西，队友那只手就不值钱。
挑战结束（失败/通关）之后下一 tick 照常把人扶起来。
HUD 那行倒计时跟着改：秘境进行中它不再数「8 秒后自动返回锚点」——数一个不会发生的事，
和这块标签当初被重写掉的那个谎是同一个谎。

### 一场打输的挑战不清场

顺手照出来的一条：超时那支会 `enemies.clear()`，团灭那支不会。于是一队人在自己的秘境里被
灭掉、原地站起来（见上），面对的是**还活着的一整波**，而且除了离开区域没有任何办法重置。
现在两支的收尾一样。

### 分片的名字比开它的队伍活得久

队长退队之后 `leaveParty` 会把队长顺位交给剩下的人——那么一个**新**加入者算出来的分片名
（`p{新队长}`）就不再是队友正站着的那个实例了。这一段是探针可以构造出来的：
A（队长）和 B 在 `abyssTrial#pA` 里，A 退队并回蒙德，B 成为队长又把 A 邀回来，
A 跟随 B——落点必须还是 `abyssTrial#pA`，因为跟随走的是**从对方解析出来的** shard，
不是自己算出来的那个。同一段还抓到一条小的：`PARTY_LEAVE` 只回给退队的人，
留下的人名单里那一行（连着当时的区域和血量）会一直挂着，直到进程重启。
`broadcastPartyId(partyId)` 就是为这个存在的——退队的人已经查不到自己的队伍了。

### 变异测试：八次，八处

`/tmp/mut-coop.sh`，每次改一处服务端、重启、跑一遍 `mp-check`、还原、`diff -q` 验证还原：

| 变异 | 预期红 |
| --- | --- |
| M1 恢复 `if (true) return fail('friend_is_solo')` | **14 条**——整个功能不存在（连 `not_a_dungeon` 都冒出来了：A 的 `START_CHAMBER` 发在蒙德） |
| M2 `solo` 重新 OR 上 `kind === 'dungeon'` | **17 条**——比 M1 还多两条：`mode` 报 `solo`，而且分片归了先进来的人（`world.solo` 一被置上，`privateShardOwner` 就不再查队长） |
| M3 `privateShardOwner` 不查队长 | 「分片名按队长而不是先进来的人」 |
| M4 `joinable` 不看队伍 | 只有「队友可跟随」那一条 |
| M5 `joinable` 不看私有 | 只有「陌生人的秘境不可跟随」那一条 |
| M6 秘境里恢复 8 秒自动站起 | 「团灭要等所有人都倒下」 |
| M7 团灭不清场 | 「打输之后场地清空」 |
| M8 `preferShard` 让位给私有分支 | 「实例比开它的队伍活得久」+「不是两座一模一样的空秘境」（`p2560` vs `p2559`，第二座秘境有名有姓） |

M3/M4/M5/M6/M7 各只红**一条**，正好是它改的那件事；八次全部还原后 `diff -q` 干净。

### 验证

- `mp-check` **60 / 0**（这一轮从 35 条加到 60 条；新的一半全在联机秘境上）。
- 全量 `tools/check-all.mjs`：**62 / 62 GREEN · 3675 条断言 · 0 not green**
  （`api-check` 347、`mp-view` 45、`solo-check` 21、`chamber-check` 41 都没有回归——
  秘境的单机路径和 `POST /api/world/chamber` 的结算一个字没动）。
- 客户端两处文案（HUD 的倒计时行、好友面板的三态标签）跟着 `npm --prefix client run build`
  一起进了 `dist`；`social-check` 21 / 0 在浏览器里读的是新的那一份。

## 探针打不赢，所以没人验过分账：为了一条收据练出来的两个 40 级角色

上一节把两个人放进了同一座秘境，然后**输**给了它。那是真话，但只是一半：
`handleChamberClear`——`world/manager.js` 里那个走 `inst.players.values()`、
给实例里**每个**玩家各调一次 `grantChamberClear` 的循环——是联机秘境存在的理由，
而它从来没有在两个玩家在场的情况下跑过。

拦住它的不是代码，是数字。`abyssTrial` 的 `entryRank` 是 1，而它最浅的一层是 18 级
（丘丘人 1576 hp），`arCap(AR) = min(90, 20 + 2·AR)` 又把两个刚注册的 AR-1 游客锁在 22 级以下：
探针能构造的团灭是真的，能构造的通关不存在。于是「帮朋友打完一座秘境」这条路上，
唯一被证明过的事情是**没人拿到钱**。

### 给材料，不给等级

新增的 `POST /api/dev/supply`（和 `/api/dev/rank` 一样只在 `config.isDev` 下注册、开机打印一行）
只发**材料和摩拉**，一个等级都不写。账单是**推导**出来的，从玩家自己付钱的那几张表：
角色经验走 `xpForLevel`，突破材料走 `ASCENSION_COST`，武器经验走 `weaponXpToLevel`，
摩拉按两条升级路线各自的费率（0.2 / xp）。所以它铸不出成长路线不消耗的东西，
表一改账单跟着改。等级本身必须由探针自己花掉：

```
POST /api/dev/rank   {rank: 10}      → arCap 40
POST /api/dev/supply {level: 40}     → {slimeCondensate:6, crystalCore:6, heroWit:78, ironChunk:56, mora:363200}
POST /api/char/levelup  ×N  →  POST /api/char/ascend  →  POST /api/char/levelup
POST /api/inventory/weapon/levelup ×2
```

一条写 `level = 40` 的后门会省掉这十几次调用，也会藏掉下面这个 bug——纪律是有回报的：
**第一次跑这条路线时，一个账号的 78 本经验书只够练起一个角色**。

### 一次点击烧掉十九本大英雄的经验

`levelUpCharacter` 把 `materials` 里的东西**全部**倒进经验曲线，然后在上限处把结果一夹：

```js
if (level >= cap) xp = 0;      // 银行清零
```

角色面板那个按钮一次提供 `min(have, 20)` 本大英雄的经验（`ui/panels.js:489`）。
一个 19 级、离上限还差一级的角色按一下，就是 **40 万 xp 换 3 万** ——多出来的十九本
没有警告、没有回退、没有记录地消失。武器那条路线早就解决过同一个问题
（`no_usable_ore` 那一段是「便宜的先烧、只烧吃得下的、剩下的还在包里」），
角色这条——**包更大的那条**——没有。现在两条一样：

```js
let room = -(inst.xp || 0);
for (let l = inst.level; l < cap; l++) room += xpForLevel(l);
// 便宜的排前面：一次「整包」提交不能让大英雄的经验去付流浪者的经验付得起的那一级
const offered = Object.entries(materials || {}) … .sort((x, y) => x.xp - y.xp);
for (const o of offered) {
  if (xpGain >= room) break;
  const use = Math.min(o.count, have, Math.ceil((room - xpGain) / o.xp));
  …
}
```

`api-check` 现在按同样三条规则钉着它（上限、便宜的先花、吃不下的还在包里），
而且第三条断言就是当初的症状：**第二个角色还能用剩下的材料练起来**。
（不可避免的溢出仍然是一本——书是不可分的——上限以下它进 `inst.xp` 而不是消失。）

### 一场正在打的挑战，任何人都能重开

`startChamber` **本身就是重置**：清空场地、重生第一波、把 `startedAt` 重新对准现在。
地图面板的层列表在挑战进行中并不变灰，所以单机时一次误点就是自己 80 秒的进度作废；
联机时更糟——按下去的人不必是这场挑战的主人，任何队友都能扔掉队伍的第 80 秒，
而且他选的层数甚至不必是正在打的那一层。

```js
if (this.chamber?.state === 'running') {
  return { error: 'chamber_in_progress', floor: this.chamber.floor };
}
```

拒绝放在 sim 里而不是两个调用点（`gateway.js`、`localSocket.js`）里，因为两边都得记住它，
而浏览器那一份是没有别人会发现问题的那一份。两个调用点本来就是 `if (r.error) return fail(r.error)`，
所以只多了一句客户端文案：「挑战正在进行中，先打完这一层」。

### 打赢之前要先站起来、吃一口饭

团灭把两个人放倒，秘境跑动结束后下一 tick 才把人扶起来——`revive()` 给的是**当时**上限的一半。
接着探针把角色练到 40 级，`applyBuild` 的规矩是「在队里的人保留手上的血量，只换天花板」，
所以一个 4732 hp 的角色是带着 645 hp 走进第二场的。补血走的是 `C2S.USE_ITEM`
（starter 包里的甜甜花酿鸡），因为治疗量是战斗状态，REST 只能写存档，而运行中的实例下一 tick 就会盖掉它。
探针照着玩家的顺序做完这三件事，才有资格开第二场：

```
ok  both accounts bought their way to level 40 …  A chars 40,40 weapons 40,40 / B chars 40,40 weapons 40,40
ok  the live entities were rebuilt, so the levels reach the fight  A 1290→4732 hp (9 refreshes), B 1290→4732 (9)
ok  both are standing and fed before the run  A 4732/4732 al=1, B 4732/4732 al=1
```

第二条是必须的：等级涨在存档里不算涨，`publishStats → refreshBuild` 才是把新面板装进活实体的那扇门。
它有两份收据——每个 socket 收到的 `statsRefresh` 事件，和快照里那个所有客户端拿来画血条的上限。

### 通关分账的收据

28.2 秒、2★（3★ 的门线是 25 秒），然后是这一整节存在的理由：

| 断言 | A | B（全程没按过任何按钮） |
| --- | --- | --- |
| `CHAMBER {state:'reward'}` | 收到 | 收到 |
| 星数奖励 = `stars × 20` 原石 | 40 原石 / 10000 摩拉 | 40 原石 / 10000 摩拉 |
| 树脂**各付各的** 20 | spent 20 → left 140 | spent 20 → left 140 |
| 掉落**各滚各的** | `chaosDevice×3, chaosCore×3, adventurerXp×2` | `abyssalCrystal×2, adventurerXp×1` |
| 冒险阅历 | `adventureRank 10` | `adventureRank 10` |
| 存档 `abyss.abyssTrial.1` | `stars 2, bestTime 28.2` | `stars 2, bestTime 28.2` |
| 第二层可开 | — | **由 B 开出来** |

最后一行是这条路上唯一还能藏 bug 的地方：解锁条件读的是**请求者自己**的记录
（`save.abyss[zone][floor-1].stars > 0`）。这一节前面 A 的「第二层」是被拒绝的，
所以如果分账只付按按钮的人，B 的这一次请求就该还是 `previous_floor_locked`。
树脂那一行是同一件事的另一半：两个人一起通关，不能共用一次扣费（那样联机就是白刷），
也不能被扣两次。

### 「变小了」不等于「没有重开」

第一版的时钟断言写的是 `clockAfter < clockBefore`。M1 变异（把守卫拿掉）跑出来的那一行是：

```
FAIL …and the refusal left the clock and the wave alone  84.99s → 83.74s left, wave 3→3 entities
```

它红了，但**不是因为时钟**：一场在 85 秒被重开、6 秒后再读的挑战是 83.7 秒，也确实比 85 小。
真正抓住它的是波次的**身份**（`startChamber` 重生第一波，id 全换了），而波次的**数量**一样是 3。
所以这条断言改成量「时钟掉的秒数要和等待的墙上时间对得上」（重开会让差值远小于等待，甚至为负），
波次那半从「几个」改成「是不是同一批 id」。两个量都得对上才绿。

### 那条守卫先把一条老探针弄红了

加完守卫，全量套件里 `chamber-check` 立刻红了一条：`a floor with no disorder says so rather than
inventing one`。这不是产品 bug，是**探针**的 bug——它在同一个 instance 上、floor 2 还在跑的时候
直接 `inst.startChamber(1)`，靠的正是「开始就是重置」这个旧行为，于是它以为自己拍的是第一层，
实际拍到的是第二层的 `frostVein`。修法是给这条断言一个**自己的** arena（和自己的快照钩子），
顺手把守卫本身的四条断言补进去（拒绝 / 拒绝时不管请求的是哪一层 / 拒绝后时钟和波次原封不动 /
拒绝时不广播 `start`），再加一条反向的：**已经结束**的一层可以重新开始。`chamber-check` 46 / 0。

### 变异测试：五次，三处

`/tmp/mut-clear.sh`（要重启服务端）与 `/tmp/mut-chamber.sh`、`/tmp/mut-chamber2.sh`（纯 sim，不用服务端），
每次改一处、跑对应的探针、还原、`diff -q` 验证：

| 变异 | 预期红 | 实际 |
| --- | --- | --- |
| M1 秘境守卫改成 `if (false)`（一场挑战又能被重开） | `mp-check` 3 条重开断言 | **3 条**，其中时钟那条见上 |
| M1b 同一处，对着 `chamber-check` | 那 4 条新断言 | **4 条**；第二条拍下了真正的后果：跑第一层的时候要求开第二层，**第二层真的开了**（`frostVein`） |
| M2 `use = Math.min(o.count, have)`（恢复销毁经验书） | 3 条经验书断言 | **3 条**：花了 34 本、包里剩 0、第二个角色 `no_materials` |
| M3 `supply` 不夹 `arCap` | 只有账单那一条 | **1 条**：AR 4 要到了 90 级的账单（628 本书、335 万摩拉） |
| M4 守卫改成 `if (true)`（永远拒绝） | 反向那几条 | **不是 FAIL，是崩**：变异后的那一行自己就要读 `this.chamber.floor`，而空闲时 `chamber` 是 `null`，探针在第一次 `startChamber` 就抛 `TypeError` 退出（12 条 ok 之后中断，退出码非 0 —— 仍然是红，只是没有 FAIL 行） |
| M4' 守卫改成 `this.chamber && state !== 'running'`（只拦已结束的） | 4 条重开断言 | **4 条**（这才是 M4 想要的那个有效变异） |

M4 那一格是有用的：它说明「永远拒绝」这个方向没有一条**单独**的断言在守——守的是前面 12 条
每一条都要先开出一场挑战来。想给它一条专门的断言，就是那条「已经结束的一层可以重新开始」，
而它在 M4' 里被级联掩住了（守卫允许重开之后，第三块的挑战已经变成了 120 秒的第二层，还没超时）。
写下来，比假装五个变异都干净利落有用。

### 验证

- `mp-check` **74 / 0**（从 60 加到 74；新的十四条全在「打赢」那一侧）。
- `api-check` **354 / 0**（新增 7 条：supply 的鉴权/校验/账单/入包，加经验书那三条规则）。
- `chamber-check` **46 / 0**（新增 5 条：守卫的两侧；先红过一次，见上）。
- 全量 `tools/check-all.mjs`：**62 / 62 GREEN · 3701 条断言 · 0 不绿**
  （`/tmp/check-all-20260909-215135/SUMMARY.md`）。

## 一条规则，三个执法者，零个读者：秘境层数的锁

「第 N 层要先通过第 N-1 层」这条规则在仓库里写了**三遍**——`ws/gateway.js` 的
`START_CHAMBER`、`routes/world.js` 的 `POST /api/world/chamber`、单机的 `net/localSocket.js`——
而**读**它的地方是零个。地图面板里的「深境层数」列表把八层全部列出来、全部可点，
点第 8 层的结果是发一次请求、吃一个红 toast。上一轮给「重开」加的那道守卫又多了一条：
面板连「这一层正在打」都不知道，它会热情地邀请你把自己的挑战重置掉。

### 规则搬到 `shared`，四个读者读同一份

`shared/src/data/zones.js` 新增 `chamberEntry(zone, floor, ctx)`，返回
`{ ok }` 或 `{ ok: false, error, … }`，`error` 就是服务端本来会回的那个 code：

| 判定 | code | 附带 |
| --- | --- | --- |
| 不是秘境 / 没有这一层 | `not_a_dungeon` / `no_such_chamber` | — |
| 冒险等阶不够 | `rank_too_low` | `need`（`zoneEntryRank`） |
| 上一层没有星 | `previous_floor_locked` | `prevFloor` |
| 这个实例正在打 | `chamber_in_progress` | `runningFloor` |

顺序是有意义的：**先报最先撞上的那一个**，因为那才是玩家能动手解决的那一个。
一个 AR 1 的旅客站在 AR 18 的秘境门口，告诉他「先过第 3 层」是没用的。
`ctx` 是三段可选的上下文（`adventureRank` / `abyss` / `chamber`），**谁看不见就不传**：
REST 路由看不见活着的实例，就不传 `chamber`，于是它永远不会替一场跑在别人浏览器里的
挑战说话；面板只在「这张地图正是我站着的区域」时才传。

三个执法者各自的两三行内联判断被同一次调用替掉，服务端行为一字不改（`api-check` 的
四条 code 断言就是钉这个的，其中 `not_a_dungeon` 是这轮补的：对着蒙德平原要一层，
从前的回答是 `no_such_chamber`）。

### 第四个读者是面板

同一个 `chamberEntry`，现在也是「深境层数」每一行的渲染依据：锁住的行前面挂 🔒、
整行 45% 透明（`dim`）、`title` 是服务端那句原话（`rank_too_low` 还补上「（需要 N 阶）」），
正在打的那一层写「· 进行中」而**不**挂锁。点击也在本地就拒绝掉——用 `errorText` 取同一句话，
**并且不关面板**：玩家还在选层，把面板关掉再弹一个红字是两次惩罚。

🔒 放在标题**前面**是拍完截图才定的：这些标题（`第 2 间 · 凝霜地脉`）在 234 px 宽的
侧栏里会换行，尾随的锁被挤到第二行，看起来像是下一行的项目符号。

### 顺手撞出来的洞：进秘境的唯一入口在折叠线以下

这是第一次有探针去**驱动**这个列表（`chamber-ui` 从前直接调 `game.startChamber`），
第一张截图就说明了为什么要驱动：侧栏是一个没有任何滚动提示的 `overflow` 盒子，
六行「区域」列表把它填满了，「深境层数」整节——**八行全部**——在盒子底下。
进秘境的唯一入口，在默认视图里一行都看不见。

修法在产品里：有层数的时候，层数列表排在区域列表**前面**。
探针里也修了一处：第一版的可见性判断量的是**视口**，一个被侧栏裁掉、却还落在视口里的行
被判成「可见」，于是那一次点击落在面板之外、把面板关掉了，37 条断言级联红成一片，
而真正的原因只有一行。现在 `visible` 是拿行的 rect 和**滚动容器**的 rect 相交出来的，
并且多了一条断言：不滚动至少能看见 3 行。

### 「暗下来」要能在像素里看见

第一版用的是 `muted`（只给标题染 50% alpha 的米色）。在这块深蓝面板上，
它的字迹亮度是 **89 对 85**——差是真的，人眼看不见。改成 `dim`（整行 45% 不透明度，
星级和第二行一起暗下去）之后，`inkContrast`（字迹最亮的 10% 减去背景中位数）
量到 **109 对 75 / 71**（0.65-0.69×）。门线定在 `0.85×`，并且写清了为什么不是 0.45：
padding 之后的文字框尾巴会吃到行本身的家具，这半条断言只负责证明「暗下来这件事到了屏幕上」，
**份量**由旁边那条 `opacity` 断言负责。两条都是双向的——只读锁住那一行的断言，
在「所有行都暗」的时候也会绿。

### 面板拒绝是客气，宿主拒绝才是锁

面板的拒绝挡不住一张过期的面板、一个控制台、或者一个跑在别的设备上的客户端。
所以探针多了一条：绕开列表，直接 `game.startChamber(2)`。这条断言的意义在于
**单机的宿主是 `localSocket`，`api-check` 和 `mp-check` 谁都到不了它**——
在这之前它只有一条源码 grep 在守。

### 变异测试：六次，六处

`/tmp/mut-entry.sh`（`pristine` / `M1`…`M6` / `restore`，每次改一处、跑对应探针、
`restore` 用 `diff -q` 证明还原干净）：

| 变异 | 预期红 | 实际 |
| --- | --- | --- |
| M1 面板的点击拒绝改成 `if (false)` | 「说明原因且不关列表」 | **16 条**：目标那条是 `panel null`（面板被关了），后面的级联是真实后果——列表被关掉，接下来的点击没落在任何行上 |
| M2 锁住的行不加 `dim`（DOM 里还是锁的） | 像素那条 | **2 条**：`locked opacity 1`、字迹 167/158 **比开着的行还亮**；另一条是 1b 里「一场挑战跑着的时候没有任何一行被提供」——它也量 opacity |
| M3 层数列表放回区域列表下面 | 「不滚动能看见 3 行」 | **3 条**：`0/8 visible; row 1 at y=798`，紧接着像素那条（可见的锁行为 0），然后探针自己抛了（`shownLocked[0]` 是 undefined）——退出码非 0 |
| M4 单机宿主的 `if (!entry.ok)` 改成 `if (false)` | 那条新断言 | **8 条**：目标那条 toast 为空，级联拍下了真正的后果——**第二层真的开起来了**（`凝霜地脉` 在跑），于是接下来点第一层被回「挑战正在进行中」 |
| M5 共享规则不再锁深层（`if (false && …)`） | 层数真值表 + REST | `chamber-check` **5 条**（含字符串键、别的秘境的记录、零星记录、rank 优先级），`api-check` **1 条**（`status 200`） |
| M6 共享规则不再看等阶 | 等阶那两条 + REST | `chamber-check` **2 条**，`api-check` **1 条**（`goldenHall needs AR 18: status 200`） |

M2 第一次没打中：`row.classList.add('dim')` 在 `panels.js` 里有五处，`perl -0p s///`
不带 `/g` 换掉的是**文件里的第一处**，于是探针照常全绿——变异测试的第一条纪律是
先证明变异**打在了**你以为的那一行上（脚本现在用相邻的 `row.dataset.locked` 一起锚定）。

### 验证

- `chamber-check` **62 / 0**（从 46 加到 62：新的一整块「入口规则」真值表——两侧都钉，
  外加一条双向消费者门禁，证明四个判定者都 `import` 并**调用**了 `chamberEntry`，
  而且各自内联的旧判断已经不在了）。
- `api-check` **355 / 0**（四条 code 断言 + `need === zoneEntryRank(...)`）。
- `chamber-ui` **61 / 0**（从 41 加到 61；新增第 1a、1b 两块驱动列表本身）。
- `mp-check` **74 / 0**（联机的 `START_CHAMBER` 现在走 `chamberEntry`，行为不变）。
- 全量 `tools/check-all.mjs`：**62 / 62 GREEN · 3738 条断言 · 0 不绿**
  （`/tmp/check-all-20260909-233156/SUMMARY.md`）。

## 派角色出去采集：一个不存 deadline 的系统（探索派遣）

原神里唯一「关掉游戏也在推进」的模块，这个仓库一直缺着：**探索派遣**。
六个目的地（蒙德 / 龙脊雪山 / 璃月 × 矿脉 / 采集）、四档时长（4 / 8 / 12 / 20 小时）、
按冒险等阶开的派遣位（2 起，每 6 阶 +1，最多 5，且不超过你有几个角色）。

### 不存 deadline，也不存奖励

行里只有 `started_at`、`hours`、`dest_id`、`char_id`、`slot`。

- **结束时间**是 `started_at + hours * interval '1 hour'`，和**语句自己的** `now()` 比。
  客户端的表和服务器的表都不参与判断，改时区、改本地时钟、把标签页挂起一天都不影响。
- **领取**是一条带条件的 `DELETE … WHERE now() >= started_at + … RETURNING *`：
  删掉了几行就付几行的钱。连点两次，第二次删掉 0 行，于是 409 `not_finished` 或
  400 `nothing_to_claim`——不是「先读再判断再写」的三段式，所以没有中间状态可抢。
  `api-check` 里有一条专门的断言：**同时**发两个 `一键领取`，两个响应加起来只付一份，
  输的那个拿到的是一个 code，不是 500。
- **奖励**不在行里。`expeditionPayout(destId, hours)` 是纯函数，面板拿它画预览、
  路由拿它结账，中间隔了四个小时也是同一个答案。改一次收益表，**正在飞的派遣**跟着改，
  没有任何一处存着的数字会漂。

### 收益是这个区域自己的采集扫圈推出来的（而且只给材料）

一支 12 小时的派遣 = 你自己把这个区域的采集点扫一圈的 **1/3**（`EXPEDITION_SWEEP_SHARE`），
其余时长严格线性（4 小时正好是它的 1/3，`api-check` 用「2 × 4h 和 1 × 8h 差不超过 1 件」钉住）。
定价不是拍的，是从 `MEAN_PER_NODE` 和这个目的地的 `nodes` 推出来的——
所以给区域加一个采集点，派遣的收益自己会跟上。

只给材料：**不产摩拉，不产原石，不给经验**。挂机能拿到的东西必须是「省下的腿」，
不能是「省下的战斗」，否则整条养成曲线就有了一个不用玩的水龙头
（README 上面那条「常数别写在超线性曲线上」的教训的另一半）。

每种材料的份额是小数，一种一种地四舍五入会**每次都少给半件**，
所以四舍五入的是**跑动总和**，每种拿到的是差值——五份 17 件不会加出 15 件。

### 一条规则，两个读者，以及「这条拒绝该画在哪」

`expeditionEntry(destId, charId, hours, ctx)` 在 `shared/data/expeditions.js` 里，
路由执法、面板阅读——和秘境层数锁一样的分法。新东西是**第二次拆分**：

```js
export const EXPEDITION_DEST_ERRORS = ['no_such_expedition', 'bad_hours', 'rank_too_low'];
export function isDestRefusal(error) { return EXPEDITION_DEST_ERRORS.includes(error); }
```

面板要画两个能锁的东西：左边的**目的地行**和下面的**派遣按钮**。
「等阶不够」是那一行的属性，「Ta 已经出去了 / 派遣位满了」是这一次派遣的属性。
如果这个判断写在面板里，那就是把规则抄了第二遍——所以它跟着规则走，
`isDestRefusal` 和 `EXPEDITION_DEST_ERRORS` 在同一个文件里。
两边都画了字：锁住的行是 `🔒 龙脊雪山·矿脉` + 「冒险等阶不足，无法前往（需要 4 阶）」，
点它会把同一句话弹成 toast；按钮变灰时旁边**永远有一句为什么**。

### 时钟是服务器的，秒针不是面板的

每个快照都带服务器的 `now`，面板存下 `_expSkew = res.now - Date.now()`，
之后所有「还剩多久」都对着 `Date.now() + skew` 算。

秒针（`setInterval(1000)`）**不在面板里**，在构造函数里，活得比面板久：

- 它每秒从手上那份快照重算「有几支已归来」，**跨过零点就 emit**，
  面板开着没开着都一样——因为那一刻正是 HUD 上那颗 🧭 要亮起来的时刻。
- 面板开着的时候，它只改那一行 `.rem` 的文字；跨零点才 `_render()`，
  因为那是「领取」按钮要长出来的时刻。

第一版把这段写在 `_render()` 里，于是有两个 bug：面板关着时那颗 chip 最多要等 120 秒
（轮询）才亮；而每次 `_render()` 都会**再开一个** interval。

### 十一行 `justPressed` 换成一张表

顺手补的一处结构问题：`game.js` 里过去是十一行手写的
`if (i.justPressed('map')) this.emit('togglePanel', { panel: 'map' })`。
新面板要么忘了加一行（键是死的），要么加了一行拼错（键打开一个不存在的面板）。现在：

```js
const NON_PANEL_UI = new Set(['chat', 'emote', 'settings']);
export const PANEL_ACTIONS = Object.keys(ACTION_INFO)
  .filter((a) => ACTION_INFO[a].group === '界面' && !NON_PANEL_UI.has(a));
```

`for (const action of PANEL_ACTIONS) if (i.justPressed(action)) this.emit('togglePanel', …)`。
`tutorial-check` 两侧都钉：每个 `界面` 组的绑定都必须被派发（≥ 12 个），
chat / emote / settings 必须**不**在里面，而 `game.js` 里必须**找不到**
`justPressed('map')` 这类单行——否则这张表就只是多了一份。

### 探针：时间是买来的，而且只买到还剩 60 秒

`tools/expedition-ui.mjs`（**50 / 0**）从头到尾只走产品自己的输入路径：
`G` 开面板（这同时是「`PANEL_ACTIONS` 那张表真的能开一个后来才加的面板」的唯一证据）、
点目的地行、点时长、点角色、点派遣、点领取。三处方法上的讲究：

- **不等四个小时，也不把行拨过头。** `POST /api/dev/expedition-rewind` 只拨到**还剩 60 秒**：
  要考的是「跨零点」——数字得在没人碰的时候自己变小，`领取` 和 🧭 得自己出现。
  拨过零点的话，面板第一次看见它就已经是「可领取」，这两条都没被测。
- **刷新也不是探针要来的。** 面板的快照 30 秒过期、下次打开时在背后重取——
  所以探针拨完表就**把面板关掉、等 32 秒、再按 G 开**。
  下面每一个数字都是从面板自己的路径来的，而这 32 秒同时就是那支派遣在跑。
- **要点的那个目的地，故意不是面板默认选中的那个。** 面板打开时自己选了第一个能去的行
  （`expeditionsFor` 按 rank 再按 id 排，是 `蒙德平原·采集`；而 `Object.values` 的顺序是
  `矿脉` 在前）。探针第一版按前者算奖励篮子、按后者被真的派了出去，
  于是三条断言红着——**默认选中的不是你的被试**：先读面板选了谁，再挑一个**不一样的**去点，
  这样那一下点击必须改变什么（预览的篮子跟着换），否则就是一次证明不了任何事的点击。

像素都在**把 canvas 藏起来**之后读，而且每一条都有同一帧里的对照：
锁住的行（字迹对比度 81）对开着的行（187）、「可领取」的金色（165,144,88）
对空闲位的灰（63,68,79）、chip 自己那块矩形在**它显示时**（123）对**藏起来时**（0），
以及那个数字的紫（156,132,184，四颗 chip 里只有它是紫的）。

### 一次点击在 3 fps 下可能整个漏掉

第一次跑，「重开面板」那条红了，但**紧接着**「面板刷新出秒数」是绿的——面板明明是开着的。
`page.keyboard.press()` 是相隔几毫秒的一按一放，而 llvmpipe 把这一页跑在个位数 fps 上：
`justPressed` 每帧采样一次，一次轻点可以完整地落在两帧之间，谁都没看见。
现在按键是 `down` → 等 **4 帧** → `up`，然后**等面板真的变了**（而不是等 400 ms），
只有一动不动才重按。这和 README 前面「移动要按住若干帧」是同一条教训的另一面：
`dt` 被夹住的低帧率下，**输入的单位是帧，不是毫秒**。

### 变异测试：四次，四处

`/tmp/mut-exp.sh`（改一处 → 跑一遍探针 → `cp` 还原 → 最后 `cmp` 证明三个文件都干净）：

| 变异 | 预期红 | 实际 |
| --- | --- | --- |
| M1 锁住的行不加 `dim` | opacity 那条 + 像素那条 | **2 条**：`opacity 1 vs 1`，字迹 **179 对 187**（DOM 里还是锁的，字却和开着的行一样亮） |
| M2 秒针只在 ready 时改文字 | 「数字自己在动」 | **1 条**：`剩余 23 秒 → 剩余 23 秒` |
| M3 🧭 chip 永远 `hidden` | chip 那三条 | **5 条**：chip 没出现、矩形对比度 **0 对 0**、颜色读成 11,13,20、点 chip 打不开面板，然后探针在第 7 节抛出——真实后果是**面板根本没开**，没有可点的领取按钮（已经补成一条断言 + 一条兜底） |
| M4 派发表里滤掉 `expedition` | 「G 打开面板」 | **5 条**：目标那条 + 级联（面板没开，目的地列表一行也读不到） |

### 验证

- `api-check` **381 / 0**（从 355 加到 381：六个拒绝码各自和共享规则自己的答案配对、
  `need` 上线、拨表后的真值、`一键领取` 付的正好是 `expeditionPayout`、
  两个并发领取只付一份、线性、以及「只给材料，永远不给货币」）。
- `expedition-ui` **50 / 0**（新探针，已进 `check-all`）。
- `tutorial-check` **82 / 0**（新增 3 条，两侧都钉 `PANEL_ACTIONS`）。
- `mp-check` **74 / 0**（派遣是 REST，联机协议未动）。
- 全量 `tools/check-all.mjs`：**62 / 63 GREEN · 3663 条断言 · 68 分钟**
  （`/tmp/check-all-20260910-013728/SUMMARY.md`）。唯一那条红的很值：
  `daylight-check` 里「每个量像素的探针都必须钉住时刻，或者被豁免——**而豁免要有义务**」
  那道门，抓到了这一轮新加的 `expedition-ui.mjs`。它确实每次读像素前都把 canvas 藏了
  （义务满足），所以是登记进豁免表；补完单跑 **154 / 0**。
  一道早先写的门，在新探针进来的当天就拦了一次——这就是它存在的理由。

## 秘境打深：八层、三档星、两个 Boss、一份分账

`tools/deep-check.mjs`（新探针，**116 / 0**，已进 `check-all` 的 `http` 组）。
这一轮补的是仓库自己在 已知限制 第一条上记了很久的洞：**八层秘境从来没有被打完过**。
在这之前最深的收据是第二层——`chamber-check` 在进程内用 1e9 伤害的 `killAll` 推第二层，
`mp-check` 用两个 40 级游客清第一层，`balance-check` 在纸上按平价模型给星线打分。
于是四件事一条断言都没有：**3★ 时间带**（第八层的 `stars: [430,295,200]` 是个没人打过的数）、
**更深的地脉异变**（五种异变摆在 2–8 层，只有前两层的那两种被真的实例装过）、
**Boss 层的相位与护盾**（`phases: 2/3`、深渊使徒的水盾、相位跳变带的 1.2 秒硬直，
全在 `Enemy.takeDamage` 里，而没有任何探针把一个 Boss 打到过三分之二血以下）、
以及**分账**（`chamberMilestone` 把每颗星按该层总量的份额定价，所以 1★→3★ 必须
正好等于一次 3★ 的价钱；这段算术作为纯函数被测过，但从来没有由服务器付给两个玩家过）。

### 打法是产品的一部分，不是脚本的

两个游客账号，全部战力都走**真实成长路线**买出来（`/api/dev/supply` 按玩家自己付的那份
成本表发材料，之后每一级、每一次突破、武器等级、圣遗物、每一道菜都走面板点的那条路线），
然后组队、开私有秘境分片，再用一个**像玩家而不像伤害脚本**的战斗循环打：

- **要躲的是重招，不是每一招**。`attackShape` 就是服务端结算伤害用的那个函数，
  所以「站到圈外」是字面意思。但第一版循环躲**所有**电报，读数是第六层
  **233.9 秒 = 1★**、285 次翻滚；只躲 `mult >= 1.4` 的重招、把刮痧 AoE 吃下来之后，
  同一层同一套装备是 **45.3 秒 = 3★**。躲闪的对价是输出时间，而 Boss 会回血。
- **要带对元素**。暴风之主风抗 0.95：用起手的风角色打它，量的是抗性表，不是这一层。
  切人是按目标的 `res` 表选的，血量低于 30% 时生存优先。
- **要吃饭、要拉队友**。免费的联机复活是第八层能活下来的原因；
  薄荷果冻（+14% 攻、+5% 暴击，300 秒）和北地烟熏鸡走 `C2S.USE_ITEM`，每层之间重新采买。

### 分账那一条是构造出来的，不是碰巧打到的

只有这一条不是「打」而是**摆**出来的：第一层故意慢慢打（把最后一波的最后一只风筝住，
直到**服务器自己的**秘境时钟落进 1★ 带），然后快打一次，再快打一次。三次的账加起来必须等于一次：

| 第一层三连 | 时间 | 星 | 付出 |
| --- | --- | --- | --- |
| 慢打（吊在 1★ 带里） | 44.7 s | 1★ | `{primogem: 20, mora: 3333}` |
| 快打 | 10.4 s | 3★ | `{primogem: 40, mora: 6667}` |
| 再快打 | 11.1 s | 3★（记录不变） | `{}` ——但**照样扣 20 树脂、照样掉一件圣遗物** |

`20 + 40 = 60 原石`、`3333 + 6667 = 10000 摩拉`，正好是一次 3★ 的价钱；
记录留的是 `{stars: 3, bestTime: 10.4}`（最好的那次，不是最后那次）。
两个 socket 收到的奖励逐字段相同，树脂各扣各的 20、各掉各的一份。

### 它抓到的产品缺陷：一次 `GET /api/player/state` 会把模拟和存档拆开

第一次全程跑完是 **112 / 4**，四条红的是同一个缺陷，而且只出现在第五层之后：

```
FAIL floor 5: level 50 arrives scaled by the party's world level  lv 68/68/68 vs 71|71 (WL 7→7)
FAIL floor 8: level 80 arrives scaled by the party's world level  lv 109/109/109 vs 114|118 (WL 7→8)
```

敌人按**世界等级 6** 生成（`round(50 × 1.36) = 68`），而两个账号的存档在进秘境之前就已经
被自己的通关经验推到了**世界等级 7**。责任链是这样的：

- `ZoneInstance.worldLevel()` 读的是 `p.save.worldLevel`——**加入分片时递给实体的那个对象**；
- `playerCache` 的承诺是「每个在线玩家在内存里只有一份权威副本」；
- 但 `getPlayer(id, { fresh: true })` 从 Postgres 读回来之后，把**一个新对象**装进了 `live`。
  从那一刻起，跑着的分片手里那份是**孤儿**：`grantChamberClear` 通过缓存加的世界等级
  再也到不了模拟，而模拟继续按玩家**走进来时**的世界等级刷怪。

`GET /api/player/state` 正是走 `fresh: true` 的那条路——也就是说，**在秘境里打开一次背包
就会把这局的怪冻在进门时的强度上**。这和 `PlayerEntity.applyBuild` 上记着的那条老教训
（`stats`/`party` 是进区域时的快照）是同一个家族，只是这次坏的不是字段而是**对象身份**。

修法在缓存里，一处：`fresh` 现在**原地刷新**那个对象（补上缺的键、删掉多余的键），
身份不变；顺带在重读之前把脏状态 `flush` 出去，免得刚写的东西被 Postgres 的旧行盖回来。
`manager.js` 里那段 `cache.peek(id)` 的旁路（同一个缺陷在退区域时被打的补丁）也跟着简化了。
修完复跑 **116 / 0**，同一批读数变成 `lv 71 / 82 / 95 / 114`：

| 层 | 异变 | 怪等级（修前 → 修后） | 时间 | 星 |
| --- | --- | --- | --- | --- |
| 5 | 烈风地脉 | 68 → **71** | 43.4 s | 2★ |
| 6 | 炽炎地脉（深渊使徒 · 2 相 · 水盾 132369） | 82 → **85** | 250 s | 1★ |
| 7 | 烈风地脉 | 95 → **99** | 94.4 s | 2★ |
| 8 | 雷鸣地脉（暴风之主 · 3 相） | 109 → **114**（Boss 118，第三波时存档跨到 WL 8） | 103.7 s | 3★ |

第八层的相位读数：`ph2` 在 **65.9%**（≤ 67%）带 0.2 秒内的硬直，`ph3` 在 **30.9%**（≤ 33%）；
第六层的水盾按 `enemyStatAtLevel(shield.hp, 85)` 到货，被打破，`shieldBroke: true`。

### 变异测试，以及为什么第一版门禁是假绿的

缺陷修在服务端，所以门禁不能只留在那支跑 15 分钟的探针里。`mp-check` 里加了两条
（**76 / 0**，十秒钟走完）：中途把两个账号的冒险等级提到 16（世界等级 1 → 3），
然后开第一层，读**第一波到货的等级**必须是 `round(18 × 1.18) = 21`。

第一版这两条是**假绿**的：我把提级写在了 `powerUp` 里面，而 `powerUp` 是先 `dev/rank`
再连着三次 `GET /api/player/state`——世界等级在**孤儿产生之前**就已经写进了实体手里那份，
所以把修复退回去（`MUTATE_CACHE=1` 让 `fresh` 恢复成换对象）跑一遍，**全绿**，
一条都没红。把提级挪到那三次 fresh 读**之后**，同一个变异体立刻红了一条、而且只红这一条：

```
ok   a rank the party earns mid-run raises their world level  AR 10→16: WL 1 → 3|3
FAIL ...and that world level reaches the shard, not the one they walked in with  WL 3: lv 18 × 1.18 = 21, arrived 19/19/19
```

19 就是「进门时的世界等级 1」。还原之后 `21/21/21`。
教训是这条门禁的**顺序就是它的被试**：要证明状态是活的，那次改动必须发生在
可能把它变旧的那次读取**之后**；另外那条「提级真的把世界等级提了」是必须的对照，
否则一次没生效的提级会让整条断言变成恒真。

### 顺带：一条上一轮半落地的 dev 路由

`/api/dev/resin-rewind`（把树脂时钟往回拨，让一次探针跑得起十一场 20 树脂的秘境）
是无人值守循环第 50 轮写下的，但当时**只落了一半**：文件在磁盘上，运行中的进程比它早启动
三分半钟，没有调用者、没有断言，`[dev] test hooks enabled` 那行横幅里也没有它。
这一轮 `api-check` 给它补了六条（401、三种非法输入、一周正好把 160 格填满而第二周 +0、
填满的值在存档里、空条买不到的掉落填满之后能买到、拨三个周期正好值 3 点），
横幅也补上了它的名字。

### 验证

- `deep-check` **116 / 0**（新探针，八层、五种异变、两个 Boss、三档星、分账）。
- `mp-check` **76 / 0**（从 74 加到 76，新的两条是世界等级那一对，变异测试证明它们会红）。
- `api-check` **388 / 0**（从 381 加到 388：`/api/dev/resin-rewind` 六条 + 常量来源一条）。
- 三次全程跑（修复前一次、修复后两次，其中一次在 `check-all` 里）的星级分布：
  3★ 在 1/2/3/4/7/8 层出现过，第 5 层最好 2★、第六层最好 1★——记进 已知限制。

## 上云这一趟：两个洞都在同一条链路的同一处

部署到 AWS 本该是「把跑得起来的东西搬过去」，实际找出来的两个问题都在
**容器怎么连上数据库**这一件事上，而且是同一次失败的两面。

### 一、RDS 根本不接受明文连接

第一个任务起来 30 秒就被 ALB 摘掉，日志里是：

```
[pg] unavailable: no pg_hba.conf entry for host "10.80.23.225", user "teyvat",
                  database "teyvat", no encryption
[fatal] cannot reach Postgres at postgres://teyvat:…@teyvat-pg….rds.amazonaws.com:5432/teyvat
```

关键是最后三个词 `no encryption`：Postgres 15 起 RDS 默认参数组里 `rds.force_ssl = 1`，
明文连接连 `pg_hba` 都过不去。本地开发的 Postgres 不开 TLS，所以这条链路在仓库里
**从来没有被走过一次**——`DATABASE_URL` 一直是裸的。

修法不是 `sslmode=require`。这个版本的 `pg-connection-string` 把 `require` 当
`verify-full` 处理，但它自己的警告说下一个大版本会改回 libpq 语义（那时 `require`
根本不校验证书）；同时 RDS 的证书链是 Amazon 自己的根，系统信任库里没有。所以两件事一起做：

- `deploy/Dockerfile` 里 `ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`
  （global 那份，镜像不绑区域）；
- `deploy/entrypoint.sh` 拼 `?sslmode=verify-full&sslrootcert=/app/rds-ca.pem`，
  并留 `DB_SSL=off` 给不会说 TLS 的本地 Postgres。

`sslmode=verify-full` 而不是 `require`，是因为**要把保证写出名字**：加密 + 校验证书 +
校验主机名。改完那一版镜像的日志就是 `[db] schema ready` / `[redis] connected`。

### 二、那行 fatal 日志把口令印进了 CloudWatch

上面那段日志里的 `postgres://teyvat:…@` 在真实的 CloudWatch 里是**完整的口令**。
`server/src/index.js` 这行从仓库第一天就在，本地看不出问题——本地的口令是
`postgres:postgres`，而且日志只在自己的终端里。

> 一个只在部署坏掉时才执行的分支，正是最容易被日志聚合器收走的那一行。

所以它同时是两个东西：一次真实的凭据泄露（口令已经轮换，泄露的日志流已经删掉），
和一条通用规则——**任何被打印的连接串都要先脱敏**。现在是
`redactUrl(config.databaseUrl)`，保留「往哪连、以谁的身份」，去掉口令。

轮换本身还教了一件事：第一次轮换之后旧任务还在崩溃循环，于是**新口令又被印了一遍**。
先把 `desiredCount` 降到 0 停止出血，再换镜像、再轮换、再起来——顺序错了就是白轮换一次。

### 三、这套冒烟测试只测部署能测的东西

`deploy/smoke.mjs`（**24 / 0**）刻意不重做 `api-check` 已经覆盖的游戏逻辑。
只有真部署会错的是**那条链路**：

- `/api/health` 从 CloudFront 打进去要 200，`redis` 字段必须是 `redis`
  （不是进程内兜底），protocol 要等于本仓库的 `PROTOCOL_VERSION`；
- 未登录的 `/api/player/state` 必须回 **401 的 JSON**，`/api/nope` 必须回 404
  ——这两条是那个「不配 `CustomErrorResponses`」决定的门禁：一旦有人加上 SPA 改写，
  这里立刻变成 200 + HTML；
- `POST /api/dev/rank` 必须 **404**（带着有效 token 发，免得把鉴权的 401 误读成路由不存在）
  ——这是「`NODE_ENV=production` 真的进到容器里了」的唯一证据；
- index.html 必须 `no-cache`、`/assets/*` 必须 `immutable`：index.html 点名的是这次部署的
  带 hash 的 chunk，缓存住它，浏览器就会一直去要刚被 `--delete` 删掉的那批文件；
- 直连 S3 桶必须 **403**（桶名从 `deploy/.aws-state` 里读，读不到就 SKIP，不给没验过的
  断言发绿灯）；
- `wss://…/ws` 握起来、HELLO 有 WELCOME、快照的 `tick` 和 `now` 都在**涨**（一帧缓存只能
  证明管子通，涨的时钟才证明模拟在跑），最后走 14 步 `INPUT` 再从服务器自己的快照里读回
  位移 **19.8 m**——上行方向也得有收据，前面那些全是「服务器能对浏览器说话」。

再加一遍真浏览器：`DISPLAY=:99 node tools/play.mjs https://d28onkne6sxzvr.cloudfront.net`，
13 张截图、`errors: 0`、`sock: open`、`zone: mondstadt`、6 只怪。

（顺带记一条：EC2 的安全组 `GroupDescription` 只接受 ASCII——描述里一个中文破折号就能让
创建失败。）

## 让服务端自己打出一次反应：一张端到端的照片，和它路上撞见的产品缺陷

上一节那 134 条断言有一个共同的前提：payload 是**探针自己写的**，直接喂给客户端的
`_onDamage`。「反应怎么解算」由模拟侧的探针管，「反应怎么画」由那 134 条管，
中间那段——玩家按键 → 服务器解算 → 回包 → 屏幕上亮起来——谁都没拍过。
这一节把它拍下来了：`tools/react-check.mjs` 第 4 节，一次真实的
**附着 → 切人 → 触发**，光是服务器算出来的 `reaction: 'swirl'` 点亮的，
探针在这条链上一个字节都没写。

一次成功的照片长这样（`/tmp/react-e2e8.log`）：

```
ok  the sim computed 「扩散」 itself and put it on the wire
      wind onto fire: reaction swirl, kind skill, 1037 dmg on eyq, by 3003, after 28 payload(s)
ok  ...positioned by the server, not by the client   at 9.8, 27.98, -119.55
phases: 0.05s 88580px  0.2s 36544px  0.45s 72992px  1.2s 0px
ok  ...at the creature rather than at the player     74 px from the hit, 729 px from the character
```

跑到这一行之前，路上有**四个产品缺陷**和**四个探针缺陷**，值得分开记，因为它们长得一模一样：
一次被拒绝的输入和一次丢掉的按键，在日志里没有区别。

### 一、切人之后技能按不出来：一个没有权威的预测值

`localPlayer` 只保留**当前上场角色**的一个 `skillCd`/`burstCd`，而模拟侧的冷却是
**按角色**存的（`PlayerEntity.cooldowns['ignar:skill']`）。grep 证明这个客户端数值的写者
只有三处：初始化、本地预测、逐帧衰减——**线上从来没有这个字段**。于是「A 放技能 → 切到 B →
B 放技能」这条每个反应都要走的轮换里，B 拿到了 A 的冷却，`useSkill` 返回 `false`，
按键什么都不发。`setCharacter` 里甚至写着一句注释，承诺「HUD 会从下一个快照拿到真值」——
那个字段并不在快照里。

修法是把整张**表**放上线（`cds: viewer.cooldownMap(this.now)`，和已有的按角色的
`energy`/`hpByChar` 并列），客户端权威地套用它，只留一个 0.6 s 的本地施法窗口
（`_castAt`）让在途的旧包不能撤销一次刚做出的预测，切人时清掉预测值。
新字段必须有**真实消费者**，否则它就是下一个死字段：现在**下场角色的队伍卡**会显示自己的
冷却（蒙版 `--cd` + 秒数），也就是「我该切谁来触发」这个信息第一次出现在屏幕上。

门禁在两层：协议层（`mp-check`）和像素层——探针按下切人键的那一刻读三样东西并要求它们
互相咬合：线上的 `cds`、`hudState()` 的秒数、和那张卡的 DOM。
一次绿的读数是 `cds {"ignar:skill":6}`、`hudState says 6 s`、卡片
`{"cooling":true,"cd":"7","shown":"grid","veil":"0.79"}`。

### 二、「两边一致」不等于「两边都是我要的那个人」

第一版的切人等待轮询「客户端的 `activeSlot` 和线上的 `players[me].c` 一致吗」——
这在按下 `Digit1` 之后的约 300 ms 里**是真的**，因为两边都还是**上一个**角色。
于是断言在切人真正发生之前就读完了卡片、`skillCd` 和 `activeSlot`，
读回来 `slot 1 = ignar`、`skillCd 7.87 s`，看起来正是那个刚修完的 bug 又回来了。
轮询条件改成「两边都等于**我要的那个** `charId`」之后才对。

> 轮询一个状态机的收敛，条件必须点名**目标状态**；「双方一致」在转移开始前也成立。

### 三、6 秒附着是一份预算

炎附着 6 s。按下附着键到按下触发键之间的每一件事都在花这份预算：
`pipOf` 里的 `faceCreature`（最多 6 × 700 ms）、一次无条件的重新锁定加 `approach(25 s)`、
一个 `sleep(1200)`、`cast` 里两个固定睡眠——加起来超了窗口，于是那一发风打在一个
`carrying null` 的怪身上，服务器诚实地回了 `reaction: null`。

修法不是把睡眠调小，是**把所有瞄准挪到附着之前**，附着之后只做**有条件**的修正
（目标丢了才重新点，距离出界了才走），并且每个「等」都换成对权威的轮询：
切人问快照自己的 `players[…].c`，按键问模拟发回来的 `PLAYER_ACTION`/`ERROR`。
一次轮换省下约 2.3 s，从此第一次尝试就能拍到（`attempt 1`）。

### 四、在没人插手的地方打

在蒙德的营地里打反应，第一个问题不是伤害，是**别人也在打**：怪营是成群的，
探针的攻击会引来第二只，而附着窗口里多一只怪就多一份不确定。
所以擂台是从生成表里**推**出来的，不是写死的坐标：扫 `ZONES` 的 spawn 列表，
挑那个**方圆几十米内只有它自己**的点位——蒙德刚好有一个，(10,-140) 的
**遗迹守卫 Lv.14，9797 hp**，离出生点 140 m。

它顺手拿掉了一条老约束。以前的等级上限是「别把附着的那个怪一巴掌打死」；
9797 hp 的精英怪谁也打不动，于是只剩下限：**活着走完轮换**。
它的招式是 `slam` 1.6×、`chargeRoll` 1.9×、`missileBarrage` 0.5×6，atk 300，约 2.6 s 一次，
落到身上每次约 230-250。Lv.14 的 2298 hp 只够 9 下；Lv.30 的 3782/3020 hp 够 15 下。
所以探针把队伍练到 **Lv.30**——不是写进存档，是用真实途径买的：
`totalXpTo(30)` = 359 679 xp = **18 本 heroWit**（每本 20 000），
突破到 40 级上限要 AR 10 给的 `arCap(10) = 40` 和 `ASCENSION_CAPS` 的两档，
材料由 `/api/dev/supply` 按**成本表**推导发放（那条路由不写等级，只发东西）。
断言读回来的是 `levels 30/30, AR 10` 和 `{"hp":3020,"max":3020}`。

还有两件只有真打才会遇到的事：**附着的那个角色走在前面**（它要挨这一路的伤），
所以倒地的那个是它，而对着倒地角色按切人键，服务器回的是**「该角色已倒下」**——
一次安静的拒绝，看起来又像丢键。以及服务器的自动复活会把队伍**挪走**，
所以「我还在擂台上吗」这个问题必须问**地点**（距离 > 40 m 就重新走过去），
而且要在重新挑目标**之前**问：120 m 外那只精英怪已经从视野普查里流出去了，
重新挑就会挑到 68 m 外的一个丘丘人营地。

### 五、探针自己的手势把锁取消了

`clickTarget` 里一个长度为 0 的右键拖拽，在浏览器看来就是一次**右键点击**——
`_rightClick` → `_clearTarget`。锁刚拿到就被自己取消了。

而瞄点本身也不能是屏幕上一个固定的比例：`pickEnemy` 是一个球
（`actors.js:586`，半径 `max(0.7, height*0.45) + 0.35`，中心在 `y + height*0.5`），
一只 3.6 m 高的精英怪站在 3.2 m 外时，它的**腰**投影到 y = 645——1024×640 的视口下沿之外。
于是那次点击根本没发生，而消息还写着「clicked at 511,645」。
现在瞄点从相机里**逐次推导**，沿身高取 0.5 / 0.75 / 1.0 三个候选，选第一个落在视口内边距里的
（那次是头，y = 500），并且 `clickTarget` 返回**它到底点没点**，消息照实说：
`clicked at 531,632 of 1024x640 (0.5 up a 3.6 m body, tried [...])`。

### 六、一帧没人量过的控制帧

四条相位断言（0.05 / 0.2 / 0.45 / 1.2 s）都是「和命中前那一帧比」。有一次它们读回来的是
**655360 px of 655360**——整个视口，四条全是。第一个假设是相机在抖（`rig.shake`），
错了：`rig.update` 只在 `_frame` 里跑，而 `g.stop()` 已经把循环停了，相机不可能动。

真正的原因是那张基准帧**根本没被画出来**：`g.stop()` 停掉的正是驱动合成器的那个循环，
所以「藏起世界」之后的第一张截图有可能还是**藏之前的草地**。
解码之后一看就明白了——`e2e-00-before.png` 均值 101.6/116.8/86.5（luma ≈ 108），
而后面每一张相位帧都是暗的。同一份日志里还有一条线索：摘掉 reaction 的控制组只差
58 179 px，因为**那两张暗帧彼此是一致的**。

修法是给基准帧加一道量出来的门：`rAF` 两次 + 400 ms，最多重试 6 遍，
每遍解码并量整幅的亮度，要求 `luma < 20`，然后把这个读数写成一条断言
（`luma 4.1, rgb 2,4,12`）。

> 一帧从没被画出来的控制帧，会把四条像素断言变成噪声，而且四条同时变绿的方向也有——
> 只要噪声两边一样大。

### 七、可以问的和不能问的：光画在哪儿

「画在怪身上而不是画在玩家身上」这条，两个点都在屏幕上时是**无量纲**的：
光的重心离哪个点近，就是画在哪个点上（74 px vs 729 px）。
但触发那一招带 7.5 m 冲刺，冲完相机常常几乎贴在角色身上，
角色的 NDC z 会退化成 −59——**没有玩家点可比**。
这种时候问的是同一个问题的**更强**的那一半：光的重心离服务器给的坐标 < 160 px
（视口高度的四分之一，实测偏差 20-74 px），而一个画在角色身上的反应会在**相机背后**，
一个像素都画不出来。以前这里是 SKIP。

### 验证

- `tools/react-check.mjs --no-catalogue`（只跑词表/接线/端到端三节）：
  连续两遍绿，**57 / 0 / 2** 和 **58 / 0 / 1**（`/tmp/react-e2e7.log`、`/tmp/react-e2e8.log`），
  两遍都是 `attempt 1` 拍到，相位 88 580 / 36 544 / 72 992 / **0** px，
  反应自己的光（摘掉 reaction 的同一个 payload）35 835 px，基准帧 luma 4.1。
  两遍的差别就是第七条：一遍两个点都在屏幕上（74 vs 729 px），一遍角色在相机背后。
- 整支探针（目录 + 端到端，四节全跑）：**170 passed, 0 failed, 0 skipped**
  （`/tmp/react-full1.log`），探针的断言数 134 → 170。端到端这一节第三遍也是 `attempt 1`，
  相位 117 501 / 48 706 / 99 017 / **0** px，重心离服务器坐标 83 px（离角色 742 px）。

## 一个字面量把反应系统砍掉了一半：`ATTACK_MOVES.basic` 的 `element: 'physical'`

上一节想给第二种反应也拍一张端到端的照片，最省的一条路是「不用第三个角色」：
去 `zones.js` 那个混编营地（`[160, 120]`，两只雷史莱姆 + 一只水史莱姆），
让**怪**把水和雷打在**玩家**身上，服务端自己算出 感电。写探针之前先手动跑了一遍，
发现这条路根本走不通——而挡住它的不是探针，是产品。

### 一、四只元素怪打出来的是物理，而且什么都不附着

`resolveEnemyAttack`（`zoneInstance.js:575`）读的是：

```js
const element = mv.element || e.def.element || 'physical';
```

**招式上的字面量赢过生物自己的元素**。而 `chooseMove()`（`entity.js:211`）对任何没有
`attacks` 列表的怪都返回三个兜底招式之一（`basic` / `basicRanged` / `basicCast`），
`ATTACK_MOVES.basic` 上写着 `element: 'physical'`。于是：

| 怪 | 元素 | gauge | AI | 实际打出 |
|---|---|---|---|---|
| 水史莱姆 | water | 1 | melee → `basic` | **physical，不附着** |
| 炎史莱姆 | fire | 1 | charger → `basic` | **physical，不附着** |
| 火斧丘丘人 | fire | 1 | charger → `basic` | **physical，不附着** |
| 霜狼 | ice | 1 | charger → `basic` | **physical，不附着** |

`basicRanged` / `basicCast` 没写 `element`（那是上一轮为了 `projectileSpeed` 留的规矩），
所以雷史莱姆和深渊法师一直是对的——**只有近战/冲锋的那一半是坏的**。

这四只的 `element` 和 `gauge: 1` 都是authored 的，`enemyGate` 甚至把这两个键
分别注释成「它的攻击附着的元素」和「命中时的元素附着」，`res` 抗性表是围着元素配的，
模型的 `glow`、血条上的元素色、以及客户端起手圈的颜色
（`game.js:1713` 的 `mv?.element || e.actor.def.element`）全都同意那个元素——
**只有决算那一行不同意**。后果不是「掉一点观感」，而是整个反应系统的玩家侧不可达：
开放世界里没有任何东西能让玩家**湿身**，所以 感电 / 冻结 / 超导 打在自己队伍上永远不会发生。

修法就是把那个字面量删掉（兜底招式不写元素，跟不写 `projectileSpeed` 同一个理由），
并且把这条规则做成**两个方向**的门禁 —— `enemyGate.js` 里现在会算出
「这只怪能选到的招式集合实际会附着什么」，然后两头都问：

- `gauge > 0` 却没有自己的元素，或者**能选到的招式附着的元素里没有它自己的元素**，报错；
- 反过来，`gauge: 0` 却会附着非物理元素，也报错（附了也没用，永远做不出反应）。

变异测试两次都精确落地：把 `element: 'physical'` 写回去 → 4 条问题，点名那四只；
把水史莱姆的 `gauge` 改成 0 → 1 条「applies water with gauge 0，附着不了也做不出反应」。

### 二、修完之后露出来的两个洞：玩家侧的 aura 没有消费者

元素能附着了，才发现附着之后的两样东西**没人读**：

1. **`p.aura.dots` 从来没有被 tick 过。** `updateEnemy` 一直在跳怪身上的 dot
   （`maxHp * frac * 0.35`，每秒一次），`updatePlayer` 里没有对应的循环。
   感电给玩家 push 的那条 `{ element: 'lightning', frac: 0.06, until: now + 4.0 }`
   被反应写进去、被序列化、然后被读到 0 次——**玩家身上的感电是一个弹窗和一个数字**。
   现在 `updatePlayer` 会跳它，并且发 `kind: 'dot'` 的 `DAMAGE`（前例是严寒：
   它也不走 `damagePlayer`，因为那条路会再算一次抗性和地脉，而 dot 是按最大生命算的）。
2. **`p.aura.defShred` 没人读。** 超导的 0.4 减防、8 秒，在 `playerHitEnemy` 那边
   一直是读 `enemy.aura.defShred` 的（`zoneInstance.js:826`），
   而 `damagePlayer` 的减伤公式里只有怪的 `def`。现在两边对称：

```js
const shred = 1 - Math.min(0.8, p.aura.defShred || 0);
const mitig = (level + 100) / (level + 100 + (live?.def || 100) * shred * 1.4);
```

### 三、门禁跑的是 AI，不是 `damagePlayer`

`enemy-check.mjs` 新增的第 11 节没有一行写元素、也没有调 `damagePlayer`：
它把怪 spawn 在自己攻击距离以内，然后 `updateEnemy` + `updateProjectiles` 一直跑，
直到 `inst.events` 里出现给玩家的 `DAMAGE`，再读 payload 和玩家的 `AuraState`。
所以「水史莱姆撞一下」和「雷史莱姆丢一颗球」是同一个问题的两种走法。
名单是**推出来的**（`gauge > 0 && element !== 'physical'`），第十三只怪写上去的当天就被覆盖。

一条差点写错的断言：期望值不是「留下自己的元素」。**风和岩是两个不带自己 aura 的载体**
（`AuraState.apply` 在写 aura 之前就 return 了：扩散是把已有的 aura 吹开，
结晶是给个盾），所以岩龙蜥留下一个岩 aura 恰恰是上一轮修掉的那个 bug。
探针因此不硬写名单，而是**问 aura 表本身**：

```js
const lingers = (el) => { const a = new AuraState(); a.apply(el, 1, 0); return a.dominant() === el; };
```

再要求运行中的模拟跟它一致，并且先证明这个 helper 两头都会答
（`water: lingers`、`wind: carries`）——否则「都不附着」也能让它全绿。

反应本身也是两只怪打出来的，不是测试写进去的 aura：水史莱姆撞湿 → 雷史莱姆的球
= `reaction: 'electroCharged'` 上线；霜狼撞冰 → 雷球 = `superconduct` + `defShred 0.4`。
dot 两头都有界：1.25 s 内正好跳 1 次（132 hp），窗口内一共 395 hp，**之后 3 秒 0 hp**——
少了后一半，「它会跳」对一个永不过期的 dot 同样成立。减防那条测的是一对读数，
不是一个数：同一只丘丘人在 0 / 0.4 减防下 **234 → 338**。

### 四、顺手撞出来的：`check-all` 跑的不是它自己那个 node

修完之后按规矩跑一遍 `check-all --group data,http`，结果 **4 红**：
`mp-check` / `build-check` / `deep-check` 都在打完前几条绿之后死在
`ReferenceError: WebSocket is not defined`，`gamut-check` 死在 `path.join(undefined)`。
但 `mp-check` 单独跑是全绿的。差别在最后一行日志：`Node.js v18.20.8`。

`check-all` 用 `spawn('node', …)` 起子进程，`node` 走 PATH 解析到 `/usr/bin/node-18`——
而 suite 本身是用 nvm 的 v22 起的。v18 没有全局 `WebSocket`，六个开网关连接的探针全部必死，
而那个死法**长得跟网关出了回归一模一样**（前几条断言绿，然后一段栈）。
两处修：

- `spawn(process.execPath, …)`：suite 必须用**自己正在跑的那个解释器**跑它的孩子；
- 预检多印一行 `node v22.22.3 at …`，并且在没有全局 `WebSocket` 时**直接拒绝开跑**
  （跟 `/tmp` 空间那条同一个形状：跑不了自己探针的 suite 不算证据），
  用 `/usr/bin/node-18` 起验证过这条拒绝会命中。

改完同一条命令：`gamut-check` 40/0、`mp-check` 82/0、`build-check` 34/0，全绿。

### 验证

- `tools/enemy-check.mjs`：**101 passed, 0 failed**（原 83 条）。
- 三次变异，三次精确落地：
  `basic` 写回 `element: 'physical'` → **11 红**（门禁 1 + 四只怪 + 感电/超导整条链）；
  `p.aura.dots` 的循环改成空数组 + `shred` 写死 1 → **3 红**（两条 dot 断言 + 减防那条）。
- `enemyGateReport({})` 0 问题；`npm --prefix client run build` 通过（shared 是打进客户端的）；
  `./tools/daemon.sh restart server` 之后 `tools/api-check.mjs` **388 / 0**、
  `tools/mp-check.mjs` **all passed**（`/tmp/api-after-basic.log`、`/tmp/mp-after-basic.log`）。
- `check-all --group data,http`（12 个不开浏览器的探针）：**12 / 12 GREEN、1007 条断言、0 not green**
  （`/tmp/check-all-20260913-062038/`），含 `deep-check` 八层 116 / 0——
  也就是说这次 `shared` 改动没有动到秘境那条链路的任何一处。

## 左右是反的：一个在比较的两端同时出现、于是被约掉的符号

玩家问的是一句话：「方向键控制是不是反了？」答案是一半反了——前后对，**左右反**，
而且 `A`/`D` 和 `←`/`→` 一起反（`input.js` 里它们映射到同一组 `left`/`right` 动作）。

### 一、缺陷本身：`basis()` 的右向量是 `forward × up` 的相反数

`camera.js:basis()` 返回 WASD 所依据的地平面基。相机机位是
`pivot + (sin yaw, ·, cos yaw) · d`，所以前向就是 `(-sin, -cos)`——这一半一直是对的。
右向量在 three 的右手系里应当是 `forward × up`，对这个前向来说是 `(cos, -sin)`；
代码里写的是 `(-cos, +sin)`，正好差一个负号。`localPlayer.js` 是它**唯一**的产品消费者
（`wishX = fx·axis.y + rx·axis.x`），没有第二处把符号抵消回去，于是横移整体镜像。

判定不靠推理：把 `_apply()` 和 `basis()` 原样搬进 node，用真正的
`THREE.PerspectiveCamera` 把「按住右」产生的位移投影回屏幕。yaw = 0/45/90/180/270°
五个角度下，右移一律落在 NDC x = **−0.60**（屏幕左）；改成 `(cos, -sin)` 之后
五个角度一律 **+0.60**。前向在两种写法下都正确地远离相机。

### 二、为什么六十个探针没有一个看见

`mouse-check.mjs` 里确实有一条断言叫「点左边和点右边指向相机的两侧」。它这样做：
用 `basis()` 算出一个横向偏移的世界点去点击，再把结果**点回同一个 `basis()`** 上量正负。
符号在比较的两端各出现一次，于是约掉了——这条断言在正确的实现和镜像的实现下都是绿的。
这是 `one-sided controls prove nothing` 那一族的另一种形状：不是缺了对照，
而是**对照和被测量共用了那个可能出错的量**。

推论写进了门禁：任何关于「哪一侧」的断言，必须落在**屏幕坐标**上。

### 三、新门禁：`motion-check` 的 「横移落在屏幕的哪一侧」

它按真实按键，然后问角色最后出现在屏幕的哪一边，全程不提 `basis()`。两处是必需的：

- **相机在 t0 被克隆，前后两个位置都投影到那个克隆上。** 实时机架是钉在角色身上的
  弹簧，几百毫秒内就把人重新拉回画面中央，一次成功的横移在实时投影里差不多是 0。
  冻住视点，「哪一侧」才成为一个有答案的问题。
- **按键按住到角色真的走出距离为止，而不是按住一个墙上时间。** llvmpipe 在这儿是
  2–6 fps、`dt` 截到 50 ms。走不动就 `SKIP`——横移撞在石头上不是关于符号的证据。

两个相机角度各四条断言，共 8 条：`D` 向右、`A` 向左、`→` 与 `D` 同向，以及
「左右不是同一个方向」（只测一侧的话，一个把所有键都送去右边的基也能过）。
第二个角度不是冗余：yaw = 0 时世界 +X 恰好就是屏幕右，一个完全无视 yaw 的基在那儿也能过。

### 四、修完之后掉出来的一条：探针的「空地」从来没被验证过

改完符号，`mouse-check` 的 「点哪走哪」 立刻红了：`goalKind interact`。
产品没错——`_leftClick` 在到达点哪走哪之前有两道故意宽松的交互物判定
（沿射线的球体测试「点着东西就是点着东西」，以及地面命中点周围的半径测试
「点箱子旁边的草也算开箱子」）。是探针的前提错了：`findGround` 校验了在屏幕内、
起伏、距离、`elementFromPoint`，**唯独没校验这块地是空的**。符号一改，
同一个 `lateral: 4` 开始采到镜像那一侧，那儿有个采集点。

先按「地面点附近有没有交互物」补，还是红的：`nearestInteractable` 说这块地是空的，
但**射线**在飞向 12 m 外那片草的路上蹭到了一个箱子的球。所以前提必须按点击真正走的路走：
用产品自己的 `_pointerRay(ndc)` + `pickInteractable(ray, 90)`，再或上
`nearestInteractable`。这条前提也升级成了具名断言，
而不是让下一条断言把 `goalKind interact` 报成产品的错。

### 验证

- `client/src/game/camera.js` 一行；`npm --prefix client run build` 通过，
  产物哈希 `index-CHVayGh4.js` 与验证过的那次构建逐字节相同。
- `tools/motion-check.mjs`：**158 passed, 0 failed, 0 skipped**（新增 8 条）。
- **变异测试**：把 `(-cos, +sin)` 写回去重新构建 → 新增的 8 条**全红**，
  且 Δscreen 精确镜像（`D +0.348 / A −0.454` → `D −0.355 / A +0.355`）。
- `tools/mouse-check.mjs`：**86 passed, 0 failed**（修前 85 / 1）。
- `tools/questnav-check.mjs` **77 / 0**、`tools/tutorial-check.mjs` **82 / 0 / 1 skip**
  （那条 skip 是它自己写明的、交给 `motion-check` 的攀爬）——另外三个按住方向键的探针没有回归。

## 日落是天空里的一个方向，不是整片天穹的色调

「3d画质很不真实」。先拍照，再挑一个能量出来的缺陷修——这一轮修的是黄昏，
它一路上带出四件事：一个真缺陷、两次量错对象、一条**在缺陷上通过**的旧断言。

### 一、天穹的色相挂在 `night` 上，于是黄昏被自己抵消掉了

`daylight()` 里天顶/地平/雾的颜色都是 `mix(mix(authored, GOLD, golden·k), NIGHT_*, night)`。
`night = 1 - day`，而 `day` 要到太阳高度 17.5° 才到 1——太阳**正好压在地平线上**时
`night` 已经是 0.61。也就是说 `golden` 冲到 1.0 的那一刻，天穹被拽了 61% 去半夜的蓝黑，
两个 mix 互相抵消成一摊泥：18:00 实测天顶 `[71,76,98]`、地平 `[97,71,70]`，
一天里最亮最饱和的那片天，比它自己的正午暗了三分之二，
而地平比天顶还红——正好是文件里 `stars` 那条注释早就写明过的同一个缺陷
（星星在 0.955 的橙色朝霞上就已经看得见了）。色相该问的是「太阳落下去了吗」，
不是「天黑了几分」，所以改挂内部的 `dark = smooth(-0.02, -0.20, sinElev)`。
改完 18:00 是 `[176,183,216]` 的天顶配 `[230,158,130]` 的地平，天顶↔地平色差 0.151 → 0.410，
正午与午夜逐位不变（`dark` 在两处分别恰好是 0 和 1）。

### 二、照片没动——因为两次量的都不是天空

改完重建、重启、重拍，`sky top-centre` 前后都是 `[76,47,47]`，**一个计数都没动**，
而页面里 `uHorizon` 明明已经是 `[230,158,130]` 的线性值。于是去找「天穹和帧缓冲之间那个 0.15 倍」——
根本没有这个倍数。把天穹自己藏起来再 diff（`sky.mesh.visible = false`），
1600×900 的整帧 112 个格子里 **0 个**因此变色；再拿产品自己的 `_pointerRay` 往那个方向打一条射线，
`ndcY 0.8` 命中的是 **204 m 外的一片 ShaderMaterial**，天穹排在它后面 1499 m。
那片枣红色是山壁，不是天。抬头拍（`pitch = -0.28`）才是天穹：
12:00 `[191,210,229]`、17:00 `[191,204,223]`、18:30 `[105,116,149]`、20:30 `[47,53,68]`——
色相修正一直都在像素里，只是我连着两次把一面 200 m 外的崖壁当成了天空。
这是 `a-rect-must-prove-its-subject` 的第三次现形，代价是半小时找一个不存在的倍数。

### 三、亮度和色相原来是同一项：`domeDim`

把色相从 `night` 挪走，顺手也把**唯一在给天空调暗的那一项**挪走了。
18:00 的天顶亮度因此变成 185.7，正午是 203.2——一张下午的天，中间贴了个橙太阳。
更麻烦的是近白处正是 ACES 压得最狠的地方：`GOLD` 加多少都吃不出暖色，
`sunward` 的 r/b 只到 1.27，门槛要 1.33。所以亮度得自己有一项：
`domeDim = 0.42 + 0.58·day`，在夜色 mix **之前**乘上去（两者不叠加），
`0.42 + 0.58 = 1` 保证正午逐位不变。黄昏天顶 130.4，正午 203.2，午夜 11.1——
一片中间调的天，这才是 ACES 拿得住色相的工作点。

### 四、暖色带在太阳那一侧：`uGolden` / `uSunsetCol`

`uZenith`/`uHorizon` 只是高度的函数，每个方位角都一样——写进它们的暖色，
在你**背后**也一样橙。而 `daylight-check` 里那条
「比同一时刻背对太阳的那片天更暖」，长期以来通过的方式是：
背对太阳那片天被 `night` 拽黑了，所以「更暖」量到的其实是让日落变泥的那个缺陷本身
（天穹修好后这条比值就掉到 1.27 / 0.90）。日落是**方向**，所以这一项归着色器：
`uGolden`（就是 `ph.golden`）配 `uSunsetCol`（`mix(horizon0, GOLD, 0.82)`，从各区自己的地平色出发，
所以蒙德的黄昏落在它的淡蓝上、龙脊落在它的冰白上），
按太阳方位角的 `dot` 加权、只压在地平附近：

```glsl
float az = dot(normalize(d.xz), normalize(L.xz));
float toward = pow(clamp(az * 0.5 + 0.5, 0.0, 1.0), 2.6);
float low = pow(clamp(1.0 - max(h, 0.0), 0.0, 1.0), 3.0);
sky = mix(sky, uSunsetCol, uGolden * toward * low * 0.9);
```

各向同性的那两个 mix 同时降到 0.10 / 0.26（原 0.18 / 0.55），云的受光色在黄金时刻从
0.45 抬到 0.85 倍太阳色——近白的云原本是把日落洗回去的那一层。
`uGolden` 在正午恰好是 0，所以整块新代码在所有标定帧上是**一次都不执行**。

### 五、顺手补的一条：`player-aura-check` 没钉小时

`daylight-check` 会扫描每个量像素的探针有没有钉 12:00（或者藏掉画布）。
`player-aura-check` 两条都没有：它拍的是角色**身体**，而身体是被太阳照的，
阈值却是在某个「刚好挺亮」的小时里定下来的。补 `setWorldTime(12)` 加一条断言说明它钉住了。

### 验证

- `tools/daylight-check.mjs`：**157 passed, 0 failed, 0 skipped**（修前 150 / 4；新增 3 条）。
  - `18:00 sunward rgb [213,150,125] r/b 1.70`（门槛 1.33；修前 1.17，只挪色相 1.27）；
    背对太阳 0.80。
  - 新增 **黄昏是中间调**的双边区间：`130.4 < 203.2×0.75` 且 `> 11.1×4`——
    原来那条「正午最亮、午夜最暗、黄昏居中」暗一个计数也能通过。
  - 新增**藏掉嫌疑项**（和 `uStars`/`uNight` 同一套问法）：18:00 把 `uGolden` 压成 0，
    `r/b 1.70 → 1.18`；12:00 压成 0，`[191,204,201]` 与 `[191,204,201]` 逐通道相同。
- `12:00 是逐位的原值`那一节六个区全绿，`地下天空不动` 0 px；
  `tools/weather-check.mjs` **120 / 0 / 1 skip**、`tools/shadow-check.mjs` **26 / 0**
  （16:00 和 08:00 的 `day` 都已经是 1，`golden` 是 0，两个新项在那里恒等于零）。

## 黄金时刻本该是一天里反差最大的一小时，它原来是最平的

同一句抱怨的第二轮。上一轮修的是天穹的**颜色**，这一轮修的是**光比**——
一天里日落前那一小时之所以被人拍、被人画，是因为主光又亮又斜、天光又弱又暖：
一张脸在那时候是有体积的，正午反而没有。游戏里正好相反。

### 一、所有亮度曲线都挂在 `day` 上，而 `day` 在太阳落到地平线之前就掉了六成

`day = smooth(-0.22, 0.30, sinElev)`：太阳高度 17.5° 才到 1，**正好压在地平线上时只剩 0.39**。
直射（`sunIntensity`、`groundSunColor`）整条挂在它上面，天光（`ambientIntensity`）却有
`0.30 + 0.70·day` 的地板。于是白天最后一小时里，**主光掉得比补光快**：

| 蒙德 | 17:00 | 17:30 | 17:45 | 18:00 |
| --- | --- | --- | --- | --- |
| 修前 `groundSunColor` | 235,187,152 | 182,122,89 | 148,91,61 | **114,63,38** |
| 修前 光比（直射/天光亮度） | **1.64** | 1.72 | 1.79 | 1.84 |
| 修后 `groundSunColor` | 235,187,152 | 223,150,109 | 223,137,92 | **202,112,67** |
| 修后 光比 | 1.74 | 2.04 | 2.37 | **2.57** |

正午的光比是 **1.73**。也就是说 17:00 的光比 **比正午还低**——本该最有戏的一小时，
比一天里最平的那一小时更平。`terrain.js` 的 `uSunColor` **就是**它的直射项
（不乘 `sunIntensity`），所以那一格 114,63,38 是拿一块近黑的褐色去乘草地：
17:36 的照片量出来中位亮度 55，地面 **85% 落在中位数 ±20% 之内**，阴影凹陷 1.3%。
一整片均匀的泥。

修法是把「太阳有多亮」和「太阳有多高」分开：

```js
const up = smooth(-0.12, 0.03, sinElev);   // 太阳在地平线以上
const beam = Math.max(day, 0.86 * up);     // 落地之前不掉到 0.86 以下
```

`sunIntensity` / `groundSunColor` 改挂 `beam`，同时给天光加一项
`(1 - 0.30 * golden)`：低太阳是一个小而硬的光源，天空也已经不怎么往阴影里弹光了——
反差要从**补光变弱**里来，不是从主光熄灭里来。两项在正午都恰好是 1（`day` 是 1、
`golden` 是 0），所以那 ~500 条像素断言一位都没动。

### 二、修完第一条之后量出来的第二条：黄昏的补光是**冷**的

补光的颜色也是 `mix(mix(authored, GOLD, golden·k), NIGHT_AMB_*, night)`——
和上一轮天穹那条**一模一样的缺陷**，只是在下一行。`night` 在 18:00 已经是 0.61，
于是 `golden` 顶到 1.0 的那一刻，补光被拖了 61% 去午夜蓝。后果是本来暖的两个区
**日落比正午还冷**：璃月港 r/b `1.52 → 1.29`、黄金屋 `1.75 → 1.29`。
一个暖主光配一个冷补光，出来就是灰——这正是 17:36 那张照片中位饱和度 0.33
（正午 0.54）的原因，跟「金色的太阳照在中性墙上」是同一件事，只是走到了填充光这一步。

改成挂 `dark`（太阳**落下去**才算夜里），亮度继续挂 `day`。六个区的补光现在都在黄昏转暖：
蒙德 `0.62 → 1.27`、龙脊 `0.81 → 1.44`、璃月 `1.52 → 2.30`。

### 三、门禁：四条数值 + 一条像素 + 一次「把修好的东西撤回去」

数值那四条按区跑，用的是**地面着色器自己的单位**（`lum(groundSunColor)` 除以
`mix(uAmbGround, uAmbSky, ·)` 的亮度乘 `uAmbInt`）：

1. **太阳在地平线以上的每一个小时都不比正午平**。三个户外区量出来的最小值**正好等于**
   正午值（1.729 / 1.077 / 1.419），修前是 0.95 倍——这条最先绊住以后的改动。
2. 一天里反差最大的时刻是**低太阳**（`golden > 0.9`），且至少是正午的 1.15 倍。
3. **反差是补光掉出来的，不是太阳灭出来的**：峰值时刻的直射仍有正午的 0.55 倍
   （修前 0.31），补光只剩 0.37 倍。少了这条，`114,63,38` 配一片暗补光也是「高反差」。
4. 补光在黄昏转暖、天黑后转冷。

像素那条量的是「地面有多少落在自己中位数的 ±20% 内」——**相对**中位数，
否则一个单纯更暗的小时会被算成更平的小时。门槛故意留松（0.95）：同一个 build
两次跑出来 0.636 和 0.705（循环停了，但草停在风把它吹到的相位上，天气每次钉都重摇），
这个数字撑不起一条紧门槛。它拦的是「黄昏拍出来和正午一样平」。

真正把项钉住的是那次撤回：在 17:36 把 `uSunColor` / `uAmbInt` 按**修前的表达式**
写回地形自己的 uniform（`#df9166 → #a96e4d`），地面中位亮度 `55.2 → 51.2`，
**487131 px 变了**；同一段代码在 12:00 算出来的是同一组数，帧 **0 px 变化**——
后一半就是「正午逐位不变」这条断言，用像素说了一遍。撤回时要带上天气的 `dim`
（`_dim` 在天光之后乘这同一个 uniform），否则一次多云的钉会被当成本轮造成的差别。

### 验证

- `tools/daylight-check.mjs`：**181 passed, 0 failed, 0 skipped**（修前 157；新增 24 条：
  数值 21——四条按区跑，第 1 条只对户外三区断言——加像素 3）。
- `12:00 是逐位的原值`那一节六个区仍然全绿；正午那张照片的中位亮度 123.5、
  ±20% 内 85%，与修前逐位相同。
- `tools/weather-check.mjs` **129 / 0 / 0**、`tools/shadow-check.mjs` **26 / 0**——
  后者扫的 08:00 / 16:00 两个小时 `day` 都已经是 1、`golden` 是 0，`beam` 和
  `(1 - 0.30·golden)` 在那里恒等于 1，所以那 26 条量的是同一批像素。

## 200 米外的树在雾里，它脚下的山坡不在——世界有两片空气

同一句抱怨的第三轮。前两轮修的是**一个小时**的光，这一轮修的是**距离**：
现实里远处发灰、发蓝、掉饱和度，这是眼睛判断「有多远」的主要线索之一，
少了它，一张风景照就是一张贴纸。游戏里这条线索只有一半的物体有。

### 一、`fogNear` / `fogFar` 那扇窗从来没有打开过

three.js 只给**它自己拥有材质的**网格上雾（`scene.fog = FogExp2(色, 密度)`，
顶点着色器里 `vFogDepth = -mvPosition.z`）。地形和水是自己写的 `ShaderMaterial`，
于是它们各自实现了一套**完全不同**的雾：

```glsl
float fog = smoothstep(uFogNear * 2.2, uFogFar * 2.4, camD);   // 修前
```

蒙德的 `fogNear: 90, fogFar: 460` 代进去是 **198 → 1104 m 的窗口，而地图只有 420 m**。
也就是说地面的雾项在**玩家见过的每一帧里都恒等于 0**（玩家视角看不到 150 m 以外）。
后果是同一片空气里两种规则：

| 蒙德，正午 | 修前 | 修后 |
| --- | --- | --- |
| 3 m 处草地 饱和度 | 0.420 | 0.408（0–40 m 带） |
| 140 m 处同一种草 饱和度 | **0.433** | 0.349（90–150 m 带） |
| 150–220 m | — | 0.114 |
| 220–400 m | — | 0.051 |
| 200 m 处一棵树的雾量 | 9.7% | 和它脚下的山坡一样 |
| 它脚下的山坡 | **0.0%** | 同上 |

最难看的是龙脊的暴风雪：`scene.fog` 把 150 m 外的道具吃掉 **89%**，
它们站着的地面只暗了 **2.7%**——一场白毛风，底下透出一层硬邦邦的地板。
天气系统 `fogDensity` 每天摇一次，摇的也只有 `scene.fog` 那一半。

### 二、修法是让地面复述 three.js 自己那一行

不是「加一个雾」，是把地面接到**已经存在**的那片空气上，所以表达式必须逐字相同：

```glsl
// 与 three.js 的 fog_vertex 同一个量，不是 length(cameraPosition - vWorld)：
// 地面和站在地面上的道具必须在同一片空气里，而视深与径向距离在画面边缘差 13%。
vFogDepth = -(viewMatrix * wp).z;
...
float fogD = uFogDensity * vFogDepth;
float fog = 1.0 - exp(-fogD * fogD);
float lum = dot(col, vec3(0.299, 0.587, 0.114));
col = mix(col, mix(col, vec3(lum), 0.35), fog * 0.6);   // 空气还吃饱和度
col = mix(col, uFogColor, fog);
```

`camD`（`length(cameraPosition - vWorld)`）在这个文件里有六个读者（`nearW`、`grit`、
`rockNear`、`sastW`、`crust`、`aa`），全都该用径向距离；雾不该，所以它拿到自己的 varying。
水同样加一份（不加去饱和那项）。天气那一半是一个 `applyWeather(w)`，
在 `world.js` 里紧挨着 `weather.setStorm` 调用——**同一处改两个地方**，和 `dim` 是同一种约束。

`fogNear` / `fogFar` 这下一个读者都没有了，于是从六个区和 zoneGate 的表里一起删掉
（「授权的键必须有具名消费者」那条门禁是双向的，只删一边过不去）。
它们留下的空缺换成一条**用区自己的尺寸计价**的门禁——密度对不对，只相对于「能看多远」才有意义：

```js
const halfD = Math.sqrt(Math.LN2) / z.sky.fogDensity;   // 半不透明距离
// 必须落在 (0.15, 1.6) × 该区自己的 size
```

六个区：蒙德 520/420、龙脊 198/380、璃月 463/440、深渊 64/130、冰洞 64/150、黄金屋 69/160。
**修前那扇 1104 m 的窗在 420 m 的地图上是 2.6 倍，这条门禁会直接判它红。**

### 三、门禁：一帧里的两块地面，各自用射线证明自己是什么

新的一节（`tools/weather-check.mjs`，蒙德和龙脊各跑一遍，密度差 2.6 倍）：

1. **空气是一个数**——`terrain.uFogDensity === scene.fog.density === water.uFogDensity`，
   三个地方都要到；雨天蒙德 `0.0016 → 0.002824`，暴风雪龙脊 `0.0042 → 0.01008`。
2. **那个数以「距离」的形式落到地面上**——一帧里一块近地面、一块远地面，
   各打 5 条射线证明它确实是地形、确实在那个距离（蒙德 41.9 m / 239.9 m，龙脊 38.1 m / 163.9 m）。
   看哪个方向是**量出来**的：龙脊出生点正对着 65 m 外的坡，扫一圈罗盘才挑出 yaw 4.6。
3. **撤回**：把密度写成 0，也就是修前那张画（旧窗口在这两块远地面上给的是 0.6% 和 4.0%，
   新的空气给 13.7% 和 37.7%；玩家自己的相机上旧值恰好是 0）。
   远处那块的饱和度 **+168% / +66%**，近处那块 **+4% / +3%**，帧变 325651 / 445785 px。
   门槛全是**量出来的噪声地板的倍数**，不是手写的常数。
4. **风暴是「差」，不是「一个数变了」**：风暴既加厚空气又调暗光，单看一块地面无法区分。
   远近亮度差 蒙德 `50.8 → 82.5`、龙脊 `18.6 → 42.9`，同时**近地面变暗**
   （97.8 → 90.9 / 152.4 → 147.4）而**远地面变亮**（148.6 → 173.4 / 171 → 190.3）。
   只调暗或只加一层色罩，两块地面会同向移动，这条就红。

第 4 条第一版写的是「远处掉饱和度」，蒙德判红——**它的空气本身是饱和的蓝白 `#c8ddf0`，
而 240 m 外的山坡已经洗得比空气还灰**，加厚雾反而把饱和度**抬**上去（0.033 → 0.093），
龙脊则是掉下去（0.174 → 0.080）。真正两个区都成立的说法是「往空气自己的颜色走」，
量成到 `fogColor` 的色距，并且**两头都钉**：远地面 ×0.64 / ×0.68，近地面 ×1.03 / ×1.08
（近地面反而在远离——它是被调暗的）。

### 四、修雾顺手挖出来的四个探针缺陷

前三个都属于「照片不是它声称的那张照片」：

- **截图拿到的是最后一次合成的帧。** 移动相机后的第一张，可能还是上一台相机那张。
  这个缺陷伴随这个探针一生，一直没人发现，因为它一直在**同一个山坡**上量天穹：
  `dome-clear.png` 其实是走路相机的帧，DOME 那块矩形是山坡；我这一轮把那片山坡刷成灰
  （157,160,157）才让它露出来。修法在 `shoot()` 里：渲染 → 等 250 ms → 再渲染 → 截图。
- **龙脊那两张「大雪 vs 暴风雪」是从坡体内部拍的**，一片近黑的多边形内壁，
  相差 **6168 px**；而它此前「通过」的 621669 px 本身就是上面那个陈旧帧的产物。
  现在这一节排在新的大气段之后，用它量出来的 yaw 拍：**642738 px**。
- **刚换完区的那一帧还在收敛**：`settle 664150 px → floor 0 px`。
  所以每个读数都取第三张，而噪声地板量的是**参考帧自己所在的那一对**——
  跨着收敛区间量出来的地板，是给另一帧用的地板。
- **落雪让近地面那块矩形没法读**：一次只可能改动它 2% 的撤回，量出来动了 37%，
  4000 个叠加粒子从矩形里穿过。所以地面读数在**藏掉降水**的帧上取，
  再把降水放回去证明它真的在那儿（蒙德 3600 个点动 17985 px，龙脊 6400 个点动 679271 px，
  地板 0 / 59524 px）。

第四个是 `tools/player-aura-check.mjs`：它**在磁盘上却没有 SPEC 行**，
于是 check-all 的「没有一个探针可以不被登记」那条门禁一直在拒绝跑**整个套件**——
这一轮想跑一遍视觉组才发现套件根本起不来。补上行之后它是红的，
红的那几条全是**光画在哪里**：特效中心离角色自己的投影 6.6 m。
它两次跑出来还不一样（单跑 45 / 6 / 2，套件里 46 / 5 / 2），说明其中一条量的是
一个会动的东西在屏幕上的位置。这行登记的作用是让它一直亮着，不是把它藏起来；
修它是下一件事，不是这一件。

### 验证

- `tools/weather-check.mjs`：**151 passed, 0 failed, 0 skipped**（修前 129；新增 22 条）。
- `node tools/check-all.mjs --group visual`：**23/24 GREEN，1229 条断言**，39 分钟。
  雾会动到的那些全绿且数字没退：`vault-cam` 30、`inlay-cam` 72（室内密度 0.012–0.013
  现在真的在走廊尽头起雾）、`prop-check` 156、`daylight-check` 181（与修前逐条相同）、
  `shadow-check` 26、`tour`、`light-space`、`motion-check` 158、13 个 `enemy-cam`。
- `zoneGateReport()` 0 条；`fogNear` / `fogFar` 在 `shared/` 与 `client/` 里已无任何读者
  （只剩两处记录这个旧缺陷的注释）。
- 三处密度逐帧相等，风暴按同一因子放大：蒙德 ×1.765、龙脊 ×2.4。
- 唯一的红：`player-aura-check`（**不是本轮引入的**，见上）。

## 已知限制

- **玩家被冻结不会真的被冻住。** `p.aura.isFrozen()` 现在没有任何读者：
  水 + 冰 打在玩家身上会正确产出 `freeze` 反应、正确记 `frozenUntil`，
  但服务端不拦移动、客户端也没有对应的锁和 HUD（怪那一侧是 `e.frozen` 走
  `updateEnemy` 的早退）。这是上面那族缺陷里同一类的最后一个洞，
  需要客户端输入锁 + HUD 提示，单独一轮做。
- ~~联机秘境的通关收据是**第一层、2★**~~ —— 已解决：`tools/deep-check.mjs` 把八层全打完了
  （**116 / 0**），1★/2★/3★ 三条时间带、五种地脉异变、两个 Boss 的相位与护盾、
  以及分账都有收据。见上面那一节。剩下的仍然是「探针够不够强」这件事本身：
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
  九种敌人两遍都是声明值的 100-102%，噪声地板 0 px。见上面那一节。
- ~~**霜狼背面机位有一块 2.17% 的白斑**~~ —— 已解决，而且当时写的病因是错的：那块白斑在轮廓
  **里面 32 px**（Chebyshev 距离变换），fresnel 边光（`1 - N·V ≥ 0.70`）到不了那里，
  所以「按白斑到边界的距离加权」这条计划中的门禁在它身上会读到 0 px。真正的病因是
  `bands: 2` 的皮毛在一块平面上的漫反射亮带 + 太亮的 albedo，修法是 albedo 第三步
  （`0x93b0cc → 0x86a1bd`）加上「每只怪的高光用自己皮毛的色相」（`hideSpec`）。
  读数 **651 px / 2.17% → 230 px / 0.43%**（门线 1.2%）。见上面那两节。
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
  是真的**附着 → 切人 → 触发**，光由服务器算出来的 `reaction: 'swirl'` 点亮（见上面那一节）。
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
  这不是配置懒——世界模拟活在进程里（见上面 部署到 AWS 那一节），两个任务就是两个世界。
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
