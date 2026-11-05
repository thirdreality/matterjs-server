# 2026-11-05 真机配网与控制测试记录

在 HUBV3 上，用 matter2mqtt 1.5.5-tr.3（本分支，matter.js 0.18.0）给四类真机配网并逐项测试 MQTT 控制。
本文按时间记录现象、证据、结论和改动，供维护本 bridge、C++ 版 matter2mqtt 和固件的同事参考。
结论性的踩坑已同步到 [mqtt_bridge_dev_notes.zh-CN.md](../mqtt_bridge_dev_notes.zh-CN.md) 第 18 条。

## 环境

| 项 | 版本 / 配置 |
|---|---|
| 主机 | HUBV3（ARM，2 GB 内存），内核 6.6.158，BlueZ 5.66 |
| matter2mqtt | 1.5.5-tr.3（matter.js 0.18.0），`--ble-proxy`，MQTT 在 `127.0.0.1:1883` |
| BLE 代理 | matter-ble-proxy 0.7.1（bleak + BlueZ，经 WebSocket `:5580/ble` 接入），打了 installer 的补丁 |
| 安装包补丁 | `matter_ble_proxy_mtu.patch`（BTP 用协商后的 ATT MTU）、`matterjs_commissioning_timing.patch`（WiFi 配网时序） |
| 本机 zigbee2mqtt | `/opt/zigbee2mqtt`（converters 26.61.1），用来核对 z2m 的实际行为 |

## 结果一览

| 设备 | 网络 | 配网 | 控制测试 | 结论 |
|---|---|---|---|---|
| ThirdReality MatterSwitch（VID 5127 / PID 12424） | Thread | 前两次失败，关掉 MTU 补丁后成功（node 6） | — | **MTU 补丁导致**，见第 1 节 |
| Nanoleaf NL68 灯带（VID 4442 / PID 68） | Thread | 前四次失败，第五次成功（node 11） | 45 项过 43 项，2 项是测试预期写错 | 失败都在 BLE 代理这一层，**与 MTU 无关**，见第 2 节 |
| ThirdReality Smart Bridge MZ1（VID 5127 / PID 4744） | WiFi | 一次成功，21 s（node 12） | — | 正常 |
| MZ1 下的 4 个 zigbee 子设备 | — | 拆分为 `12_2`…`12_5` | 灯 43 项过 42 项；传感器、按钮正常 | bridge 正常；发现若干 MZ1 固件问题，见第 3 节 |

当天上午的三盏 ThirdReality 夜灯测试发现的都是 bridge 问题，已在 `81ef559`、`3ad445c` 修复，见 dev notes 第 3b、3c 条。

## 1. ThirdReality Thread 开关：BTP 大分段导致链路中断

### 现象

`Peripheral … disconnected unexpectedly`，PASE 超时，配网失败。06:27 和 06:31 两次都一样。
这个开关以前在 Python Matter Server 上配网成功过。

### 证据（HCI 抓包 `hci-20261105-062949.snoop`）

1. 连接、ATT MTU 协商（498）、服务发现、订阅 indication、BTP 握手全部正常。
   我方 BTP 分段 244 字节，设备回 241 字节，窗口 5。
2. 链路层数据长度协商的结果是：我方发送方向每个链路层包最多 **27 字节**。
   hub 的控制器自己支持 251 字节（`LE Read Suggested Default Data Length` 为 251），
   所以 27 字节是**开关的接收上限**。
3. 第一个 PASE 包（PBKDFParamRequest）是 112 字节的 ATT 写入，需要拆成 5 个链路层分片。
   设备在链路层确认收到了全部分片（`Number of Completed Packets`）。
4. 之后双方 5 秒内完全没有通信，以 `Connection Timeout (0x08)`（监督超时）断开。
   设备 10 ms 后就用同一个地址重新广播，说明它没有重启，是双方同时失去了对方。

### 对照实验

临时关掉 MTU 补丁，BTP 回到 20 字节分段，所有 ACL 包都不超过 24 字节，一个链路层分片就能装下。
同一台开关 **06:44 配网成功**（抓包 `hci-20261105-064217.snoop`，日志 `m2m-20261105-0644-ok.log`）：
PASE 用 5 s，整个配网 67 s。两次的链路层参数完全一样。

### 结论与现状

- 这个开关的固件处理不了需要链路层分片的 ATT 写入。还没有区分出它怕的是"分片"本身还是"大写入"，
  需要用中间分段（例如 40 字节）再做一次实验。这个现象要报给固件团队。
- 不打补丁的 matter.js 默认就是 20 字节分段，所以上游不受影响，问题只出在我们的安装包里。
- **MTU 补丁仍然启用**，所以安装包里的 matter2mqtt 给这款开关配网仍会失败。补丁不能直接删：
  当初就是靠它把 WiFi 夜灯配网时的关键读取从 5.6 s 降到 0.24 s。
- 候选修法（待定）：
  1. 按链路层协商结果选分段：对方单包只收 27 字节就退回 20 字节分段。
     bleak / BlueZ 的 D-Bus 接口不提供这个值，代理要另外监听 HCI 事件。
     先要确认 WiFi 夜灯协商出来的是 251。
  2. 按 VID/PID 名单退回小分段。型号可以从广播数据读到，而这款开关每次进入配网模式都会换 BLE 地址
     （`C2:55…` → `EF:E9…` → `C7:E0…`），所以不能按地址记。

## 2. Nanoleaf 灯带：BLE 代理层的三个问题

灯带在 244 字节分段下工作完全正常，失败都和 MTU 无关。

| 时间 | 现象 | 原因 | 确定程度 |
|---|---|---|---|
| 06:50 | 正好 10 s 后报 `[org.bluez.Error.Failed] br-connection-canceled` | bleak 的连接超时是 10 s，超时后取消连接；就我记忆，BlueZ 5.66 取消进行中的连接时，无论哪种承载都报这个字符串（未对照源码核实）。为什么 10 s 没连上见下文"扫描期间连接被推迟" | 推断，那次没抓包 |
| 06:54、07:07 | 十几毫秒就报 `device 'dev_F0_82_…' not found`，然后空等约 3 分钟才失败 | 代理把地址解析成扫描时缓存的 `BLEDevice`，扫描停了一阵后 BlueZ 已删除这个设备的 D-Bus 对象；matter.js 把这次失败算作该设备唯一一次尝试，之后设备两次被重新发现也不再连 | 已坐实（日志） |
| 06:57 | 已经走到 Thread 扫网，突然断开 | **我用 `bluetoothctl disconnect` 断开了正在配网的连接**（HCI 显示本机发起的 Disconnect，原因 0x16） | 已坐实 |
| 07:13 | 成功 | 代理刚重启过，缓存为空，第一次就按地址连接 | — |

### 扫描期间连接被推迟

07:13 那次，代理 07:13:26.4 收到连接命令，HCI 的 `LE Create Connection` 却到 07:13:35.9 才发出。
开关那次的抓包也一样：`Discovering: Disabled` 之后立刻发出连接请求。

08:54 灯带重新配网时（`hci-20261105-085256.snoop`）看得最清楚：代理只收到一次 `start_scan`（08:54:28.5），
BlueZ 随后**自己**每约 10.4 s 开始新一轮 LE 发现（`Start Service Discovery`）。连接命令 08:54:29.46 到达，
设备的广播是新的，但 `LE Create Connection` 直到这一轮发现结束（`Discovering: Disabled`，约 9.5 s 后）才发出。
（之前把这个 10 s 周期写成"matter.js 重启扫描"，是错的。）

三次抓包一致：**发现进行中，LE 连接请求要等当前这一轮发现结束才发出**，最长约 10 s；而 bleak 的连接超时也是 10 s，
晚一点就会失败（06:50 那次很可能就是这样，但没有抓包）。Matter 的 C++ SDK 在 Linux 上是先停止扫描再连接的。

另外，链路建立偶尔失败：06:55–06:57 直接连接 6 次，有 2 次是 `Connection Failed to be Established (0x3E)`。

### 改动

第一版是 `matter_ble_proxy_connect_retry.patch`（LinuxBox-Installer `d090c17`）：
用缓存对象连接失败时，按纯地址重试一次，由 bleak 先扫描到设备再连。它的重试分支在真机上没有触发过
（07:13 那次代理刚重启，缓存为空，第一次就连上了）。

之后对照了 Home Assistant 的接法（第 6 节），发现两点，于是换成了第二版：

1. **旧地址是 matter.js 自己记住的。** 它的 `BleScanner` 把发现的设备保留 15 分钟，只有客户端报告
   "实际扫描了多长时间"（`listeningTime`）时才会把不再广播的记录判为过期，而 `ProxyBleClient` 没有实现这一项。
   所以新的配网请求一开始，matter.js 就拿上一轮的记录去连：开关 06:31 连 `C2:55`，灯带 06:54、07:07 连
   `F0:82`，都在开始扫描约 100 ms 后。
2. **代理串行处理命令**，消息循环处理完一条才接下一条。按地址重试遇到已经轮换作废的地址时，bleak 会一直扫描到
   30 s 超时，期间整个代理被卡住，包括 matter.js 对设备新地址发起的并行连接。

第二版 `matter_ble_proxy_fresh_advertisement.patch`（`3fade17`，改的是 `bleak_backend.py`）：
只连接最近 3 s 内广播过的地址；否则在当前扫描中最多等 3 s，等到了就用新的设备对象连接，等不到就报 not found。
因为串行处理，等待必须短；配网模式的设备至少约 1.2 s 广播一次。

用模拟的设备和广播离线验证过 7 种情况：刚广播过、过时后重新广播、一直不广播、地址不存在、两个连接同时等同一台设备、
没有扫描、没有扫描来源。**还没有在真机上验证。** 真机上看代理日志：
`Waiting up to 3 s for … to advertise before connecting`，以及等不到时的 `… did not advertise within 3 s; not connecting`。

两个补丁都与 MTU 补丁互不依赖；在 site-packages 目录下 `patch -p1` 也能打，buildroot 可直接用。

08:54 装上第二版后，灯带移除、恢复出厂、重新配网，一次成功（node 14）。但这次走的是普通路径：连接命令到达时
设备 0.1 s 前刚广播过，日志里没有 `Waiting…`，所以只说明新补丁没有破坏正常配网，**它要处理的旧记录情况仍未在真机上验证**。
要验证，需先让 matter.js 扫到设备但不连接（例如用鉴别码不匹配的配网码发起一次短发现），等 1–2 分钟后再正式配网。

### 控制测试（`full-strip-20261105-072126.log`）

45 项过 43 项。失败的 `hue_step`、`saturation_step` 是测试预期写错：bridge 把步长按 ColorControl 原始单位
（0–254）直接发出，60 对应约 85°。本机 zigbee2mqtt 的 `light_hue_saturation_step` 也是原样发 `stepsize`，
所以 bridge 和 z2m 一致，脚本已改正。

其他观察：

- 灯带出厂 `on_level` 为 1，关灯后再开灯会回到最低亮度。设备设置，不是 bridge 问题。
- 灯带的订阅最小间隔是 1 s（`Subscribe min: 1s`，开关是 0），部分命令的回报延迟因此约 1 s。为什么 matter.js 对它选 1 s，还没查。
- 早些的测试 1 里 "off" 失败：灯带本来就是关的，命令成功但状态没变，bridge 就没有发布任何状态。见第 4 节。

## 3. MZ1 网桥与 zigbee 子设备

### 配网与拆分

WiFi 配网 21 s，PASE 1.3 s。之后在 MZ1 上加入 4 个 zigbee 设备，bridge 正确拆成独立设备：

| 设备 | 型号 | 设备类型 | 结果 |
|---|---|---|---|
| `12_2` | 3RTHS24BZ 温湿度 | TemperatureSensor + HumiditySensor | 温度、湿度、电量正常上报 |
| `12_3` | 3RSB22BZ 按钮 | GenericSwitch | 动作 `single` / `double` / `hold` / `release`；中途被移除又重新加入，`device_leave`、`device_joined` 和 retained 清理都正确 |
| `12_4` | 3RSNL02043Z 彩色夜灯 | LightSensor + ColorTemperatureLight + OccupancySensor | 控制测试 43 项过 42 项，100–350 ms；光照、人体感应正常 |
| `12_5` | 3RMS16BZ 人体传感器 | OccupancySensor | 有人、无人正常（约 2 min 恢复）；厂商簇 `0x130dfc04` 暂未处理 |

`bridge/event` 依次发出 `device_joined`、`device_interview`，Home Assistant 发现里子设备挂在 MZ1 下面。

`12_4` 唯一的失败：把 `current_level_startup` 改成 previous 时它本来就是 previous，写入成功但值没变，bridge 没有发布状态。
原因同第 4 节。

### 按钮事件核对（`mz1-switch-events-20261105-074822.log`）

用 WebSocket `start_listening` 录下 MZ1 的原始 Switch 事件，和 bridge 的动作逐条对照，**10 次全部一致**。
MZ1 会在约 10 ms 内把整套事件发完，例如一次双击：InitialPress → ShortRelease → InitialPress →
MultiPressOngoing(2) → ShortRelease → MultiPressComplete(2)。这说明双击是 zigbee 按钮自己识别的，MZ1 只是翻译。

**未完成**：用户感觉 `double` 偏多，但这次没有记录每次实际按的是什么，所以无法判断按钮是否误报。
07:45:40 长按松开后 50 ms 又多出一个 `single`，可能是 MZ1 在 LongRelease 之后补发了 MultiPressComplete(1)
（规范规定长按之后不应再发），但当时没有录原始事件，需要再长按一次验证。

### MZ1 固件问题（待报固件团队）

| 问题 | 证据 |
|---|---|
| PowerSource `BatVoltage` 单位错误 | 原始值 25、21。Matter 规定单位是 mV，看起来是把 zigbee 的 100 mV 单位原样转了过来（实际约 2.5 V、2.1 V）。bridge 按规范原样发布 `voltage` |
| `12_4` 的设备类型和能力不一致 | 声明 ColorTemperatureLight（0x010C，规范要求支持色温），但 ColorControl FeatureMap 为 9（只有 HS 和 XY），ColorCapabilities 为 0，却又带着只有支持色温才该有的 StartUpColorTemperatureMireds |
| FixedLabel 是 SDK 示例默认值 | Endpoint 0 显示 "bedroom 2 / North / 2"，和夜灯同一问题 |

## 4. bridge 待改（TODO）

1. **`/set` 成功但设备状态没变时不发布状态。** z2m 在 `/set` 成功后总会发布一次状态，等待确认的界面依赖这条消息。
   今天在灯带（off）和 `12_4`（`current_level_startup`）上各触发一次。补发时要放在合并窗口之后，避免重新引入半更新状态。
2. **`color_temp_startup` 应以 ColorControl 的 CT 特性为准**，而不是只看属性是否存在。z2m 只在灯支持色温时暴露它。

## 5. BLE 代理待改（TODO）

1. 连接前停止扫描，消除最长 10 s 的连接推迟（第 2 节）。
2. MTU 按设备回退（第 1 节）。
3. 根源修法：`ProxyBleClient` 实现 `listeningTime`，让 matter.js 自己淘汰不再广播的记录。这是上游 OHF 的代码，
   按约定等上游处理，可以把本记录整理成材料报给他们。
4. 连接时设置连接参数（第 6 节），尤其是建立阶段的监督超时，需要真机验证。

## 6. 与 Home Assistant 内置 BLE 代理的对比

HA 和我们用的是同一个库 matter-ble-proxy 0.7.1，协议处理相同；区别在库外面接的扫描、设备解析和连接。
依据是 `/srv/homeassistant` 里的代码（HA 当天未运行，没有实测）。

| 方面 | Home Assistant 内置 | 我们（独立的 matter-ble-proxy） |
|---|---|---|
| 扫描 | HA 蓝牙组件一直在扫描，代理只注册回调；可用 ESPHome 蓝牙代理 | 按 matter.js 的 `start_scan` / `stop_scan` 自己启停 |
| 旧广播 | 丢弃 30 s 以前的历史广播，防止轮换地址的旧 MAC 成为连接候选 | 原本不过滤；现由 fresh advertisement 补丁处理 |
| 设备解析 | 从 HA 设备表取，一直在扫描所以不会过期 | 扫描缓存，会过期 |
| 连接参数 | 连接前经 BlueZ 管理接口设为 7.5 ms 间隔、10 s 监督超时，连上后改为 8.75–11.25 ms、8 s | BlueZ 默认：30–50 ms，建立阶段监督超时 420 ms |
| 适配器 | 多适配器或代理时选信号最好的，有连接槽管理 | 本机一个适配器 |
| 重试 | 无（HA 还会为此打警告） | 无 |
| BTP 分段 | 无 MTU 补丁，20 字节：慢但兼容那款开关 | MTU 补丁，244 字节：快，但那款开关失败 |

## 7. 过程中的教训

- **不要用命令行工具碰正在配网的设备。** `bluetoothctl connect/disconnect` 作用于同一个 BlueZ 设备对象，会直接断开 matter.js 的连接。
  要测链路，就先确认没有配网请求在进行。
- **BLE 代理开 DEBUG 时 journald 会被刷爆。** 本机 `SystemMaxUse=20M`，D-Bus 信号刷屏几分钟就把要看的日志轮转掉了。
  HCI 抓包（`btmon -w`）写文件，不受影响，应作为主证据。
- **MQTT 通配符 `+` 必须单独占一级。** `matter2mqtt_12_+` 这样的过滤会让 mosquitto_sub 立刻报错退出，后台录制看似启动、实际没录。
  启动录制后要先确认收到了数据。
- **补丁"装上后成功"不等于"补丁生效"。** 先确认对应的分支真的执行过（看日志标记），再下结论。
- **判断"和 z2m 不一致"之前，先看 z2m 的源码。** 本机就有一份，路径见"环境"一节。

## 原始证据

全部保存在 hub 的 `/root/m2m-dist/`，**没有进仓库**。按本仓库规则，引用其中任何结论都要附完整原始日志。

| 文件 | 内容 |
|---|---|
| `logs/hci-20261105-062949.snoop`、`logs/btmon-20261105-062949.txt` | 开关 06:31 失败（244 字节分段） |
| `logs/m2m-20261105-0631.log` | 同上，matter2mqtt 日志 |
| `logs/hci-20261105-064217.snoop`、`logs/m2m-20261105-0644-ok.log` | 开关 06:44 成功（20 字节分段） |
| `logs/hci-20261105-065244.snoop` | 灯带：直接连接 6 次（2 次 0x3E）、06:57 被本机断开 |
| `logs/m2m-20261105-0650-strip.log`、`logs/bleproxy-20261105-0650-strip.log`、`logs/bluetoothd-20261105-0650-strip.log` | 灯带 06:50–06:58 三层日志 |
| `logs/hci-20261105-070630.snoop`、`logs/m2m-20261105-0713-strip-ok.log`、`logs/bleproxy-20261105-0713-strip-ok.log` | 灯带 07:13 成功（连接推迟约 10 s） |
| `tests/test1-strip-20261105-071730.log`、`tests/full-strip-20261105-072126.log` | 灯带控制测试 |
| `tests/mz1-events-20261105-072807.log` | MZ1 子设备加入、状态、动作的 MQTT 记录 |
| `tests/full-mz1-12_4-20261105-073354.log` | `12_4` 控制测试 |
| `tests/mz1-switch-events-20261105-074822.log` | 按钮原始 Switch 事件 |
| `tests/full_light_test.py` | 完整灯光测试脚本（按设备暴露的能力自动跳过色温项） |
