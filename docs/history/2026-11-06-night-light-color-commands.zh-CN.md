# 2026-11-06 ThirdReality 夜灯颜色命令测试记录

用户让 node 1 变红，bridge 发出命令、设备回 Success、回报的状态也是红色，但灯光没有变。随后用 Home Assistant 的发法做对照，
逐条测试三盏夜灯对三种颜色命令的实际反应。**本记录同时作为提交给固件团队的材料。**

前一天的记录见 [2026-11-05 真机配网与控制测试记录](2026-11-05-real-device-commissioning.zh-CN.md)。

## 设备

| node | 型号 | 网络 | 固件 | 序列号 |
|---|---|---|---|---|
| 1 | Smart Color Night Light | WiFi | v1.00.51 | 3RM01-4115-00210 |
| 3 | Smart Color Night Light | WiFi | v1.00.51 | 3RM01-4115-00272 |
| 2 | Matter Smart Night Light -T | Thread | v1.00.05 | — |

三盏灯的 ColorControl FeatureMap 和 ColorCapabilities 都是 31：HS、增强色相、颜色循环、XY、色温全部声明支持。
node 1 和 node 3 的 40 项 ColorControl 配置属性完全相同（特性、选项、色温范围等），差别只在当前状态值。

## 结果

"变 / 不变"是用户看到的实际灯光。所有命令设备都回了 `Success (0)`。

| 命令 | 发出方 | node 1（WiFi） | node 3（WiFi） | node 2（Thread） |
|---|---|---|---|---|
| `moveToColor`（XY） | bridge（规范 / z2m 方式） | **不变** ×2 | **不变** ×1 | **不变** ×1 |
| `enhancedMoveToHueAndSaturation` | bridge（规范 / z2m 方式） | 见下文：目标等于过期的 `EnhancedCurrentHue` 时不变，否则变 | 同左 | 变 ×1 |
| `moveToHueAndSaturation` | Home Assistant 方式 | 变 ×2 | 变 ×2 | 变 ×1 |

逐条记录（时间取自 matter2mqtt 日志的 `Invoke »`）：

| 时间 | node | 命令 | 目标颜色 | 实际灯光 |
|---|---|---|---|---|
| 02:04:28 | 1 | `moveToColor` x 45914 / y 19615 | 红 | 不变 |
| 02:05:35 | 1 | `enhancedMoveToHueAndSaturation` 0 / 254 | 红 | 变红 |
| 02:06:15 | 1 | `moveToColor` x 11141 / y 45875 | 绿 | 不变，仍为红 |
| 02:07:44 | 2 | `enhancedMoveToHueAndSaturation` 0 / 254 | 红 | 变红 |
| 02:07:44 | 3 | `enhancedMoveToHueAndSaturation` 0 / 254 | 红 | 不变，为紫色 |
| 02:08:29 | 3 | `enhancedMoveToHueAndSaturation` 0 / 254（灯已亮着时重发） | 红 | 不变，仍为紫色 |
| 02:09:52 | 3 | `moveToHueAndSaturation` 85 / 254 | 绿 | 变绿 |
| 02:17:38 | 1 | `moveToHueAndSaturation` 169 / 254 | 蓝 | 变蓝 |
| 02:18:56 | 3 | `moveToColor` x 9830 / y 3932 | 蓝 | 不变，仍为绿 |
| 02:19:38 | 2 | `moveToColor` x 11141 / y 45875 | 绿 | 不变，仍为红 |
| 02:19:53 | 2 | `moveToHueAndSaturation` 169 / 254 | 蓝 | 变蓝 |

### 增强色相的复测（用户指出两盏 WiFi 灯的反应应当一致）

第一轮的增强色相测试有设计缺陷：目标都是 0（红），而 node 3 的 `EnhancedCurrentHue` 恰好就是 0。复测时两盏 WiFi 灯同步进行，
每步前后读属性（`CurrentHue` / `EnhancedCurrentHue`）：

| 时间 | 步骤 | 命令（两盏都发） | 发前 `EnhancedCurrentHue` | 发后（两盏相同） | 实际灯光（两盏相同） |
|---|---|---|---|---|---|
| 02:24:30 | A | 增强 → 绿 21845 | 0 | 85 / 21845 | node 1 变绿；node 3 本来就是绿，不作数 |
| 02:24:49 | A′ | 增强 → 黄 10923 | 21845 | 42 / 10923 | 都变黄 |
| 02:25:21 | B | 普通 → 红 0（HA 方式） | 10923 | 0 / **10923** | 都变红；增强色相没有同步 |
| 02:25:37 | C | 增强 → 黄 10923 | 10923（过期） | 0 / 10923，**未变** | **都不变**，仍为红；设备回 Success |

结论：增强色相命令本身正常，两盏 WiFi 灯行为一致。固件在执行普通色相或 XY 命令后不更新 `EnhancedCurrentHue`，
之后若增强色相命令的目标恰好等于这个过期值，就跳过不执行，仍回 Success。第一轮 node 3 两次"不变"即属此情况（过期值 0，目标 0）。

## 属性不同步

命令之后读回的 ColorControl 属性（`CurrentHue` 0、`CurrentX/Y` 3/4、`ColorMode` 8、`EnhancedCurrentHue` 16384、`EnhancedColorMode` 16385）。
规范要求这些属性始终描述同一个颜色；实测各改各的：

- `moveToColor` 之后：`CurrentX/Y` 和 `ColorMode`（=1）更新，`CurrentHue` 保持旧值。node 1 发红色后 `CurrentHue` 仍是 170（蓝），
  色温仍是 250。
- `enhancedMoveToHueAndSaturation` 之后（node 3，灯不变的那次）：`EnhancedCurrentHue` = 0，`CurrentHue` 仍是 183（紫），
  灯光也是紫色。
- `moveToHueAndSaturation` 之后：`CurrentHue` 更新，`EnhancedCurrentHue` 不跟随（仍为 0）。node 3 的 `EnhancedColorMode` 保持 3（增强），
  规范要求此时为 0。

控制器只能按属性回报颜色，所以 **bridge 回报的颜色和实际灯光不一致**：设备说是绿色，实际亮红色。

## 结论

1. **XY 命令在这两款夜灯上都不起作用**（4 次全部无效，其中 node 3 那次的坐标此前从未发过、也不同于它当时的属性），
   设备却回 Success 并更新 XY 属性。
2. **增强色相命令本身正常**，但普通色相 / XY 命令之后 `EnhancedCurrentHue` 不同步；增强命令的目标若等于这个过期值，
   固件就跳过不执行，仍回 Success（复测 C 步，两盏 WiFi 灯一致）。
3. **普通色相命令（Home Assistant 用的那种）在三盏灯上都有效。** 这解释了"以前在 Home Assistant 上一直正常"：HA 的 Matter 集成对
   支持 HS 的灯只发 `moveToHueAndSaturation`，读的是 `CurrentHue`，从不发 XY 或增强色相命令，正好绕开了问题。
4. **颜色相关属性互不同步**（`CurrentHue`、`EnhancedCurrentHue`、`CurrentX/Y`、`EnhancedColorMode`），导致控制器读回的颜色错误，
   也导致第 2 条的误判。
5. 这些都是固件问题：命令是规范命令，设备声明支持，也回了 Success。
6. 测试教训：第一轮把"增强色相不可靠、两盏 WiFi 灯表现不同"写成了结论，实际是测试前两盏灯的属性状态不同。
   对比设备时，要先把它们置于相同的已知状态，并且目标值要避开当前和过期的属性值。

## bridge 的处理

**不为这款灯改 bridge。** 设备声明支持的命令，bridge 照常使用（XY、增强色相，与 zigbee2mqtt 一致），等固件修复。
曾经试着按 HA 的方式改发送和读取，经用户确认不是要这样做，已撤回，未提交。

前一天测试 1 里夜灯的 "color xy green""color hex red" 两项，当时只按回报的状态判为通过，实际灯光很可能没变，应改判为**未验证**。
测试灯光颜色要有人看实际灯光，或者用独立的传感器；只看设备回报的属性不够。

## 复现

- 原始日志：hub 上 `/root/m2m-dist/logs/m2m-20261106-color.log`（02:04 起的 matter2mqtt 日志，含全部 `Invoke` 请求与应答）。
- bridge 方式：向 `matter2mqtt/<node>/set` 发 `{"color":{"x":0.17,"y":0.7}}`（XY），或 `{"color":{"hue":0,"saturation":100}}`（增强色相）。
- HA 方式与读属性：`/root/m2m-dist/tests/cmd.mjs`（经 WebSocket `device_command` 发任意命令）、`/root/m2m-dist/tests/getnode.mjs`（读节点属性）。
  例如 `node cmd.mjs 1 1 768 moveToHueAndSaturation '{"hue":169,"saturation":254,"transitionTime":0,"optionsMask":1,"optionsOverride":1}'`。
