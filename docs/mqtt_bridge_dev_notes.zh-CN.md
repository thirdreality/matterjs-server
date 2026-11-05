# MQTT bridge 开发记录：问题、踩坑与 TODO

记录 `tr/feature/mqtt-bridge` 在合并上游 1.5.5、对齐 zigbee2mqtt 过程中遇到的问题，以及留给后来者的教训。
其中「踩坑记录」一节与实现语言无关，C++ 版 matter2mqtt 同样适用。

最后更新：2026-11-04。

## 目标

1. 合并上游最新正式版（matterjs-server **v1.5.5**）。
2. 以 **zigbee2mqtt** 为准（不以 C++ 版 matter2mqtt 为准，它也在开发中），完整支持所有 Matter 设备类型及其参数。

## 踩坑记录（跨语言，务必先读）

### 1. BooleanState 本身没有语义，必须看设备类型

Matter 的门磁（ContactSensor `0x0015`）、漏水（WaterLeakDetector `0x0043`）、雨滴（RainSensor `0x0044`）、
冰冻（WaterFreezeDetector `0x0041`）**共用同一个 BooleanState cluster（`0x0045`）**，`StateValue`（属性 0）
都是一个布尔值。四者的区别**只**在该 endpoint 的 Descriptor DeviceTypeList（`<ep>/29/0`）。

- 错误做法：看到 BooleanState 就当门磁。我们的 bridge 曾经这样做（见 P1）。
- 正确做法：按设备类型映射到 zigbee2mqtt 属性，`contact` / `water_leak` / `rain` / `water_freeze`。
- **只有门磁需要取反**：Matter `StateValue = true` 表示"接触（门关）"，HA 的 `door` 类 `on` 表示"门开"。
  漏水、雨滴、冰冻是 `true` = 检测到，**不能**照搬门磁的取反。
- 一个 endpoint 可能同时列出多个设备类型（例如再加一个 PowerSource 设备类型），要遍历整个列表。
- 设备类型都不认识时回落为 `contact`（保持兼容），不要因此不发布。

后果有多严重：漏水传感器被当成门磁、又被取反之后，漏水时 HA 显示"门已关闭"，不漏水时显示"门打开"，
**告警等于不可见**。同类问题在其他"共用 cluster、靠设备类型区分"的场景还会再出现（例如 OnOff 在灯、插座、
水泵、风扇上的含义不同），新增设备类型时都要先查 Descriptor。

### 2. DeviceTypeList 条目的键名有两种

同一个设备类型条目，在 matter.js server 的属性缓存（与 Python Matter Server 兼容的格式）里按 TLV tag 编号作键：
`{"0": 67, "1": 1}`；在别的来源里可能是字段名：`{"deviceType": 67, "revision": 1}`。两种都要接受
（dashboard 的 `getEndpointDeviceTypes` 也是这么做的）。

### 3. retained topic 比进程活得久

MQTT 的 retained 消息会一直留在 broker 上。实体改名（例如 `contact` → `water_leak`）或删除后，旧的 HA discovery
config 不会自己消失，HA 里会留下一个"幽灵实体"。bridge 每次连接都会订阅自己的 retained 命名空间，把不再发布的
topic 清空（`StaleTopics.ts`）。C++ 版需要同样的机制，否则每次改实体都要手工清 broker。

### 3a. 新增 retained topic，必须登记到清理机制的"已知"集合

bridge 每次连接都会把 broker 回放的 retained topic 和自己"应该发布的"集合比对，不在集合里的当残留清空（第 3 条）。
所以每新增一类 retained 内容——网桥子设备的 `<node>_<ep>`、组的 `<prefix>/<组名>` 与组的 discovery——都要同时加入
`knownDevices` / `expectedDiscovery`，否则下一次重连就会把它清掉。组的这个问题是测试先抓到的。

### 3b. 真实固件会上报规范之外的数据，按规范兜底

在 3 盏 ThirdReality 夜灯上实测发现（2026-11-05）：
- **每个 endpoint 都带 Identify cluster**（灯、光照、人体三个都有）。按 endpoint 机械生成控制会得到三份 effect/identify，
  HA 里三个按钮写进同一个 discovery topic 互相覆盖。规则：effect/identify 只挂在灯 endpoint 上；没有灯时只挂在编号
  最小的那个带 Identify 的 endpoint 上。
- **StartUpColorTemperatureMireds 上报 0**，规范范围是 1–65279 或 null。原样发布会让 HA 的数值实体（153–500）拒收。
  超范围一律当"未知"不发布。
- **照度 MeasuredValue 为 0**，规范含义是"太暗测不到"，不是"未知"，应发布 0 lx，否则界面一直显示未知。
- **FixedLabel 是 SDK 示例默认值**（room: bedroom 2 / orientation: North / floor: 2 / direction: up），dashboard 会显示
  出来。属于固件问题，已转固件团队；bridge 不读 FixedLabel，不受影响。

### 3c. 关着的灯会"成功"地忽略颜色命令；一次命令的效果分多条上报

真机控制测试（2026-11-05，Wi-Fi 与 Thread 夜灯各一盏）发现：
- **颜色命令在关灯状态下被静默忽略**：`{"state":"ON","color_temp":250}` 按 z2m 顺序先发色温、后开灯，但灯关着时，
  除非 ColorControl 的 Options 有 ExecuteIfOff，设备回 Success 却不执行，开灯后仍是旧颜色。消息包含开灯动作时，
  颜色命令带上 `optionsMask/optionsOverride = ExecuteIfOff`（Matter 为此设计的逐命令覆盖）。不开灯的消息仍由设备自己的设置决定。
- **一次命令的效果分 2–4 条属性上报，间隔约 1 ms**（先 x 后 y、先模式后数值）。逐条发布会让平台看到从未存在过的
  颜色。属性变化先收集 20 ms 再合并发布；与上次完全相同的状态不再发布（`/get`、重连、改选项除外）。
- 固件观察：Wi-Fi 夜灯开灯时先报亮度 1、约 50 ms 后报目标亮度；Thread 夜灯开灯会把颜色复位成白色。
- 延迟参考：从发布 `/set` 到收到状态，Wi-Fi 约 110–260 ms，Thread 约 180–420 ms。

### 4. 多 endpoint 的属性冲突才加后缀

同一个属性只出现在一个 endpoint 上时保持原名；多个 endpoint 都提供时，按 zigbee2mqtt 的 multiEndpoint 规则加
`_<endpoint>` 后缀（`state_1`、`water_leak_2`），HA 实体 id 与模板同步加后缀。

### 5. 多个属性读同一个 attribute 时，只有"在场"的那个能发布

BooleanState 的四个属性（`contact` / `water_leak` / `rain` / `water_freeze`）读的是同一个 `69/0`。如果发布时
只看"有没有值"，一个漏水传感器会同时发出四个属性。判断顺序必须是：先判断这个 endpoint 是否提供该属性（设备
类型、feature、属性是否在缓存里），再读值。B1 把传感器改成表驱动时正好踩到，被已有测试拦下。

### 6. 单位只在同一量纲内换算，HA 的 device_class 必须与单位匹配

Matter 的浓度类 cluster 由设备在 MeasurementUnit 里自报单位（ppm、ppb、mg/m³、µg/m³、个/m³、Bq/m³）。
- ppm↔ppb、mg/m³↔µg/m³ 可以直接换算；ppm↔µg/m³ 需要气体摩尔质量，**不要换算**，按设备单位原样发布。
- HA 对每个 device_class 只接受特定单位（如 `carbon_dioxide` 只认 ppm）。单位对不上时**去掉 device_class**，
  否则 HA 直接拒绝这个实体，用户什么都看不到。

### 7. zigbee2mqtt 的同名属性：endpoint 优先

z2m 里同一个属性名在不同设备上单位不同：电池电压 `voltage` 是 mV，电量计的 `voltage` 是 V；烟雾报警器自带
`battery_low`，PowerSource 也有。一个设备两者都有时，endpoint 上的属性优先，设备级（PowerSource）的不再发布，
避免同一个键被覆盖、单位来回跳。

### 8. Matter 的 `null` 是"未知"，int64 可能是 bigint

很多测量属性可为 null（传感器还没测到）。null 时不发布该属性，但实体照常注册。int64（电能、频率等）在缓存里
可能是 number 也可能是 bigint，都要接受；结构体字段按 TLV tag（`"0"`）或字段名两种键读取。

### 9. exposes 只描述真正做得到的事

`bridge/devices` 的 `definition.exposes` 是给工具看的契约：z2m 前端和第三方集成会照着它生成控件、校验取值。
它必须和 `/set`、`/get` 的实际行为一致——`TOGGLE` 要真能用，`color_temp` 的范围用设备的物理范围，预设只列落在
范围内的，传感器的 `access` 不能带 SET 位。exposes 和状态发布、HA discovery 读的是同一张传感器表，新增属性时
三者自动同步，不要单独手写。

### 10. 同一个 `/set` 属性名，在不同 endpoint 上含义不同

`state` 在灯上是 `ON`/`OFF`，在窗帘上是 `OPEN`/`CLOSE`/`STOP`，在门锁上是 `LOCK`/`UNLOCK`。`/set` 不能把所有键
都交给一个解析器：先按目标 endpoint 的能力（有哪种设备控制）让各控制认领自己的键，剩下的再给灯，谁都不认的记为
不支持。早期 bridge 只接受带 OnOff 的 endpoint，窗帘这类设备根本收不到命令。

另外注意方向：zigbee2mqtt 的窗帘 `position` 是 0 = 关、100 = 开；Matter 的 Percent100ths 是 0 = 开、10000 = 关，
两者正好相反。

### 11. HA 的模板输出必须和 payload 字符串一字不差

HA 的 MQTT 实体把 `*_value_template` 的输出和 `payload_*` / `state_*` 做**字符串比较**。Jinja 输出 Python 风格的
`True`/`False`/`None`，与 JSON 的 `true`/`false`/`null` 不相等：布尔值要 `| lower`，可能为空的值要 `| tojson`；
枚举映射（如 Matter 独有的 `emergency_heating` 映射到 HA 的 `heat`）也必须在模板里完成，否则 HA 报"不在可选列表"
并把实体置为未知。

### 12. 瞬时事件不能进 retained 状态

按键是"发生了一次"，不是"处于某状态"。如果把 `action` 写进 retained 的设备状态 topic，broker 重连或 HA 重启时会把
上一次按键回放一遍，自动化被误触发。action 要发到单独的非 retained topic（`<node>/action`）。同理，一次按键只能
上报一次：带 MultiPress feature 的按键只在 MultiPressComplete 时报，否则双击会变成两次 single 加一次 double。

### 13. Zigbee 的"全 1"在 Matter 里是 null

Zigbee 用 0xFFFF / 0xFF 表示"沿用上次"或"使用另一个属性"（StartUpColorTemperature、OnLevel、OnTransitionTime 等）；
Matter 对应的属性是 nullable，用 null 表达。对外按 z2m 的约定发布（65535 / 255 / `previous`），写入时再转换回 null。
位图类属性（Options）只改需要的那一位，其余位必须保留。

### 14. Matter 网桥是"一个节点、多个设备"

Zigbee 转 Matter 这类网桥在 Matter 里只占一个 node id，背后的每个设备是一个带 BridgedDeviceBasicInformation（`57`）
的 endpoint，可能还有子 endpoint（双路开关的两路）。按节点发布会把几十个设备挤成一个，丢掉各自的名字、型号和
在线状态。要点：
- 归属按 endpoint parents 往上找到带 `57` 的 endpoint，没有 parents 时用它的 PartsList。
- 名字、型号取 `57` 的属性，不取 `0/40`（那是网桥自己的）。
- 在线 = 网桥节点在线 **且** 子设备的 Reachable（`57/17`）为 true；Reachable 变化要单独处理，它不是普通状态属性。
- 网桥增删子设备时同步清理 topic；网桥节点原来那份合并状态在拆分后要清空，否则 broker 上留着旧的大杂烩。
- 实现上把节点属性按 endpoint 过滤后交给原有逻辑，所有设备能力自动适用于子设备，不必为网桥另写一套。

### 15. ACL 是整表写入，写错就永久失去设备

Matter 的 AccessControl ACL 与 Binding 都只能整张表写入，没有"追加一条"。给开关绑灯时要往灯的 ACL 里加一条授权，
如果直接写入新条目，会把原来的管理员条目（控制器自己）覆盖掉——此后控制器再也无法管理这台设备，只能恢复出厂。
规则：
- 先从缓存读出现有 ACL，追加后整表写回。
- 读不到现有 ACL，或其中没有管理员（Administer + CASE）条目时，**拒绝写入**并报错。
- 先写 ACL 再写 Binding；解绑时先删 Binding 再收回 ACL，且只删自己加的那种条目（Operate、CASE、主体只有源节点）。
- 同一节点内的两个设备（同一网桥后面）互相绑定不需要 ACL：节点访问自己天然有权限。

### 16. hub 资源极其有限（2 GB 内存，4 核 ARM）

- VS Code server 及扩展常驻约 1.2 GB；TypeScript 语言服务（tsserver）单独可涨到 ~580 MB。
- `npm run lint` 的 type-aware 检查（tsgolint）峰值约 570 MB，**曾把整机拖到 OOM 崩溃重启**。
- 现在的做法：
  - swap：zram 978 MB（优先级 5）+ 磁盘 `/swapfile` 2 GB（优先级 -2，已写入 `/etc/fstab`）。
    先用 zram，满了才落盘。
  - 所有构建、lint、测试一律通过 `/root/lowmem-run.sh <命令>` 运行：`GOMAXPROCS=1`、`GOGC=50`、
    `UV_THREADPOOL_SIZE=2`、Node 堆上限 768 MB、`nice 10`，并放进 `MemoryMax=900M` 的 cgroup，超限时内核只杀
    这一条命令。
  - oxlint / oxfmt 加 `--threads=1`。
  - 构建和测试期间不运行常驻的 matter-server 或 bridge。
  - 一次只跑一条重任务，不并发。
- 原始日志一律写到磁盘，**不要写到 `/tmp`**（tmpfs，重启即丢）。

### 17. 在 hub 上跑测试的已知坑

- 起一个 matter-server 进程约需 32 s，其中仅 import ws-controller 就约 26 s（matter.js 0.18，模块初始化开销，
  与 source map 或编译缓存无关）。超时时间按 30 s 写死的测试在 hub 上会超时。
- 以 root 运行时 `chmod 0500` 拦不住写入，依赖文件权限的测试会失败。
- `IntegrationTest` 会发真实的 mDNS 广播、起真实的 Matter 节点，会干扰同机或同网段的其他测试，跑之前先确认。
- 部分 matter-server 测试（DCL、unix socket 等）会 spawn 真实服务进程，同样会发 mDNS。

## 已完成

| 提交 | 内容 |
|------|------|
| `e5ba1fa` | Merge upstream v1.5.5（matter.js 0.18.0） |
| `b83664a` | 1.5 新增配网能力接入 MQTT：`discovery_timeout_s`、错误 `reason`、`parse_onboarding_payload`、`device/share` 补全字段 |
| `e5fdb22` | 修复 P1：BooleanState 按设备类型发布为 `contact` / `water_leak` / `rain` / `water_freeze` |
| `c9fbef6` | 只读传感器：气压、流量、土壤湿度、空气质量与 10 种浓度、烟雾 / CO 报警、电量计、电池详情；传感器改为表驱动（`Sensors.ts`） |
| `ee76161` | C-exposes：`bridge/devices` 增加 z2m 的 `definition.exposes`、`power_source` 等字段 |
| `70a291a` | B2 窗帘；`/set` 改为按 endpoint 能力分派，支持写属性 |
| `456ec6c` | B2 门锁、温控（climate） |
| `f3a7eaf` | B2 风扇、水阀、ModeSelect、水泵模式、烟雾报警器自检与灵敏度 |
| `a292f0f` | B3 按键 action（Switch 事件 → `<node>/action`，HA event 实体与 device trigger） |
| `caa1475` | B4 灯的通用参数：`power_on_behavior`、`color_temp_startup`、`level_config`、`color_options`、`on_time`、`effect` / `identify` |
| `3ee3542` | B7 Matter 网桥拆分：网桥后面的每个设备单独成为 `<node>_<endpoint>` 设备 |
| `e302b5c` | C `bridge/event`、`last_seen`（`--mqtt-last-seen`）、`health_check` |
| `faf9650` | C `device/bind` / `device/unbind`（Binding + 目标 ACL） |
| `3fea9b7` | C `bridge/logging`（`--mqtt-log-level`） |
| `04ac906` | C `device/options`：retain、debounce、transition、invert_cover |
| `189d66a` | C `networkmap`（raw、graphviz） |
| `9d71a65` | C groups（软件组，z2m 组接口） |
| `81ef559` | 真机实测修复（3 盏 ThirdReality 夜灯）：identify 每个设备只出一份、启动色温超范围视为未知、照度 0 发布为 0 lx |
| `3ad445c` | 真机控制测试修复：开灯同时带颜色/色温时颜色不丢（ExecuteIfOff）；同一批属性上报合并为一次发布，重复状态不再发布 |

## 问题

### P1 · 漏水 / 雨滴 / 冰冻传感器被当成门磁发布 —— **已修复（B0）**

bridge 自身的 bug，不是 zigbee2mqtt 或 Home Assistant 的。原因和正确做法见踩坑记录第 1 条。升级后，旧的
`.../contact/config` discovery topic 会被 bridge 的 retained 清理机制自动清掉（踩坑记录第 3 条）。

### P2 · Matter 网桥后面的子设备没有拆成独立设备 —— **已解决（B7）**

Aggregator（如 Hue / Aqara 网关接入的设备）作为一个节点发布，子设备只靠 `_<endpoint>` 后缀区分。z2m 的语义是
每个物理设备一个 topic、一个 HA 设备。需要设计：子设备的 topic 命名、`bridge/devices` 中的表示、可用性与改名。

### P3 · `bridge/devices` 缺少 z2m 的 `definition.exposes` —— **已解决（C-exposes）**

z2m 在 `bridge/devices` 中为每个设备给出 `definition`（型号、厂商、描述）和 `exposes`（每个参数的类型、取值范围、
单位、读写权限），z2m 前端和第三方集成都依赖它。我们目前只有 `vendor_name`、`product_name`、`onoff_endpoints`。
后续每加一类设备都要同步 exposes，**宜尽早定格式**。

### P4 · 测试在 hub 上无法全绿（判断为环境问题，需重新取证）

2026-11-03 的观察：

| 失败 | 判断 |
|------|------|
| ws-controller `WsBackpressureReproTest` 3 条超时（60 s） | 上游 1.5.3 新增的压力测试，单核跑不完 500 轮；干净的 v1.5.5 worktree 在同机复现，耗时与失败一致 |
| matter-server `DclAttestationTest`、`DclOfflineTest`、`UnixSocketServerTest` 超时 | 起服务约 32 s，测试只等 30 s（踩坑记录第 17 条） |
| matter-server `OtaUploadHandlerTest` 2 条 | root 运行 + 时序竞态 |
| matter-server `IntegrationTest` | 未运行 |

**原始日志当时写在 tmpfs，已随重启丢失。** 按本仓库规则，任何 bug 报告或根因结论都必须附完整原始日志。
若要据此向上游报告或下结论，须重新跑并把日志保存到磁盘。

### P5 · hub 上启动慢

matter.js 0.18 下仅加载模块约 26 s（`@matter/main` 本身 14 s）。**没有 1.4.0 的基线，不能断定是回归**。
bridge 自身只增加不到 1 s。

### P6 · 杂项

- 从 checkout 直接运行时，`bridge/info.version` 显示 `0.0.0-git`；release tarball 打包时才写入版本号。
- `/var/lib/matter2mqtt.bak-20261103-pre-1.5.5`：升级到 matter.js 0.18 前的存储备份，确认不再回退旧版后可删除。

## TODO

### 目标 1 · 合并 release

- [x] 合并 v1.5.5
- [x] A 批：1.5 配网能力接入 MQTT
- [ ] review 后 push
- [ ] 在不干扰其他测试的时段跑一次 matter-server `IntegrationTest`（日志存盘）
- [ ] （可选）测一次 1.4.0 的启动耗时，判断 P5 是否为回归

### 目标 2 · zigbee2mqtt 对齐（建议顺序）

- [x] **B0 修复 P1**：BooleanState 按设备类型区分
- [x] **B1 只读传感器**
  - [x] 气压 `pressure`、流量 `flow`、土壤湿度 `soil_moisture`
  - [x] 空气质量 `air_quality`，以及 `co2`、`co`、`pm1`、`pm25`、`pm10`、`voc`、`no2`、`o3`、`formaldehyd`、`radon`（及 `_level`）
  - [x] 烟雾 / CO 报警 `smoke`、`carbon_monoxide`、`alarm_state`、测试 / 静音 / 故障 / 到期状态
  - [x] 电量计 `power`、`voltage`、`current`、`ac_frequency`、`energy`、`produced_energy`
  - [x] 电源详情：`battery_low`、电池电压
  - [x] 市电 / 电池供电类型（`power_source`）：放在 `bridge/devices`
- [x] **C-exposes（P3）**：`bridge/devices` 增加 `definition` 与 `exposes`，补齐已支持设备的 exposes
- [x] **B2 常用控制**
  - [x] 窗帘 WindowCovering → `cover`（`state`、`position`、`tilt`、`moving`）
  - [x] 门锁 DoorLock → `lock`（`state`、`lock_state`、`door_state`）
  - [x] 温控 / 空调 Thermostat、RoomAirConditioner → `climate`（`local_temperature`、`occupied_heating_setpoint`、`system_mode`、`running_state` 等）
  - [x] 风扇 / 空气净化器 / 油烟机 FanControl → `fan`（`fan_mode`、`fan_speed`、`percentage`、`oscillation`、`airflow_direction`）
  - [x] 水阀 ValveConfigurationAndControl → `valve`
  - [x] 水泵 PumpConfigurationAndControl（运行 / 控制模式；转速、压力等读数待补）
  - [x] ModeSelect → `select`
  - [x] 烟雾 / CO 报警的控制：自检（SelfTestRequest）、灵敏度（SmokeSensitivityLevel，可写）
- [x] **B3 按键与事件**：GenericSwitch、Doorbell → `action`（`single` / `double` / `hold` / `release` 等），HA event / device_trigger
- [x] **B4 灯与插座通用参数**：`power_on_behavior`、`effect`（identify）、`color_temp_startup`、上电亮度（`level_config`）、`color_options`、`on_time` / `off_wait_time`
- [x] **B7 Matter 网桥（P2）**：子设备拆成独立 z2m 设备（待用 ThirdReality Smart Bridge MZ1 等真机验证）
- [ ] **B5 家电**：洗碗机、洗衣机、烘干机、冰箱 / 温控柜、烤箱、灶台、微波炉（OperationalState、各 Mode cluster、TemperatureControl）；扫地机 → HA `vacuum`
- [ ] **B6 能源**：EnergyEvse、WaterHeater、HeatPump、SolarPower、BatteryStorage、DeviceEnergyManagement、电表 / 电价
- [ ] **C 桥级功能（其余）**
  - [x] `bridge/event`（设备加入 / interview / 离开）
  - [x] `bridge/logging`（`--mqtt-log-level`，默认 info）
  - [x] `bridge/request/health_check`
  - [x] `last_seen`（默认关闭，`--mqtt-last-seen` 开启）
  - [x] `device/options`（retain、debounce、transition、invert_cover，存于 `mqtt-bridge-device-options.json`）
  - [x] `device/bind` / `unbind`（Matter Binding，开关类设备控灯依赖它；绑定到组待 groups 完成后再做）
  - [x] groups（`bridge/groups`、`group/*`）：软件组，bridge 依次单播给成员
  - [ ] 原生 Matter 组播：**暂不自研，等上游**。需要组密钥集、GroupKeyMap、组 ACL、AddGroup，以及控制器自己持有组密钥；
    截至 2026-11 上游 matterjs-server 已能发送组播，但还没有面向用户的组密钥配置命令（只为认证测试塞过固定密钥），
    Python Matter Server 已停止开发且从未支持。决定：组播普及、上游提供组密钥配置后，合并上游，把软件组的底层换成
    原生组播，MQTT 接口不变。开关直接绑定到组（hub 离线也能控一组灯）依赖它。
  - [x] `networkmap`（复用上游 Thread / Wi-Fi 拓扑，raw 与 graphviz）
- [ ] 厂商私有 cluster（Aqara、Eve、Heiman、IKEA、Yeelight 等，定义已在 custom-clusters 包）按需映射
  - [ ] ThirdReality 计量 cluster（`0x130dfc02`：currentSummationDelivered、instantaneousDemand、multiplier、divisor）→ `energy` / `power`

每批：单独提交、带测试、同步 `docs/mqtt_api.md` 与 `docs/mqtt_api.zh-CN.md`，构建与测试通过 `/root/lowmem-run.sh` 运行。

## 不在 MQTT 范围内

- 摄像头、可视门铃、对讲（Camera、VideoDoorbell、Intercom 等）：视频走 WebRTC，MQTT 不承载；门铃按键事件归入 B3。
- 媒体类（Speaker、BasicVideoPlayer、CastingVideoPlayer、ContentApp 等）：z2m 无对应概念，最后再议。
- 纯控制器与基础设施（各类 Switch / Controller 设备类型本身、ThreadBorderRouter、NetworkInfrastructureManager、
  CameraController、ControlBridge）：没有可发布的状态。

## 附：Matter 设备类型覆盖（82 种，来自 matter.js 模型）

| 分类 | 设备类型 | 状态 |
|------|----------|------|
| 灯 | OnOffLight、DimmableLight、ColorTemperatureLight、ExtendedColorLight | 已支持（含 B4 参数） |
| 插座 / 墙装 | OnOffPlugInUnit、DimmablePlugInUnit、MountedOnOffControl、MountedDimmableLoadControl | 已支持（含 B4 参数） |
| 传感器 | OccupancySensor、LightSensor、TemperatureSensor、HumiditySensor、ContactSensor | 已支持 |
| 传感器 | WaterLeakDetector、RainSensor、WaterFreezeDetector | 已支持（B0 修复） |
| 传感器 | PressureSensor、FlowSensor、SoilSensor、AirQualitySensor、SmokeCoAlarm、ElectricalMeter | 已支持（B1） |
| 控制 | WindowCovering、DoorLock、Thermostat、RoomAirConditioner、Fan、AirPurifier、ExtractorHood、WaterValve、Pump、ModeSelect | 已支持（B2） |
| 按键 / 事件 | GenericSwitch、Doorbell | 已支持（B3）；Chime 待做 |
| 网桥 | Aggregator（及 BridgedNode） | 已支持（B7） |
| 家电 | Dishwasher、LaundryWasher、LaundryDryer、Refrigerator、TemperatureControlledCabinet、Oven、CookSurface、Cooktop、MicrowaveOven、RoboticVacuumCleaner | B5 |
| 能源 | EnergyEvse、WaterHeater、HeatPump、SolarPower、BatteryStorage、ElectricalUtilityMeter、ElectricalEnergyTariff、MeterReferencePoint | B6 |
| 其他 | IrrigationSystem、ClosureController、Closure、ClosurePanel | 待评估（Closure 为 Matter 1.5 新的窗帘/门模型，可并入 B2） |
| 范围外 | Camera、SnapshotCamera、FloodlightCamera、AudioDoorbell、VideoDoorbell、Intercom、CameraController、Speaker、BasicVideoPlayer、CastingVideoPlayer、CastingVideoClient、ContentApp、VideoRemoteControl、各类 Switch / Controller、ControlBridge、ThreadBorderRouter、NetworkInfrastructureManager | — |
