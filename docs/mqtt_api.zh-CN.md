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
| `<prefix>/<node>/action` | 发布 | 否 | 按键 action，纯字符串，见[按键 action](#按键-action) |
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
    "onoff_endpoints": [1],
    "friendly_name": "5",
    "supported": true,
    "manufacturer": "ThirdReality",
    "model_id": "Smart Bulb",
    "software_build_id": "1.0.4",
    "power_source": "Mains (single phase)",
    "definition": {
      "model": "Smart Bulb",
      "vendor": "ThirdReality",
      "description": "Smart Bulb",
      "exposes": [
        {
          "type": "light",
          "features": [
            { "type": "binary", "name": "state", "label": "State", "property": "state", "access": 7,
              "value_on": "ON", "value_off": "OFF", "value_toggle": "TOGGLE" },
            { "type": "numeric", "name": "brightness", "label": "Brightness", "property": "brightness",
              "access": 7, "value_min": 0, "value_max": 254 }
          ]
        }
      ],
      "options": [],
      "supports_ota": true
    }
  }
]
```

`id` 就是 topic 里的 `<node>` 段。`vendor_name`、`product_name`、`node_label`、`serial_number`、`unique_id`
来自 BasicInformation（`0/40/1`、`0/40/3`、`0/40/5`、`0/40/15`、`0/40/18`），属性缺失或为空白时该字段被省略。
node id 以不带引号的 JSON 数字序列化，可能超过 `Number.MAX_SAFE_INTEGER`，参见
[BigInt Handling](websockets_api.md#bigint-handling)。

其余字段沿用 zigbee2mqtt 的 `bridge/devices` 格式，为 z2m 写的工具可以直接读取：

| 字段 | 取值 |
|------|------|
| `friendly_name` | topic 里的 `<node>` 段（即 node id） |
| `supported` | 恒为 `true`：所有 Matter 设备都按设备类型和 cluster 通用处理 |
| `manufacturer`、`model_id` | BasicInformation 的 VendorName / ProductName |
| `software_build_id` | BasicInformation 的 SoftwareVersionString（`0/40/10`） |
| `power_source` | 取主电源（Order 最小的 PowerSource）：有线为 `Mains (single phase)` 或 `DC Source`，电池为 `Battery`；节点没有上报时省略 |
| `definition.model`、`vendor`、`description` | ProductName、VendorName、ProductName |
| `definition.exposes` | 设备提供的能力，见下文 |
| `definition.options` | 目前恒为空 |
| `definition.supports_ota` | 节点带有 OTA Software Update Requestor cluster |

`exposes` 采用 zigbee2mqtt 的格式。每个 OnOff endpoint 贡献一个 `light`（带 LevelControl 时）或 `switch`，其
`features` 依 endpoint 实际支持的能力包含 `state`（binary，`ON`/`OFF`/`TOGGLE`）、`brightness`（0–254）、
`color_temp`（设备物理范围内的 mireds，附带该范围允许的 `coolest`…`warmest` 预设）、`color_xy` 与 `color_hs`
（作用在 `color` 属性上的 composite）。[属性](#属性)中的每个传感器属性随后作为 `numeric`（带 `unit`）、`binary`
（带 `value_on`/`value_off`；`contact` 取反）或 `enum`（带 `values`）列出，设备级属性放在最后。`access` 是位掩码：
1 = 出现在状态中，2 = 可经 `/set` 设置，4 = 可经 `/get` 读取；灯和开关为 7，传感器为 5。多个 endpoint 都提供的
属性，`property` 里带 `_<endpoint>` 后缀，expose 的 `endpoint` 字段写明对应的 endpoint。

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
| `contact` | ContactSensor（`0x0015`）上的 BooleanState `69/0` | `true` = 闭合，`false` = 打开（zigbee2mqtt 语义） |
| `water_leak` | WaterLeakDetector（`0x0043`）上的 BooleanState `69/0` | `true` = 检测到漏水 |
| `rain` | RainSensor（`0x0044`）上的 BooleanState `69/0` | `true` = 检测到下雨 |
| `water_freeze` | WaterFreezeDetector（`0x0041`）上的 BooleanState `69/0` | `true` = 检测到冰冻 |
| `state`（窗帘） | WindowCovering `258/14`，没有则 `258/15` | `OPEN`，完全关闭时为 `CLOSE` |
| `position` | WindowCovering `258/14` | 0（关）– 100（开），`100 - raw/100` |
| `tilt` | WindowCovering `258/15` | 0（关）– 100（开），`100 - raw/100` |
| `moving` | WindowCovering `258/10`（global 位） | `UP`（正在打开）、`DOWN`（正在关闭）、`STOP` |
| `state`（门锁） | DoorLock `257/0` | 已上锁为 `LOCK`，否则 `UNLOCK` |
| `lock_state` | DoorLock `257/0` | `not_fully_locked`、`locked`、`unlocked`、`unlatched` |
| `door_state` | DoorLock `257/3` | `open`、`closed`、`jammed`、`forced_open`、`error`、`ajar` |
| `local_temperature` | Thermostat `513/0` | °C，`raw/100` |
| `outdoor_temperature` | Thermostat `513/1` | °C，`raw/100` |
| `occupied_heating_setpoint`、`occupied_cooling_setpoint` | Thermostat `513/18`、`513/17` | °C，`raw/100`；需要 Heating / Cooling feature |
| `unoccupied_heating_setpoint`、`unoccupied_cooling_setpoint` | Thermostat `513/20`、`513/19` | °C，`raw/100` |
| `system_mode` | Thermostat `513/28` | `off`、`auto`、`cool`、`heat`、`emergency_heating`、`precooling`、`fan_only`、`dry`、`sleep` |
| `running_state` | Thermostat `513/41` | 由各级运行位得出 `heat`、`cool`、`fan_only`，否则 `idle` |
| `local_temperature_calibration` | Thermostat `513/16` | °C，`raw/10` |
| `pi_heating_demand`、`pi_cooling_demand` | Thermostat `513/8`、`513/7` | % |
| `fan_state` | FanControl `514/0` | FanMode 不为 off 时为 `ON` |
| `fan_mode` | FanControl `514/0` | `off`、`low`、`medium`、`high`、`on`、`auto`、`smart` |
| `percentage` | FanControl `514/3`，没有则 `514/2` | 0–100 |
| `fan_speed` | FanControl `514/6`，没有则 `514/5` | 0–SpeedMax（MultiSpeed feature） |
| `oscillation` | FanControl `514/8` | 任一摆动方式开启时为 `true` |
| `airflow_direction` | FanControl `514/11` | `forward`、`reverse` |
| `state`（水阀） | ValveConfigurationAndControl `129/4` | `OPEN`、`CLOSE`；动作过程中不发布 |
| `position`（水阀） | ValveConfigurationAndControl `129/6` | 0–100（Level feature） |
| `remaining_duration` | ValveConfigurationAndControl `129/3` | s |
| `mode` | ModeSelect `80/3` | SupportedModes（`80/2`）中当前模式的 label |
| `pump_operation_mode` | PumpConfigurationAndControl `512/32` | `normal`、`minimum`、`maximum`、`local` |
| `pump_control_mode` | PumpConfigurationAndControl `512/33` | `constant_speed`、`constant_pressure`、`proportional_pressure`、`constant_flow`、`constant_temperature`、`automatic` |
| `smoke_sensitivity` | SmokeCoAlarm `92/11` | `high`、`standard`、`low` |
| `switch_position` | Switch `59/1` | 拨动开关（LatchingSwitch feature）的当前档位 |
| `power_on_behavior` | OnOff `6/16387`（StartUpOnOff） | `off`、`on`、`toggle`，或 `previous`（null） |
| `color_temp_startup` | ColorControl `768/16400` | mireds，previous（null）按 zigbee2mqtt 记为 `65535` |
| `level_config` | LevelControl `8/{16,17,18,19,16384}` + Options `8/15` | 对象，按 endpoint 实际具备的属性包含 `on_off_transition_time`、`on_transition_time`、`off_transition_time`（单位 0.1 秒）、`on_level`、`current_level_startup` 与 `execute_if_off`；null 按 zigbee2mqtt 记为 `65535`（渐变时间）或 `255`（亮度） |
| `color_options` | ColorControl Options `768/15` | `{"execute_if_off": true\|false}` |
| `pressure` | PressureMeasurement `1027/0` | hPa（原始单位 0.1 kPa 恰好等于 hPa） |
| `flow` | FlowMeasurement `1028/0` | m³/h，`raw/10` |
| `soil_moisture` | SoilMeasurement `1072/1` | % |
| `air_quality` | AirQuality `91/0` | `unknown`、`good`、`fair`、`moderate`、`poor`、`very_poor`、`extremely_poor` |
| `co2`、`co`、`pm1`、`pm25`、`pm10`、`voc`、`formaldehyd`、`no2`、`o3`、`radon` | `<浓度 cluster>/0`，单位取自 `/8` | 见[浓度](#浓度) |
| `<浓度属性>_level` | `<浓度 cluster>/10` | `unknown`、`low`、`medium`、`high`、`critical` |
| `smoke` | SmokeCoAlarm `92/1` | SmokeState 非 normal 时为 `true` |
| `smoke_state` | SmokeCoAlarm `92/1` | `normal`、`warning`、`critical` |
| `carbon_monoxide` | SmokeCoAlarm `92/2` | COState 非 normal 时为 `true` |
| `co_state` | SmokeCoAlarm `92/2` | `normal`、`warning`、`critical` |
| `alarm_state` | SmokeCoAlarm `92/0` | ExpressedState：`normal`、`smoke_alarm`、`co_alarm`、`battery_alert`、`testing`、`hardware_fault`、`end_of_service`、`interconnect_smoke`、`interconnect_co`、`inoperative` |
| `interconnect_smoke`、`interconnect_co` | SmokeCoAlarm `92/8`、`92/9` | 联动报警器鸣响时为 `true` |
| `test` | SmokeCoAlarm `92/5` | 自检进行中为 `true` |
| `muted` | SmokeCoAlarm `92/4` | 已静音为 `true` |
| `battery_low` | SmokeCoAlarm `92/3` | BatteryAlert 非 normal 时为 `true` |
| `hardware_fault` | SmokeCoAlarm `92/6` | 硬件故障时为 `true` |
| `end_of_service` | SmokeCoAlarm `92/7` | 报警器到期后为 `true` |
| `contamination` | SmokeCoAlarm `92/10` | `normal`、`low`、`warning`、`critical` |
| `power` | ElectricalPowerMeasurement `144/8` | W，`raw/1000`（ActivePower 单位 mW） |
| `voltage` | ElectricalPowerMeasurement `144/4`，没有则 `144/11`（RMS） | V，`raw/1000` |
| `current` | ElectricalPowerMeasurement `144/5`，没有则 `144/12`（RMS） | A，`raw/1000` |
| `ac_frequency` | ElectricalPowerMeasurement `144/14` | Hz，`raw/1000` |
| `energy` | ElectricalEnergyMeasurement `145/1` | kWh，累计输入电能（`raw/10^6`，结构体的 `energy` 单位 mWh） |
| `produced_energy` | ElectricalEnergyMeasurement `145/2` | kWh，累计输出电能 |
| `battery` | PowerSource `47/12` | %，`raw/2`（BatPercentRemaining 以 0.5% 为单位）。设备级 |
| `battery_low` | PowerSource `47/14` | BatChargeLevel 非 OK 时为 `true`。设备级 |
| `voltage` | PowerSource `47/11` | mV，电池电压（zigbee2mqtt 的单位）。设备级 |
| `update` | OtaSoftwareUpdateRequestor `42/{2,3}` + BasicInformation `40/{9,10}` | 固件更新状态对象，设备级 —— 见[固件更新](#固件更新) |

BooleanState 本身不带语义：发布成哪个属性，由该 endpoint 的 Descriptor DeviceTypeList（`29/0`）里的设备类型决定。
有 BooleanState 但不属于上述任何设备类型的 endpoint，回落为 `contact`。

设备级属性按 endpoint 顺序，取第一个带有该属性的 PowerSource endpoint。若某个 endpoint 已经提供同名属性（烟雾报警器
自己的 `battery_low`、电量计的市电 `voltage`），以 endpoint 的值为准，不再发布设备级的那个。

#### 浓度

浓度测量类 cluster（CO2 `1037`、CO `1036`、PM1 `1068`、PM2.5 `1066`、PM10 `1069`、TVOC `1070`、甲醛 `1067`、
NO2 `1043`、臭氧 `1045`、氡 `1071`）按设备在 MeasurementUnit（`/8`）里声明的单位上报数值。数值**只在同一量纲内**
换算成 zigbee2mqtt 的单位 —— ppm/ppb/ppt 之间、mg/µg/ng 每立方米之间 —— 因为 parts 与质量浓度互换需要气体的摩尔
质量。量纲不同的值按设备的单位原样发布，且不带 Home Assistant device class（HA 会拒绝与 device class 不匹配的单位）。

| 属性 | 发布单位（HA device class） | 设备未声明单位时假定 |
|------|------------------------------|----------------------|
| `co2` | ppm（`carbon_dioxide`） | ppm |
| `co` | ppm（`carbon_monoxide`） | ppm |
| `pm1`、`pm25`、`pm10` | µg/m³（`pm1`、`pm25`、`pm10`） | µg/m³ |
| `voc` | µg/m³（`volatile_organic_compounds`）或 ppb（`volatile_organic_compounds_parts`） | µg/m³ |
| `formaldehyd` | mg/m³ 或 ppm（无 HA class）；沿用 zigbee2mqtt 的拼写 | mg/m³ |
| `no2` | µg/m³（`nitrogen_dioxide`）或 ppb | µg/m³ |
| `o3` | µg/m³（`ozone`）或 ppb | µg/m³ |
| `radon` | Bq/m³（无 HA class） | Bq/m³ |

只有 level 功能的传感器只发布 `<浓度属性>_level`。

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

### 按键 action

按键操作以 Matter Switch（`59`）事件到达，按 zigbee2mqtt 风格发布为 `action`，走单独的 topic
`<prefix>/<node>/action`，载荷是纯字符串。它**不是 retained**，也不进入 retained 状态，所以 broker 重连不会回放按键。

| Switch 事件 | `action` |
|-------------|----------|
| MultiPressComplete（MultiPress feature） | `single`、`double`、`triple`、`quadruple`，超过四次为 `many` |
| ShortRelease（Release feature，无 MultiPress） | `single` |
| InitialPress（既无 Release 也无 MultiPress，例如门铃） | `single` |
| LongPress / LongRelease | `hold` / `release` |
| SwitchLatched（LatchingSwitch feature） | `position_<新档位>` |

每次按键只上报一次：有 MultiPress feature 时只看完成的整个序列，双击是 `double` 而不是两次 `single`。设备有多个
Switch endpoint 时，action 带上 endpoint，类似 zigbee2mqtt 的 `single_left`：`single_1`、`hold_2`。拨动开关的静止
档位另外以 `switch_position` 保留在状态中。

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
3. 节点的第一个可控 endpoint。

带 OnOff cluster 或设备控制（窗帘、门锁、温控、风扇、水阀、模式选择、水泵或烟雾报警器设置、灯的选项、identify）的 endpoint 是可控的。后缀数字不属于可控 endpoint 时，会被当成属性名的
一部分（与 zigbee2mqtt 一致）。发给其他 endpoint 的命令打日志后丢弃。

在目标 endpoint 上，各设备控制先认领自己的属性（窗帘认领 `state`、`position`、`tilt`），剩下的交给下文的灯处理，
谁都不认领的属性记为不支持。所以同一个属性名在不同 endpoint 上含义不同：`state` 在灯上是 `ON`/`OFF`，在窗帘上是
`OPEN`/`CLOSE`/`STOP`。

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

### 窗帘

| 消息 | Matter 命令（WindowCovering `258`） |
|------|--------------------------------------|
| `state: "OPEN"` / `"CLOSE"` / `"STOP"`（大小写不限） | `upOrOpen` / `downOrClose` / `stopMotion` |
| `position` 0–100 | `goToLiftPercentage`，`liftPercent100thsValue = (100 - position) * 100`；需要 PositionAwareLift feature |
| `tilt` 0–100 | `goToTiltPercentage`，`tiltPercent100thsValue = (100 - tilt) * 100`；需要 PositionAwareTilt feature |

zigbee2mqtt 的 `position`、`tilt` 从关（0）数到开（100）；Matter 从开（0）数到关（10000）。裸载荷 `OPEN`、`CLOSE`、
`STOP` 等同于 `{"state": …}`。

### 门锁

| 消息 | Matter 命令（DoorLock `257`） |
|------|--------------------------------|
| `state: "LOCK"` / `"UNLOCK"`（大小写不限） | `lockDoor` / `unlockDoor` |
| …带 `pin_code` | 同一命令带 `pinCode`（数字按字节串发送） |

门锁设置了 RequirePINforRemoteOperation 时，不带码的命令会被门锁拒绝；bridge 仍然发送并打 warning，由门锁自己的
应答决定结果。注意 zigbee2mqtt 的 `pin_code` 用于用户管理，这里是本次上锁/开锁使用的码。

### 温控

| 消息 | Matter 写属性（Thermostat `513`） |
|------|-----------------------------------|
| `occupied_heating_setpoint`、`occupied_cooling_setpoint`、`unoccupied_*`（°C） | 属性 `18`、`17`、`20`、`19` = `round(°C * 100)`；温控没有该设定点时拒绝 |
| `system_mode` | 属性 `28`（SystemMode）；取值见[属性](#属性) |
| `local_temperature_calibration`（°C，-2.5–2.5） | 属性 `16` = `round(°C * 10)` |

数值可以是数字或数字字符串。

### 风扇

| 消息 | Matter 写属性（FanControl `514`） |
|------|-----------------------------------|
| `fan_state: "ON"` / `"OFF"` | FanMode `0` = On（由风扇决定转速）/ Off |
| `fan_mode` | 按名称写 FanMode `0` |
| `percentage` 0–100 | PercentSetting `2` |
| `fan_speed` | SpeedSetting `5`，0–SpeedMax |
| `oscillation: true` / `false` | RockSetting `8` = RockSupport 中的全部摆动方式 / 0 |
| `airflow_direction: "forward"` / `"reverse"` | AirflowDirection `11` |

### 水阀

| 消息 | Matter 命令（ValveConfigurationAndControl `129`） |
|------|----------------------------------------------------|
| `state: "OPEN"`，可带 `position`（1–100）与 `duration`（秒） | `open`，带 `targetLevel` 与 `openDuration` |
| `state: "CLOSE"`，或 `position: 0` | `close` |

### 模式与设置

| 消息 | Matter |
|------|--------|
| `mode`（label 或模式编号） | ModeSelect `changeToMode`；不在 SupportedModes 中的模式会被拒绝 |
| `pump_operation_mode`、`pump_control_mode` | 写 PumpConfigurationAndControl `512/32`、`512/33` |
| `smoke_sensitivity` | 写 SmokeCoAlarm `92/11` |
| `self_test`（任意值） | SmokeCoAlarm `selfTestRequest` |

### 灯的选项

| 消息 | Matter |
|------|--------|
| `on_time`（秒），可带 `off_wait_time`（秒），配 `state: "ON"` 或不带 state | OnOff `onWithTimedOff`，两个时间单位 0.1 秒；取代普通的 `on`，排在亮度变更之后；需要 OnOff 的 Lighting feature |
| `effect`：`blink`、`breathe`、`okay`、`channel_change`、`finish_effect`、`stop_effect` | Identify `triggerEffect`（variant 0），排在同一消息的灯命令之后 |
| `identify`（秒数，其他任意值为 3 秒） | Identify `identify` |
| `power_on_behavior` | 写 OnOff `6/16387`；`previous` 写 null |
| `color_temp_startup`（mireds、`coolest`…`warmest` 预设、`previous` 或 `65535`） | 在物理范围内写 ColorControl `768/16400`；previous 写 null |
| `level_config: {…}`，包含上述任意字段（亮度类字段接受 `previous` 与 `minimum`） | 写对应的 LevelControl 属性；`execute_if_off` 设置 LevelControl Options 的 bit 0，其余位保持不变 |
| `color_options: {"execute_if_off": …}` | ColorControl Options 的 bit 0，其余位保持不变 |


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
- server 能判断失败原因时，错误响应还会带一个机器可读的 `reason`。`commission` 的取值与 WebSocket API 的配网错误
  一致：`not-discovered`、`passcode-mismatch`、`invalid-payload`、`attestation-rejected`、`timeout` 或 `other`；
  `parse_onboarding_payload` 遇到无法解码的码时返回 `invalid-payload`。
- 请求里的 `transaction` 字段会原样回传到响应里，便于请求/响应配对。
- 未知命令返回 `{"status":"error","error":"unknown command \"…\""}`。
- 桥命令不会向外抛异常：失败一律以 `status: "error"` 响应返回。

下面 6 个单值命令接受裸（非 JSON）载荷，并映射到对应的键 —— Home Assistant 的 text / select 实体发的就是裸载荷：

| 命令 | 裸载荷对应的键 |
|------|--------------|
| `commission` | `code` |
| `parse_onboarding_payload` | `code` |
| `commission_mode` | `mode` |
| `wifi_ssid` | `ssid` |
| `wifi_password` | `password` |
| `thread_dataset` | `dataset` |

看起来像数字的裸载荷会保持原始数字串不变（配网码、hex dataset 不会被转成数字）。其余命令收到非 JSON 对象的载荷
一律拒绝。

### 命令一览

| 命令 | 请求 | 响应 `data` |
|------|------|------------|
| `commission` | `{"code": "<二维码或手动配对码>", "network": "wifi"\|"thread", "network_only": true, "discovery_timeout_s": 120}` | `{"node_id": 5}` |
| `parse_onboarding_payload` | `{"code": "<二维码或手动配对码>"}` | 见下文 |
| `commission_mode` | `{"mode": "Auto"\|"WiFi"\|"Thread"\|"Existing (IP)"}` | `{"mode": "…"}` |
| `wifi_credentials` | `{"ssid": "…", "credentials": "…"}` | `{"ssid": "…"}` |
| `wifi_ssid` | `{"ssid": "…"}` | `{"ssid": "…"}` 或 `{"pending": "password"}` |
| `wifi_password` | `{"password": "…"}` | `{"ssid": "…"}` 或 `{"pending": "ssid"}` |
| `thread_dataset` | `{"dataset": "<hex TLV>"}` | `{}` |
| `restart` | `{}` | `{}` |
| `device/remove` | `{"id": <node id>}` | `{"id": <node id>}` |
| `device/interview` | `{"id": <node id>}` | `{"id": <node id>}` |
| `device/rename` | `{"id": <node id>, "name": "…"}` | `{"id": <node id>, "name": "…"}` |
| `device/share` | `{"id": <node id>, "timeout": 900}` | `{"id": <node id>, "manual_code": "…", "qr_code": "MT:…", "setup_pin_code": 20202021, "discriminator": 3840, "vendor_id": 4939, "product_id": 1, "commissioning_timeout": 900}` |
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
- `discovery_timeout_s`（可选，单位秒，最大 172800）限制搜索设备的时长，超时后配网失败并返回
  `reason: "not-discovered"`；不传时使用 matter.js 的默认值。
- node id 由 server 分配。若分配到的 id 与 fabric 上已有身份冲突，则换下一个 id 重试，最多 5 次。
- 进度同步到 `bridge/commission_status`，最终结果在 `bridge/response/commission`。

```
Topic:   matter2mqtt/bridge/request/commission
Payload: {"code":"MT:Y.K9042C00KA0648G00","network":"thread","transaction":"abc"}

Topic:   matter2mqtt/bridge/response/commission
Payload: {"status":"ok","data":{"node_id":7},"transaction":"abc"}
```

配网码输错时会带上客户端可据以处理的原因，例如提示用户重新输入：

```
Topic:   matter2mqtt/bridge/response/commission
Payload: {"status":"error","error":"…","reason":"passcode-mismatch","transaction":"abc"}
```

**parse_onboarding_payload** 只解码二维码或手动配对码，不连接任何设备，字段与同名 WebSocket 命令一致。二维码返回
`{"type":"qr","payloads":[{"version":0,"vendor_id":65521,"product_id":32768,"flow_type":0,"discovery_capabilities":2,"discriminator":3840,"setup_pin_code":20202021}]}`
（多设备二维码每台设备一项）；手动配对码返回 `{"type":"manual","short_discriminator":15,"setup_pin_code":20202021}`，
码里带有厂商与产品 id 时另含 `vendor_id`、`product_id`。

**wifi_ssid / wifi_password** 是为 Home Assistant 两个单值 text 实体准备的。两半在内存中合并，只有都拿到时才落盘；
重新提交未变更的 SSID 时会复用已存的（只写）密码。在此之前响应会告知还缺哪一半（`pending`）。`wifi_credentials`
可以一次性设置两者。每个凭据类命令执行后都会重发脱敏的凭据状态 topic —— 出错时也会，这样 UI 会回落到已存的真实
状态。

**thread_dataset** 存储 hex 编码的 operational dataset，并注册到 controller 的凭据库，这同时为该 Thread 网络启用
MeshCoP 诊断（见 [Thread Network Diagnostics](websockets_api.md#thread-network-diagnostics)）。

所有凭据类命令写的都是保留的 `default` 凭据条目 —— 也就是 WebSocket API 不传 `id` 时使用的那一条。带名字的凭据
列表目前只有 WebSocket API 支持。

**device/rename** 写 BasicInformation 的 `nodeLabel`（`0/40/5`）。**device/share** 打开配网窗口并返回配对码，用于
多管理员共享；同时返回 setup PIN、discriminator、厂商与产品 id 以及窗口的 `commissioning_timeout`（秒），方便直接
交给其他生态而无需解码二维码。`timeout`（可选，单位秒）设置窗口打开多久，不传时使用 matter.js 的默认值。

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
| DoorLock | `lock`，载荷 `{"state":"LOCK"\|"UNLOCK"}`；有 DoorPositionSensor feature 时另有 `door_state` 枚举 `sensor` |
| Thermostat | `climate`：`modes` 为 off，加上 FeatureMap 支持的 heat/cool/auto（RoomAirConditioner 另加 fan only 与 dry），Matter 独有的模式显示为最接近的 HA 模式；单一目标温度，两者都支持时为 low（制热）/ high（制冷）两个目标；`min_temp`/`max_temp` 取自绝对设定点限制；当前动作来自 `running_state`。室外温度与 PI 需求各为独立的 `sensor` |
| FanControl | `fan`，载荷 `{"fan_state":…}`；支持时带百分比、`auto` 预设（FanModeSequence 包含时）、摆动与风向 |
| ValveConfigurationAndControl | `valve`，device class `water`，Level feature 时带位置；剩余时长为 `sensor` |
| Identify | 灯实体上的 `effect` 与 `effect_list`；一个 `identify` `button`，config 分类 |
| OnOff StartUpOnOff | `power_on_behavior` `select`，config 分类 |
| ColorControl StartUpColorTemperatureMireds | `color_temp_startup` `number`（物理范围内的 mireds），config 分类 |
| Switch | 每个设备一个 `event` 实体（事件类型为该设备可能上报的全部 action，由 Switch feature 与 MultiPressMax 决定），每种 action 一个 `device_automation` 触发器，都基于 `<prefix>/<node>/action` |
| ModeSelect | `select`，名称取自 cluster 的 Description，选项来自 SupportedModes |
| 水泵模式、烟雾灵敏度 | `select`，config 分类 |
| SmokeCoAlarm | 自检 `button`，diagnostic 分类 |
| WindowCovering | `cover`，载荷 `{"state":"OPEN"\|"CLOSE"\|"STOP"}`；窗帘跟踪位置时带 position 与 tilt 模板；device class 由 EndProductType 映射为 `shade`、`blind`、`curtain`、`shutter` 或 `awning` |
| OccupancySensing | `binary_sensor`，device class `motion` |
| BooleanState（ContactSensor） | `binary_sensor`，device class `door`，取反（`contact: false` = 打开 = `on`） |
| BooleanState（WaterLeakDetector / RainSensor） | `binary_sensor`，device class `moisture`，不取反 |
| BooleanState（WaterFreezeDetector） | `binary_sensor`，device class `cold`，不取反 |
| IlluminanceMeasurement | `sensor`，`lx`，measurement |
| TemperatureMeasurement | `sensor`，`°C`，measurement |
| RelativeHumidityMeasurement | `sensor`，`%`，measurement |
| PressureMeasurement / FlowMeasurement / SoilMeasurement | `sensor`，device class 分别为 `pressure`（hPa）/ `volume_flow_rate`（m³/h）/ `moisture`（%），measurement |
| AirQuality、浓度 level、`smoke_state`、`co_state`、`alarm_state`、`contamination` | `sensor`，device class `enum`，取值列表作为 `options` |
| 浓度数值 | `sensor`，measurement，单位与 device class 见[浓度](#浓度) |
| SmokeCoAlarm `smoke`、`interconnect_smoke` / `carbon_monoxide`、`interconnect_co` | `binary_sensor`，device class `smoke` / `carbon_monoxide` |
| SmokeCoAlarm `test`、`muted`、`battery_low`、`hardware_fault`、`end_of_service` | `binary_sensor`，diagnostic；`battery_low` 为 `battery` 类，两个故障为 `problem` 类 |
| ElectricalPowerMeasurement | `sensor`，device class `power`（W）、`voltage`（V）、`current`（A）、`frequency`（Hz），measurement |
| ElectricalEnergyMeasurement | `sensor`，device class `energy`，kWh，`total_increasing` |
| PowerSource `47/12` | `sensor`，`%`，battery，diagnostic（设备级） |
| PowerSource `47/14` | `binary_sensor`，device class `battery`，diagnostic（设备级） |
| PowerSource `47/11` | `sensor`，device class `voltage`，mV，diagnostic（设备级） |
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
| 配网 | `bridge/request/commission`（`default` 凭据）、`bridge/request/parse_onboarding_payload` | `commission_with_code`、`commission_on_network`，支持命名凭据列表 |
| 节点管理 | `bridge/request/device/{remove,interview,rename,share}` | `remove_node`、`interview_node`、`write_attribute`、`open_commissioning_window` |
| 固件更新 | `bridge/request/device/ota_update/{check,update}` + `update` 状态属性 | `check_node_update`、`update_node`、`initiate_ota_upload`（本地镜像上传） |
| 诊断、ACL、binding、ICD、拓扑 | 未暴露 | 完整命令集 |
| Schema / 版本协商 | 无 —— topic 布局随发布版本演进 | `schema_version` 协商 |

两套 API 作用于同一个 controller、同一个 fabric。通过 MQTT 做的变更会出现在 WebSocket 事件流里，反之亦然。
