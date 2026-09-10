# MQTT API 文档

> 中文版。英文版见 [mqtt_api.md](mqtt_api.md)（以英文版为准，两份内容保持同步）。

本文档描述 Matter.js server 内置的 **matter2mqtt** 桥（`@matter-server/mqtt-bridge`）的 MQTT API。桥把 Matter
设备状态发布到 MQTT broker，并接收 MQTT 侧下发的命令，topic 布局沿用
[zigbee2mqtt](https://www.zigbee2mqtt.io/guide/usage/mqtt_topics_and_messages.html) 风格。

桥是可选的增量能力：只有传入 `--mqtt-url` 时才启动。不传该参数时，server 的行为与
[WebSocket API](websockets_api.md) 文档描述完全一致。启用后两套 API 并行工作在同一个 controller 之上 —— MQTT
只是 controller 事件中枢的另一个消费者，不是 WebSocket API 的替代品。

## 启用桥

```bash
matter-server --mqtt-url mqtt://user:password@localhost:1883 --mqtt-prefix matter2mqtt
```

| 命令行参数 | 环境变量 | 默认值 | 说明 |
|-----------|---------|-------|------|
| `--mqtt-url <url>` | `MQTT_URL` | *（未设置 —— 桥不启动）* | Broker 地址。支持的协议：`mqtt:`、`mqtts:`、`ws:`、`wss:`。凭据可直接写在 URL 里 |
| `--mqtt-prefix <prefix>` | `MQTT_PREFIX` | `matter2mqtt` | 所有桥 topic 的前缀 |
| `--mqtt-client-id <id>` | `MQTT_CLIENT_ID` | `matter2mqtt` | MQTT client id |

前缀可以包含斜杠（如 `home/matter`），但不能为空、不能以 `/` 开头或结尾、不能包含 `+`、`#` 或空白字符。前缀非法或
URL 协议不支持时，桥在启动阶段直接构造失败。

**安全提示：** MQTT 命令等同于对整个 Matter fabric 的完全控制权，包括配网与解绑设备。桥内部没有按 topic 的鉴权
——任何能向 `<prefix>/#` 发布消息的一方都能控制所有设备、增删节点。请把 broker 放在 localhost 或有防火墙保护的
内网，并启用 broker 的账号与 ACL。

## 连接语义

- **启动不会阻塞在 broker 上。** 连接、重试与退避由 MQTT.js 负责，离线期间待发消息进队列。broker 不可用时 server
  其余部分照常启动。
- **桥会自己拉起 Matter 栈。** 带 `--mqtt-url` 时，即使从未有 WebSocket 客户端连接，controller 也会启动，设备状态
  立即可用。
- **发布使用 QoS 0。** 下文标注 *retained* 的 topic 带 retain 标志发布。`<prefix>/bridge/state` 上的遗嘱消息
  （LWT）为 retained + QoS 1。
- **每次（重）连都会重发完整快照**：Home Assistant discovery、所有设备状态与可用性、设备列表、桥信息、凭据与配网
  模式状态，最后是 `bridge/state: online`。broker 重启会导致遗嘱消息被发出、retained 状态可能丢失，因此桥把每次
  连接都当成一次全量同步。
- **retained topic 会被清空**（发布空载荷）：设备或实体消失时。
- 正常关闭时，桥先在 `<prefix>/bridge/state` 上发布 `{"state":"offline"}` 再断开；异常断开时由 broker 发布同样
  载荷的遗嘱消息。

## Topic 总览

`<prefix>` 为配置的前缀（默认 `matter2mqtt`），`<node>` 为十进制字符串形式的 Matter node id，`<endpoint>` 为
Matter endpoint 编号。

| Topic | 方向 | Retained | 载荷 |
|-------|------|----------|------|
| `<prefix>/bridge/state` | 发布（LWT） | 是 | `{"state":"online"}` / `{"state":"offline"}` |
| `<prefix>/bridge/info` | 发布 | 是 | server 版本、BLE 开关、前缀 |
| `<prefix>/bridge/devices` | 发布 | 是 | 已知设备的 JSON 数组 |
| `<prefix>/bridge/commission_status` | 发布 | 是 | 人类可读的配网进度 |
| `<prefix>/bridge/commission_code` | 发布 | 是 | HA 配网码输入框的状态（每次请求后清空） |
| `<prefix>/bridge/commission_mode` | 发布 | 是 | 当前选择的配网模式 |
| `<prefix>/bridge/wifi_ssid` | 发布 | 是 | 已存或待存的 WiFi SSID |
| `<prefix>/bridge/wifi_password` | 发布 | 是 | 已存密码时为 `********`，否则为空 |
| `<prefix>/bridge/thread_dataset` | 发布 | 是 | 已存 dataset 时为 `********`，否则为空 |
| `<prefix>/bridge/request/<command>` | 订阅 | — | 桥命令请求（JSON；部分命令接受裸值） |
| `<prefix>/bridge/response/<command>` | 发布 | 否 | `{"status":"ok"\|"error", ...}` |
| `<prefix>/<node>` | 发布 | 是 | 合并后的完整设备状态 JSON |
| `<prefix>/<node>/availability` | 发布 | 是 | `online` / `offline`（纯字符串） |
| `<prefix>/<node>/set` | 订阅 | — | 设备命令，JSON 对象或裸值 |
| `<prefix>/<node>/set/<property>` | 订阅 | — | 设备命令，单个属性的裸载荷形式 |
| `<prefix>/<node>/get` | 订阅 | — | 重发当前状态（载荷忽略） |
| `<prefix>/<node>/<endpoint>/set` | 订阅 | — | 同 `/set`，但指定 endpoint |
| `<prefix>/<node>/<endpoint>/set/<property>` | 订阅 | — | 同 `/set/<property>`，但指定 endpoint |
| `<prefix>/<node>/<endpoint>/get` | 订阅 | — | 重发当前状态（endpoint 段被忽略） |

桥实际订阅的 filter：`<prefix>/+/set`、`<prefix>/+/+/set`、`<prefix>/+/set/+`、`<prefix>/+/+/set/+`、
`<prefix>/+/get`、`<prefix>/+/+/get`、`<prefix>/bridge/request/#`。

解析规则说明：

- 设备状态只发布在单一的 `<prefix>/<node>` topic 上，没有按 endpoint 拆分的状态 topic。
  `<prefix>/<node>/<endpoint>` 会被主动清空（早期布局的遗留）。
- `bridge` 永远不会被当成设备，因此 `<prefix>/bridge/set` 与 `<prefix>/bridge/get` 被忽略。
- `<endpoint>` 段必须是数字。段非数字或层级多余的 topic（`<prefix>/5/x/set`、`<prefix>/5/2/3/set`）被忽略。
- `<prefix>/<node>/get/<property>` 不是合法 topic。

Home Assistant discovery 发布在独立且固定的 `homeassistant/` 前缀下，见
[Home Assistant Discovery](#home-assistant-discovery)。

## 桥 Topic

### bridge/state

桥的连通状态，同时注册为 MQTT 遗嘱消息（retained，QoS 1）：

```json
{ "state": "online" }
```

### bridge/info

```json
{
  "version": "1.4.1-alpha.2",
  "ble_enabled": true,
  "ble_proxy_enabled": false,
  "prefix": "matter2mqtt"
}
```

### bridge/devices

controller 已知的全部已配网节点。节点新增/移除、结构变化、可用性变化时重发：

```json
[
  {
    "id": "5",
    "node_id": 5,
    "available": true,
    "is_bridge": false,
    "vendor_name": "ThirdReality",
    "product_name": "Smart Bulb",
    "node_label": "Desk lamp",
    "serial_number": "0123456789",
    "unique_id": "A1B2C3D4",
    "onoff_endpoints": [1]
  }
]
```

`id` 就是 topic 里的 `<node>` 段。`vendor_name`、`product_name`、`node_label`、`serial_number`、`unique_id`
来自 BasicInformation（`0/40/1`、`0/40/3`、`0/40/5`、`0/40/15`、`0/40/18`），属性缺失或为空白时该字段被省略。
node id 以不带引号的 JSON 数字序列化，可能超过 `Number.MAX_SAFE_INTEGER`，参见
[BigInt Handling](websockets_api.md#bigint-handling)。

### 配网反馈 topic

这几个 retained topic 支撑 Home Assistant 的桥卡片，单独使用也很方便：

| Topic | 载荷 |
|-------|------|
| `bridge/commission_status` | 启动时 `idle`；`commission` 请求执行中为 `commissioning...`；结束后为 `ok: node <id>` 或 `error: <message>` |
| `bridge/commission_code` | 始终清空为单个空格（` `）—— 配网码输入是只写的。空的 retained 载荷会被 broker 丢弃，所以用一个空格占位，再由 HA 模板 trim 掉 |
| `bridge/commission_mode` | `Auto`、`WiFi`、`Thread` 或 `Existing (IP)`。重启后回到 `Auto`（该模式只存在内存中） |
| `bridge/wifi_ssid` | 已存的 SSID，或只输入了一半时的待存 SSID |
| `bridge/wifi_password` | 已存密码时为 `********`，否则为空。**明文密码永不发布** |
| `bridge/thread_dataset` | 已存 dataset 时为 `********`，否则为空。**明文 dataset 永不发布** |

## 设备状态

`<prefix>/<node>` 以单个 retained JSON 对象承载节点的完整合并状态（zigbee2mqtt 的 `cache_state` 模型：任一相关
属性变化都重发整个对象）。状态直接由 controller 的属性缓存构建，无需额外读取设备。

```json
{
  "state": "ON",
  "brightness": 200,
  "color_mode": "hs",
  "color": { "hue": 240, "saturation": 100, "h": 240, "s": 100, "x": 0.1355, "y": 0.0399 },
  "color_temp": 250
}
```

### 属性

| 属性 | 来源（`cluster/attribute`） | 取值 |
|------|---------------------------|------|
| `state` | OnOff `6/0` | `ON` / `OFF` |
| `brightness` | LevelControl `8/0` | 0–254（Matter 原始 level） |
| `color_mode` | ColorControl `768/8` | `hs`（0）、`xy`（1）、`color_temp`（2） |
| `color` | ColorControl `768/{0,1,16384}` 或 `768/{3,4}` | 见下文 |
| `color_temp` | ColorControl `768/7` | mireds，设备上报原值 |
| `occupancy` | OccupancySensing `1030/0` | `true` / `false`（bitmap 的 bit 0） |
| `illuminance` | IlluminanceMeasurement `1024/0` | lux，`10^((raw-1)/10000)` 取整；raw ≤ 0 时省略 |
| `temperature` | TemperatureMeasurement `1026/0` | °C，`raw/100` 保留 2 位小数 |
| `humidity` | RelativeHumidityMeasurement `1029/0` | %，`raw/100` 保留 2 位小数 |
| `contact` | BooleanState `69/0` | `true` = 闭合，`false` = 打开（zigbee2mqtt 语义） |
| `battery` | PowerSource `47/12` | %，`raw/2`（BatPercentRemaining 以 0.5% 为单位）。设备级：取第一个 PowerSource |
| `update` | OtaSoftwareUpdateRequestor `42/{2,3}` + BasicInformation `40/{9,10}` | 固件更新状态对象，设备级 —— 见[固件更新](#固件更新) |

`color` 会在各种表示法之间保持一致，做法同 zigbee2mqtt 的 `syncColorState`：无论 endpoint 报告的是哪种模式，
其余表示法都由它推导出来，这样消费方不会读到上一个模式留下的过期值。

| 报告的模式 | `color` 内容 | `color_temp` |
|-----------|-------------|--------------|
| `hs` | `hue`（0–360）与 `saturation`（0–100），外加短键 `h`/`s` 和推导出的 `x`/`y` | 由当前颜色推导 |
| `xy` | `x`/`y`（各为 `raw/65535`，保留 4 位小数），外加由其推导的 `hue`/`saturation`/`h`/`s` | 由当前颜色推导 |
| `color_temp` | 由 mireds 推导出的 `x`/`y` 与 `hue`/`saturation`/`h`/`s` | 设备报告的 mireds |

之所以要发短键，是因为 Home Assistant 的 JSON light schema 只读短键，而它的色盘读 `x`/`y`。endpoint 支持
EnhancedHue 特性时，优先用 `enhancedCurrentHue`（`768/16384`）而不是 `currentHue`。推导出的属性只会在 endpoint
确实具备对应特性时出现（唯一的例外是 `hs` 模式下的 `x`/`y`，它们为 Home Assistant 无条件发布），推导出的
`color_temp` 会被裁剪到 endpoint 的物理 mireds 范围内。从一个高饱和度的颜色推导色温本身就是近似的 —— 这种颜色
离普朗克轨迹很远 —— 但 zigbee2mqtt 报告的也是同样的值。

只有 endpoint 确实暴露了对应 cluster **且** 已缓存到值时，属性才会出现。合并结果为空对象时不发布状态 topic。

### 多 endpoint 设备

暴露 OnOff、OccupancySensing、IlluminanceMeasurement、TemperatureMeasurement、RelativeHumidityMeasurement
或 BooleanState 的 endpoint 会参与状态合并。只有一个 endpoint 提供的属性保持原名；多个 endpoint 都提供的属性，
全部加上 zigbee2mqtt 的 `_<endpoint>` 后缀。因此双路继电器发布的是：

```json
{ "state_1": "ON", "state_2": "OFF" }
```

后缀由 endpoint 的*能力*决定，而不是由当前值决定，所以在值还未知时属性名也是稳定的。

### 固件更新

暴露 OTA Requestor cluster 的节点（存在 `0/42/2`）会带一个设备级的 `update` 属性，形状对齐 zigbee2mqtt：

```json
{
  "update": {
    "state": "available",
    "installed_version": 16777235,
    "installed_version_string": "1.0.3",
    "latest_version": 16777236,
    "latest_version_string": "1.0.4",
    "latest_source": "main-net-dcl",
    "latest_release_notes": "https://example.com/notes",
    "progress": 42
  }
}
```

| 字段 | 含义 |
|------|------|
| `state` | `idle`、`available`（已知有更新的固件）或 `updating` |
| `installed_version` / `installed_version_string` | BasicInformation `0/40/9` / `0/40/10`。`_string` 变体在字符串属性缺失时回落到数字版本，因此只要版本已知就不会是 null |
| `latest_version` / `latest_version_string` | 上次检查得到的目标版本。**没有待装更新时等于已装版本** —— Home Assistant 就是靠这个判断"已是最新" |
| `latest_source` | `main-net-dcl`、`test-net-dcl` 或 `local`。非 `main-net-dcl` 意味着未认证镜像 |
| `latest_release_notes` | DCL 条目带 release notes 时给出其 URL |
| `progress` | 下载进度百分比，仅在 `updating` 时出现 |

`state` 由节点自己的 UpdateState（`0/42/2`）推导：除 Idle/Unknown 之外的任何值都是 `updating`。发出安装请求后
的 15 分钟内，即使节点还报 Idle，桥也会报 `updating` —— 否则 Home Assistant 的安装按钮会在设备真正开始下载
之前就弹回去。这些都不持久化：桥重启后状态重新从节点属性推导。

`available` 需要一次完成的检查。控制器自己会按计划轮询 DCL，但不把结果对外暴露，所以桥必须按节点主动问：
启动后 30 秒一轮，之后每 24 小时一轮，另外可通过 `bridge/request/device/ota_update/check` 随时触发。不可达的
节点会跳过，节点之间间隔 5 秒，避免一轮检查把 DCL 查询打成一阵爆发。

### 触发状态重发的条件

以下属性任一变化都会重发：`6/0`、`8/0`、`768/{0,1,3,4,7,8,16384}`、`1030/0`、`1024/0`、`1026/0`、`1029/0`、
`69/0`、`47/12`、`42/{2,3}`、`40/{9,10}`；此外节点新增、结构变化、可用性变化、固件检查/安装命令以及收到
`<prefix>/<node>/get` 时也会重发。

`47/12`、`42/{2,3}`、`40/{9,10}` 支撑的是设备级属性（`battery`、`update`），所以它们无论落在哪个 endpoint 上
都直接重发状态，不会被误判成结构变化。

### 可用性

`<prefix>/<node>/availability` 是 retained 的纯字符串 `online` 或 `offline`，跟随 controller 的节点可用性。设备
（重新）同步时以及每次可用性变化时发布。节点被解绑时，它的 availability、state 与 discovery topic 都会被清空。

## 设备命令

### `<prefix>/<node>/set`

JSON 对象载荷：

```json
{ "state": "ON", "brightness": 180, "transition": 2 }
```

| 属性 | 可接受的值 |
|------|-----------|
| `state` | `ON` / `OFF` / `TOGGLE`（大小写不敏感）、`true` / `false`，或 `null`（只调亮度不改开关） |
| `brightness` | 0–254（255 也接受，按 254 处理） |
| `brightness_percent` | 0–100，换算到 0–254 |
| `color` | 支持 zigbee2mqtt 的全部颜色形式 —— 见[颜色格式](#颜色格式) |
| `color_temp` | mireds（会按 endpoint 的物理上下限裁剪），或预设值：`coolest`、`cool`（250）、`neutral`（370）、`warm`（454）、`warmest` |
| `transition` | 渐变时间，单位秒（内部换算为 Matter 的 0.1 秒单位） |
| `brightness_move`、`brightness_step`、`color_temp_move`、`color_temp_step`、`hue_move`、`hue_step`、`saturation_move`、`saturation_step` | 相对控制 —— 见[连续调节与步进](#连续调节与步进) |

其他属性会被忽略并打 warning 日志；endpoint 不支持的属性同样如此（例如给普通开关下 `color_temp`）。

**裸载荷。** 不是 JSON 对象的载荷按状态值解释：`ON`、`OFF`、`TOGGLE`、`true`、`false`（以及为兼容 zigbee2mqtt
而识别的 `open`、`close`、`stop`、`lock`、`unlock` —— 目前还没有 cluster 映射它们，会被 warning 拒绝）。

**`<prefix>/<node>/set/<property>`** 接受单个属性的裸值，能解析成 JSON 时按 JSON 解析：

```
matter2mqtt/5/set/state        →  ON
matter2mqtt/5/set/brightness   →  180
matter2mqtt/5/set/color_temp   →  warm
matter2mqtt/5/set/color        →  {"hue":120,"saturation":80}
```

### endpoint 定位

目标 endpoint 按以下优先级确定：

1. 属性上的 `_<endpoint>` 后缀（`{"state_1":"ON","state_2":"OFF"}` 一条消息同时操作双路继电器的两个 endpoint）；
2. topic 中的 `<endpoint>` 段（`<prefix>/<node>/2/set`）；
3. 节点的第一个 OnOff endpoint。

后缀数字不属于已知 OnOff endpoint 时，会被当成属性名的一部分（与 zigbee2mqtt 一致）。命令只对暴露 OnOff cluster
的 endpoint 生效，其余情况打日志后丢弃。

### 颜色格式

`color` 接受 zigbee2mqtt 支持的全部形式，按下表顺序判定（第一个键齐全的形式胜出，所以
`{"x":…,"y":…,"h":…}` 会被当成 xy）：

| 形式 | 示例 |
|------|------|
| CIE xy | `{"x":0.7,"y":0.3}` |
| RGB 分量，0–255 | `{"r":255,"g":0,"b":0}` |
| RGB 字符串 | `{"rgb":"255,0,0"}` |
| Hex | `{"hex":"#FF0000"}`，或裸字符串 `"#FF0000"` |
| HSL | `{"h":120,"s":100,"l":50}`、`{"hsl":"120,100,50"}` |
| HSB / HSV | `{"h":120,"s":50,"b":80}`、`{"hsb":"120,50,80"}`、`{"h":120,"s":50,"v":80}`、`{"hsv":"120,50,80"}` |
| 色相 / 饱和度 | `{"h":120,"s":50}`、`{"hue":120,"saturation":50}`，或只给其中一个（`{"h":120}`、`{"s":50}`） |

hue 是 0–360，saturation / lightness / value 是 0–100，x/y 是 0–1，RGB 分量是 0–255。数字字符串也接受
（Home Assistant 的模板会产出这种）。只给 hue 的载荷可以附带 `"direction"`，会传给 Matter 的 hue move 命令。

最终发到设备的是哪种色彩空间，规则跟随 zigbee2mqtt：**HSV 系载荷在 endpoint 支持该特性时走色相/饱和度，
其余一律走 xy**（RGB、hex、xy，以及在不支持色相/饱和度的 endpoint 上的 HSV）。另有两条 Matter 特有的补充 ——
因为 xy 在 Matter 里是一个 feature bit，不像 Zigbee 那样默认可用：

- 不支持 xy 的 endpoint 会收到换算后的色相/饱和度命令，而不是被直接跳过；
- 两个特性都不支持的 endpoint 会打 warning 并忽略该载荷。

HSV/HSB 形式的第三个分量（`v` / `b`）在 zigbee2mqtt 里被当作**亮度**而不是颜色的一部分：
`{"h":120,"s":50,"v":80}` 会额外发一条 `moveToLevelWithOnOff`，level 为 254 的 80%。这只发生在
色相/饱和度这条路径上，与 zigbee2mqtt 一致。

### 连续调节与步进

相对控制，语义同 zigbee2mqtt：`*_move` 会一直调节直到被停止，`*_step` 只走一个增量。正值向上、负值向下；
`0`、`"stop"`、`"release"` 停止一次 move。同一条消息里可以出现多个，按消息中的出现顺序依次下发。

| 属性 | Matter 命令 | 说明 |
|------|------------|------|
| `brightness_move` | LevelControl `move`，或 `stop` | `brightness_move_onoff` 用 `moveWithOnOff`；两者停止时都用普通的 `stop` |
| `brightness_step` | LevelControl `step` | `brightness_step_onoff` 用 `stepWithOnOff`；遵循 `transition` |
| `color_temp_move`（或 `colortemp_move`） | ColorControl `moveColorTemperature` | 取值形式见下 |
| `color_temp_step` | ColorControl `stepColorTemperature` | 遵循 `transition` |
| `hue_move` / `saturation_move` | ColorControl `moveHue` / `moveSaturation` | 停止时发 mode Stop + rate 1，与 zigbee2mqtt 一致 |
| `hue_step` / `saturation_step` | ColorControl `stepHue` / `stepSaturation` | 遵循 `transition` |

`color_temp_move` 有三种取值形式，各自的差异保持与 zigbee2mqtt 相同：

- 带符号的速率（`{"color_temp_move":30}`），使用完整的 0–600 mireds 边界；
- 词形 `"up"` / `"down"`（`"1"` 等同 up），默认速率 55、并使用更窄的 153–370 mireds 边界；同级的 `"rate"`
  属性可以覆盖速率；
- 对象 `{"rate":20,"minimum":200,"maximum":454}`；边界默认 0–600，`minimum` 不小于 `maximum` 时该命令被拒绝。

Matter 的两条色温命令都要求带 mireds 边界，所以 `color_temp_step` 总是发 0–600。

endpoint 不具备对应特性时，这些属性会被打 warning 后丢弃（`brightness_*` 需要 LevelControl，`color_temp_*`
需要 ColorTemperature 特性，`hue_*`/`saturation_*` 需要 HueSaturation 特性）。速率与步长用的是 Matter 原始单位
（level 0–254、hue 0–254、saturation 0–254、mireds），与 zigbee2mqtt 发给 Zigbee 的一致。

### 到 Matter 命令的映射

| 消息 | Matter 命令 |
|------|------------|
| 只有 `state` | OnOff `on` / `off` / `toggle` |
| `state: "OFF"` 且 `transition` > 0（可调光 endpoint） | LevelControl `moveToLevelWithOnOff`，level 0 |
| 带 `brightness`（有或没有 `state`） | LevelControl `moveToLevelWithOnOff` |
| 带 `brightness` 且 `state: null` | LevelControl `moveToLevel`（只调 level，不改开关） |
| `color_temp` | ColorControl `moveToColorTemperature` |
| `color` 归一到 xy（RGB、hex、xy，或不支持 HS 时的 HSV） | ColorControl `moveToColor` |
| `color` 同时给 hue 与 saturation | ColorControl `enhancedMoveToHueAndSaturation`；无 EnhancedHue 特性时用 `moveToHueAndSaturation` |
| `color` 只给 hue | ColorControl `enhancedMoveToHue` / `moveToHue`（direction 取载荷中的值，缺省 0） |
| `color` 只给 saturation | ColorControl `moveToSaturation` |
| `color` 带 HSV 的 value 分量 | 在颜色命令之外，额外一条 LevelControl `moveToLevelWithOnOff` |

LevelControl 与 ColorControl 命令均带 `optionsMask: 0, optionsOverride: 0` 下发。

桥遵循的 zigbee2mqtt 联动规则：

- 只给 `brightness` 不给 `state` 时自动推断开关：0 关灯，其他值开灯。
- `state: "ON"` 配 `brightness: 0` 会抬到 level 1（不会关灯）。
- `state: "TOGGLE"` 与 `brightness` 组合时，用缓存的 OnOff 值解析目标状态；缓存值未知则该命令被 warning 拒绝。
- 命令顺序：消息是**关灯**时先发 state 命令（部分灯泡在关闭状态下拒绝颜色变更）；否则先发颜色/色温，再发 state
  命令，这样灯是带着新颜色亮起来的。

同一条消息产生的多个命令按序 invoke。某个命令失败只打日志，不影响后续命令。

### `<prefix>/<node>/get`

向设备读取状态属性，然后把结果发布到 `<prefix>/<node>`，语义与 zigbee2mqtt 的 `get` 一致。只请求该节点已知拥有
的属性路径。读到的值用于本次发布，但不会写回订阅缓存；节点不可达或读取失败时，回落为发布缓存中的状态。

载荷被忽略；两级形式里的 `<endpoint>` 段也被忽略 —— `get` 总是重发整个设备状态。

### 错误处理

设备命令是 fire-and-forget，没有按设备的响应 topic。未知设备、不支持的载荷、没有 OnOff 的 endpoint、被拒绝的取值
以及 invoke 失败，都只通过 server 日志上报。确认命令效果请看 `<prefix>/<node>`（属性变化落地后会重发）。

## 桥命令

桥命令是 zigbee2mqtt 风格的请求/响应对：

- 请求：`<prefix>/bridge/request/<command>`，JSON 对象载荷。
- 响应：`<prefix>/bridge/response/<command>`（非 retained），内容为
  `{"status":"ok","data":{…}}` 或 `{"status":"error","error":"<message>"}`。
- 请求里的 `transaction` 字段会原样回传到响应里，便于请求/响应配对。
- 未知命令返回 `{"status":"error","error":"unknown command \"…\""}`。
- 桥命令不会向外抛异常：失败一律以 `status: "error"` 响应返回。

下面 5 个单值命令接受裸（非 JSON）载荷，并映射到对应的键 —— Home Assistant 的 text / select 实体发的就是裸载荷：

| 命令 | 裸载荷对应的键 |
|------|--------------|
| `commission` | `code` |
| `commission_mode` | `mode` |
| `wifi_ssid` | `ssid` |
| `wifi_password` | `password` |
| `thread_dataset` | `dataset` |

看起来像数字的裸载荷会保持原始数字串不变（配网码、hex dataset 不会被转成数字）。其余命令收到非 JSON 对象的载荷
一律拒绝。

### 命令一览

| 命令 | 请求 | 响应 `data` |
|------|------|------------|
| `commission` | `{"code": "<二维码或手动配对码>", "network": "wifi"\|"thread", "network_only": true}` | `{"node_id": 5}` |
| `commission_mode` | `{"mode": "Auto"\|"WiFi"\|"Thread"\|"Existing (IP)"}` | `{"mode": "…"}` |
| `wifi_credentials` | `{"ssid": "…", "credentials": "…"}` | `{"ssid": "…"}` |
| `wifi_ssid` | `{"ssid": "…"}` | `{"ssid": "…"}` 或 `{"pending": "password"}` |
| `wifi_password` | `{"password": "…"}` | `{"ssid": "…"}` 或 `{"pending": "ssid"}` |
| `thread_dataset` | `{"dataset": "<hex TLV>"}` | `{}` |
| `restart` | `{}` | `{}` |
| `device/remove` | `{"id": <node id>}` | `{"id": <node id>}` |
| `device/interview` | `{"id": <node id>}` | `{"id": <node id>}` |
| `device/rename` | `{"id": <node id>, "name": "…"}` | `{"id": <node id>, "name": "…"}` |
| `device/share` | `{"id": <node id>}` | `{"id": <node id>, "manual_code": "…", "qr_code": "MT:…"}` |
| `device/ota_update/check` | `{"id": <node id>}` | `{"id": …, "update_available": true, "latest_version": 16777236, "latest_version_string": "1.0.4", "latest_source": "main-net-dcl", "latest_release_notes": "…"}` |
| `device/ota_update/update` | `{"id": <node id>, "software_version": 16777236}` | `{"id": …, "software_version": 16777236, "software_version_string": "1.0.4"}` |

**commission** 与 WebSocket 的 `commission_with_code` 编排一致：

- 以 `MT:` 开头的码按二维码处理，其余按手动配对码处理。
- BLE 配网时会带上已存的 `default` WiFi 凭据与 Thread dataset（仅在实际存在时）。网络类型通过
  NetworkCommissioning cluster 自动协商。
- `network: "wifi"` 或 `"thread"` 把配网限制为该类凭据；对应凭据尚未存储时提前失败并给出明确错误。
- `network_only: true` 只走 IP 配网（"添加已在网设备"），不下发凭据。
- 既没给 `network` 也没给 `network_only` 时（裸配网码的场景），由当前选择的 `commission_mode` 决定：`Auto` 提供
  所有已存凭据，`WiFi`/`Thread` 强制单一类型，`Existing (IP)` 等价于 `network_only`。
- node id 由 server 分配。若分配到的 id 与 fabric 上已有身份冲突，则换下一个 id 重试，最多 5 次。
- 进度同步到 `bridge/commission_status`，最终结果在 `bridge/response/commission`。

```
Topic:   matter2mqtt/bridge/request/commission
Payload: {"code":"MT:Y.K9042C00KA0648G00","network":"thread","transaction":"abc"}

Topic:   matter2mqtt/bridge/response/commission
Payload: {"status":"ok","data":{"node_id":7},"transaction":"abc"}
```

**wifi_ssid / wifi_password** 是为 Home Assistant 两个单值 text 实体准备的。两半在内存中合并，只有都拿到时才落盘；
重新提交未变更的 SSID 时会复用已存的（只写）密码。在此之前响应会告知还缺哪一半（`pending`）。`wifi_credentials`
可以一次性设置两者。每个凭据类命令执行后都会重发脱敏的凭据状态 topic —— 出错时也会，这样 UI 会回落到已存的真实
状态。

**thread_dataset** 存储 hex 编码的 operational dataset，并注册到 controller 的凭据库，这同时为该 Thread 网络启用
MeshCoP 诊断（见 [Thread Network Diagnostics](websockets_api.md#thread-network-diagnostics)）。

所有凭据类命令写的都是保留的 `default` 凭据条目 —— 也就是 WebSocket API 不传 `id` 时使用的那一条。带名字的凭据
列表目前只有 WebSocket API 支持。

**device/rename** 写 BasicInformation 的 `nodeLabel`（`0/40/5`）。**device/share** 打开配网窗口并返回配对码，用于
多管理员共享。

**device/ota_update/check** 向 DCL 与本地镜像库查询是否有更新的固件，并把结果记下来供该节点的 `update` 属性
使用。**device/ota_update/update** 启动更新；`software_version` 可省略，省略时取上次检查的目标版本（或当场跑一次
检查的结果）—— Home Assistant 的安装按钮只能发节点 id，不这样做按钮就是死的。

两个命令对同一节点同时只允许一个操作：该节点正在检查或安装时进来的请求会被直接拒绝。安装请求成功只代表更新
**已排队**，设备的下载与应用是异步的，进度体现在 `update` 属性上。需要知道的失败情形：

- 节点报非 Idle 的 UpdateState、离线、或没有已知更新时，控制器会拒绝安装；
- 检查回 `update_available: false` 既可能是真的没有更新，也可能是 DCL 查询失败 —— 控制器不区分这两种情况；
- 检查结果被控制器无过期地缓存，所以一次检查可能是从该缓存回答的，而不是新的 DCL 查询。

> **尚未在真实硬件上验证。** OTA 这套接的是 WebSocket API 走 `check_node_update` / `update_node` 时用的同一批
> 控制器调用，也有单测覆盖，但还没有真正通过 MQTT 给设备推过一次固件。在依赖它之前，请先评估这套 topic/载荷
> 形状是不是合理的 API，并在真实节点上跑一次端到端更新。

**restart** 在回响应约 500 ms 后退出进程（退出码 1），由带重启策略的守护方式（systemd `Restart=`、Docker
`restart:`）把 server 拉起来。没有这类守护时，server 不会自行恢复。

## Home Assistant Discovery

桥在固定的 `homeassistant/` 前缀下（不可配置）发布 retained 的
[MQTT discovery](https://www.home-assistant.io/integrations/mqtt/#mqtt-discovery) 配置：

```
homeassistant/<component>/matter2mqtt_bridge/<object_id>/config
homeassistant/<component>/matter2mqtt_<node>/<object_id>/config
```

discovery 在每次连接以及节点结构变化时重发；消失的实体 topic 会被清空，节点被解绑时它的所有 discovery topic 都会
被清空。

### 清理桥不再发布的内容

retained topic 的寿命超过发布它的进程，所以桥一旦停止发布某个 topic，它就会一直留在 broker 上：新版本里删掉或
改名的实体会继续出现在 Home Assistant 里，而桥停机期间被解绑的节点会留下它的状态和实体。

每次连接发完全量之后，桥会订阅 `homeassistant/+/+/+/config`、`<prefix>/+` 与 `<prefix>/+/availability` ——
broker 随即回放的 retained topic 会与刚刚发布的内容比对，多出来的被清空。该订阅保持不断开，因此每次重连都会
重新对账一次。

只有能被证明属于本桥的 topic 才会被动：

- discovery config 的载荷必须引用本桥的 topic 前缀，因此另一个用不同前缀的桥、或别的集成的实体，都不会被误认；
- 在本桥前缀之下，只有未配网节点的 `<prefix>/<node>` 与 `<prefix>/<node>/availability` 才算；`bridge/…` 与命令
  topic 一概不动；
- 空载荷是"清空"而不是内容，忽略。

凡是无法辨认的一律保留原状：残留实体只是观感问题，而误删别的集成的 discovery config 会直接把它弄坏。

### 桥自身的实体

设备名 `Matter2MQTT Bridge`（标识 `matter2mqtt_bridge`），按发布顺序：

| 实体 | 组件 | 对应 topic |
|------|------|-----------|
| Connection state | `binary_sensor`（connectivity，diagnostic） | `bridge/state` |
| Version | `sensor`（diagnostic） | `bridge/info` |
| Commission status | `sensor` | `bridge/commission_status` |
| Commissioned nodes | `sensor`（设备列表长度） | `bridge/devices` |
| WiFi SSID | `text`（config，max 32） | `bridge/request/wifi_ssid` → `bridge/wifi_ssid` |
| WiFi password | `text`（config，password 模式，max 64） | `bridge/request/wifi_password` → `bridge/wifi_password` |
| Thread dataset | `text`（config，password 模式，max 255） | `bridge/request/thread_dataset` → `bridge/thread_dataset` |
| Commission mode | `select`（config） | `bridge/request/commission_mode` → `bridge/commission_mode` |
| Commission code | `text`（config） | `bridge/request/commission` → `bridge/commission_code` |
| Restart | `button`（restart） | `bridge/request/restart` |

实体的创建顺序决定了 Home Assistant 自动生成的设备卡片布局：传感器在前，配置项居中，重启按钮在最后。

### 设备实体

按节点生成，依据 endpoint 能力推导。设备标识 `matter2mqtt_<node>`，unique id 为
`matter2mqtt_<node>_<entity>[_<endpoint>]`；BasicInformation 没有 product name 时，设备名回落为
`Matter node <node>`。

| 条件 | 实体 |
|------|------|
| OnOff + LevelControl | `light`，JSON schema，`brightness_scale: 254`，`supported_color_modes` 由 ColorControl feature map 推导（`hs`、`xy`、`color_temp`），`min_mireds`/`max_mireds` 取设备上报值 |
| 仅 OnOff | `switch`（载荷 `{"state":"ON"}` / `{"state":"OFF"}`） |
| OccupancySensing | `binary_sensor`，device class `motion` |
| BooleanState | `binary_sensor`，device class `door`，取反（`contact: false` = 打开 = `on`） |
| IlluminanceMeasurement | `sensor`，`lx`，measurement |
| TemperatureMeasurement | `sensor`，`°C`，measurement |
| RelativeHumidityMeasurement | `sensor`，`%`，measurement |
| PowerSource `47/12` | `sensor`，`%`，battery，diagnostic（设备级） |
| OtaSoftwareUpdateRequestor `42/2` | `update`，device class `firmware`，config 分类（设备级）。安装走 `payload_install: {"id":"<node>"}`；版本经 `tojson` 输出，未知版本是 JSON `null` 而不是 Jinja 的 `None` |

所有设备实体都用 `availability_mode: all` 组合两个 topic —— `<prefix>/bridge/state` 与
`<prefix>/<node>/availability` —— 所以桥掉线和节点离线都会让实体变为不可用。实体的 `value_template` 用的是解析
后的属性名，因此自动跟随 `_<endpoint>` 后缀规则；命令 topic 指向 `<prefix>/<node>/set` 或
`<prefix>/<node>/<endpoint>/set`。

**已知限制：** Home Assistant 的 JSON light schema 只读固定属性名（`state`、`brightness` 等）。多个灯 endpoint 的
设备发布的是带后缀的键（`state_1`），这类实体能下命令但不会回显状态。单灯设备（常见情形）功能完整。

## Cluster 覆盖范围

已映射：OnOff（6）、LevelControl（8）、ColorControl（768）、IlluminanceMeasurement（1024）、
TemperatureMeasurement（1026）、RelativeHumidityMeasurement（1029）、OccupancySensing（1030）、
BooleanState（69）、PowerSource（47，电量百分比）、OtaSoftwareUpdateRequestor（42，固件更新）、
BasicInformation（40，设备元信息与固件版本）。

其余能力 —— 包括 WindowCovering、DoorLock、Thermostat、场景/分组与诊断 —— 目前只能通过
[WebSocket API](websockets_api.md) 访问。

## 与 WebSocket API 的关系

| 关注点 | MQTT | WebSocket |
|-------|------|-----------|
| 设备状态 | 按节点的 retained JSON，zigbee2mqtt 属性名 | `attribute_updated` 事件，原始 `endpoint/cluster/attribute` 路径 |
| 设备控制 | `<node>/set`，高层属性 | `device_command`、`write_attribute`（原始 cluster 命令） |
| 配网 | `bridge/request/commission`（`default` 凭据） | `commission_with_code`、`commission_on_network`，支持命名凭据列表 |
| 节点管理 | `bridge/request/device/{remove,interview,rename,share}` | `remove_node`、`interview_node`、`write_attribute`、`open_commissioning_window` |
| 固件更新 | `bridge/request/device/ota_update/{check,update}` + `update` 状态属性 | `check_node_update`、`update_node`、`initiate_ota_upload`（本地镜像上传） |
| 诊断、ACL、binding、ICD、拓扑 | 未暴露 | 完整命令集 |
| Schema / 版本协商 | 无 —— topic 布局随发布版本演进 | `schema_version` 协商 |

两套 API 作用于同一个 controller、同一个 fabric。通过 MQTT 做的变更会出现在 WebSocket 事件流里，反之亦然。
