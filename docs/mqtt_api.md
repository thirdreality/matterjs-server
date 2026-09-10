# MQTT API Documentation

> A Chinese translation is available: [mqtt_api.zh-CN.md](mqtt_api.zh-CN.md)（中文版）. This English
> document is the source of truth.

This document describes the MQTT API of the **matter2mqtt** bridge shipped with the Matter.js server
(`@matter-server/mqtt-bridge`). The bridge publishes Matter device state to an MQTT broker and accepts
commands over MQTT, using a [zigbee2mqtt](https://www.zigbee2mqtt.io/guide/usage/mqtt_topics_and_messages.html)-style
topic layout.

The bridge is optional and additive: it is only started when `--mqtt-url` is given. Without the flag the
server behaves exactly as documented in the [WebSocket API](websockets_api.md). When enabled, both APIs
run side by side against the same controller — MQTT is a second consumer of the controller event hub, not
a replacement for the WebSocket API.

## Enabling the Bridge

```bash
matter-server --mqtt-url mqtt://user:password@localhost:1883 --mqtt-prefix matter2mqtt
```

| CLI flag | Environment variable | Default | Description |
|----------|---------------------|---------|-------------|
| `--mqtt-url <url>` | `MQTT_URL` | *(unset — bridge disabled)* | Broker URL. Supported schemes: `mqtt:`, `mqtts:`, `ws:`, `wss:`. Credentials may be embedded in the URL |
| `--mqtt-prefix <prefix>` | `MQTT_PREFIX` | `matter2mqtt` | Topic prefix for all bridge topics |
| `--mqtt-client-id <id>` | `MQTT_CLIENT_ID` | `matter2mqtt` | MQTT client id |

The prefix may contain slashes (`home/matter`) but must not be empty, start or end with `/`, or contain
`+`, `#` or whitespace. An invalid prefix or an unsupported URL scheme fails bridge construction at startup.

**Security note:** MQTT commands carry full control of the Matter fabric, including commissioning and
decommissioning. There is no per-topic authorization in the bridge — anyone who can publish to
`<prefix>/#` can control every device and add or remove nodes. Keep the broker on localhost or a
firewalled LAN and use broker credentials and ACLs.

## Connection Semantics

- **Startup never blocks on the broker.** Connect, retry and backoff are handled by MQTT.js; outbound
  messages are queued while offline. If the broker is unavailable the rest of the server starts normally.
- **The bridge starts the Matter stack itself.** With `--mqtt-url` the controller is started even if no
  WebSocket client ever connects, so device state is available immediately.
- **Publishes use QoS 0.** Topics marked *retained* below are published with the retain flag. The
  last-will message on `<prefix>/bridge/state` is retained with QoS 1.
- **Every (re)connect re-publishes the full picture**: Home Assistant discovery, all device states and
  availability, the device list, bridge info, the credential and commission-mode state, and finally
  `bridge/state: online`. A broker restart publishes the bridge's last will and may drop retained state, so
  the bridge treats each connect as a fresh sync.
- **Retained topics are cleared** (empty payload) when a device or an entity disappears.
- On graceful shutdown the bridge publishes `{"state":"offline"}` on `<prefix>/bridge/state` before
  disconnecting; on an unexpected disconnect the broker publishes the same payload as the last will.

## Topic Overview

`<prefix>` is the configured topic prefix (default `matter2mqtt`), `<node>` is the Matter node id as a
decimal string, `<endpoint>` a Matter endpoint number.

| Topic | Direction | Retained | Payload |
|-------|-----------|----------|---------|
| `<prefix>/bridge/state` | publish (LWT) | yes | `{"state":"online"}` / `{"state":"offline"}` |
| `<prefix>/bridge/info` | publish | yes | Server version, BLE flags, prefix |
| `<prefix>/bridge/devices` | publish | yes | JSON array of known devices |
| `<prefix>/bridge/commission_status` | publish | yes | Human-readable commissioning progress |
| `<prefix>/bridge/commission_code` | publish | yes | State of the HA commission-code input (cleared after each request) |
| `<prefix>/bridge/commission_mode` | publish | yes | Selected commission mode |
| `<prefix>/bridge/wifi_ssid` | publish | yes | Stored/pending WiFi SSID |
| `<prefix>/bridge/wifi_password` | publish | yes | `********` when a password is stored, else empty |
| `<prefix>/bridge/thread_dataset` | publish | yes | `********` when a dataset is stored, else empty |
| `<prefix>/bridge/request/<command>` | subscribe | — | Bridge command request (JSON, or a bare value for some commands) |
| `<prefix>/bridge/response/<command>` | publish | no | `{"status":"ok"\|"error", ...}` |
| `<prefix>/<node>` | publish | yes | Full merged device state JSON |
| `<prefix>/<node>/availability` | publish | yes | `online` / `offline` (plain string) |
| `<prefix>/<node>/set` | subscribe | — | Device command, JSON object or bare value |
| `<prefix>/<node>/set/<property>` | subscribe | — | Device command, bare payload for a single property |
| `<prefix>/<node>/get` | subscribe | — | Re-publish the current state (payload ignored) |
| `<prefix>/<node>/<endpoint>/set` | subscribe | — | Same as `/set`, targeting one endpoint |
| `<prefix>/<node>/<endpoint>/set/<property>` | subscribe | — | Same as `/set/<property>`, targeting one endpoint |
| `<prefix>/<node>/<endpoint>/get` | subscribe | — | Re-publish the current state (endpoint ignored) |

Subscription filters used by the bridge: `<prefix>/+/set`, `<prefix>/+/+/set`, `<prefix>/+/set/+`,
`<prefix>/+/+/set/+`, `<prefix>/+/get`, `<prefix>/+/+/get`, `<prefix>/bridge/request/#`.

Notes on parsing:

- Device state lives on the single `<prefix>/<node>` topic; there are no per-endpoint state topics.
  `<prefix>/<node>/<endpoint>` is actively cleared (it was used by an earlier layout).
- `bridge` is never treated as a device, so `<prefix>/bridge/set` and `<prefix>/bridge/get` are ignored.
- The `<endpoint>` segment must be numeric. Topics with a non-numeric or extra segment
  (`<prefix>/5/x/set`, `<prefix>/5/2/3/set`) are ignored.
- `<prefix>/<node>/get/<property>` is not a valid topic.

Home Assistant discovery is published under the separate, fixed `homeassistant/` prefix — see
[Home Assistant Discovery](#home-assistant-discovery).

## Bridge Topics

### bridge/state

Bridge connectivity, also registered as the MQTT last will (retained, QoS 1):

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

Every commissioned node known to the controller. Republished on node add/remove, structure change and
availability change:

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

`id` is the `<node>` topic segment. `vendor_name`, `product_name`, `node_label`, `serial_number` and
`unique_id` come from BasicInformation (`0/40/1`, `0/40/3`, `0/40/5`, `0/40/15`, `0/40/18`) and are omitted
when the attribute is missing or blank. Node ids are serialized as unquoted JSON numbers and may exceed
`Number.MAX_SAFE_INTEGER` — see [BigInt Handling](websockets_api.md#bigint-handling).

### Commissioning feedback topics

These retained topics back the Home Assistant bridge card and are also useful standalone:

| Topic | Payload |
|-------|---------|
| `bridge/commission_status` | `idle` at startup, `commissioning...` while a `commission` request runs, then `ok: node <id>` or `error: <message>` |
| `bridge/commission_code` | Always cleared to a single space (` `) — the code input is write-only. An empty retained payload would be dropped by the broker, so a space is used and trimmed by the HA template |
| `bridge/commission_mode` | `Auto`, `WiFi`, `Thread` or `Existing (IP)`. Resets to `Auto` on restart (the mode is in-memory only) |
| `bridge/wifi_ssid` | Stored SSID, or the half-entered pending SSID |
| `bridge/wifi_password` | `********` if a password is stored, empty otherwise. **The secret is never published** |
| `bridge/thread_dataset` | `********` if a dataset is stored, empty otherwise. **The secret is never published** |

## Device State

`<prefix>/<node>` carries the full merged state of the node as a single retained JSON object
(zigbee2mqtt `cache_state` model: any relevant attribute change re-publishes the whole object). It is
built from the controller's attribute cache, so it is available without an extra read.

```json
{
  "state": "ON",
  "brightness": 200,
  "color_mode": "hs",
  "color": { "hue": 240, "saturation": 100, "h": 240, "s": 100, "x": 0.1355, "y": 0.0399 },
  "color_temp": 250
}
```

### Properties

| Property | Source (`cluster/attribute`) | Value |
|----------|------------------------------|-------|
| `state` | OnOff `6/0` | `ON` / `OFF` |
| `brightness` | LevelControl `8/0` | 0–254 (raw Matter level) |
| `color_mode` | ColorControl `768/8` | `hs` (0), `xy` (1), `color_temp` (2) |
| `color` | ColorControl `768/{0,1,16384}` or `768/{3,4}` | See below |
| `color_temp` | ColorControl `768/7` | Mireds, as reported by the device |
| `occupancy` | OccupancySensing `1030/0` | `true` / `false` (bit 0 of the bitmap) |
| `illuminance` | IlluminanceMeasurement `1024/0` | Lux, `10^((raw-1)/10000)` rounded; omitted when raw ≤ 0 |
| `temperature` | TemperatureMeasurement `1026/0` | °C, `raw/100` rounded to 2 decimals |
| `humidity` | RelativeHumidityMeasurement `1029/0` | %, `raw/100` rounded to 2 decimals |
| `contact` | BooleanState `69/0` | `true` = closed, `false` = open (zigbee2mqtt semantics) |
| `battery` | PowerSource `47/12` | %, `raw/2` (BatPercentRemaining is in half percent). Device-level: the first PowerSource occurrence wins |
| `update` | OtaSoftwareUpdateRequestor `42/{2,3}` + BasicInformation `40/{9,10}` | Firmware update state object, device-level — see [Firmware Updates](#firmware-updates) |

`color` is kept consistent across representations, the way zigbee2mqtt's `syncColorState` does: whichever
mode the endpoint reports, the others are derived from it, so a consumer never reads a value left over
from a previous mode.

| Reported mode | `color` contents | `color_temp` |
|---------------|------------------|--------------|
| `hs` | `hue` (0–360) and `saturation` (0–100), plus the short keys `h`/`s` and the derived `x`/`y` | Derived from the current color |
| `xy` | `x`/`y` (each `raw/65535`, 4 decimals), plus `hue`/`saturation`/`h`/`s` derived from them | Derived from the current color |
| `color_temp` | `x`/`y` and `hue`/`saturation`/`h`/`s` derived from the mireds | The reported mireds |

Short keys are shipped because Home Assistant's JSON light schema only reads those, and its color wheel
reads `x`/`y`. `enhancedCurrentHue` (`768/16384`) is preferred over `currentHue` when the endpoint
supports the EnhancedHue feature. Derived properties only appear for features the endpoint actually has
(the one exception is `x`/`y` in `hs` mode, which are always published for Home Assistant), and a derived
`color_temp` is clamped to the endpoint's physical mireds range. Deriving a color temperature from a
saturated color is inherently approximate — such a color is nowhere near the Planckian locus — but this is
what zigbee2mqtt reports too.

Properties are only present when the endpoint actually exposes the cluster **and** a value is cached.
The state topic is not published while the resulting object would be empty.

### Multi-endpoint devices

Endpoints that expose OnOff, OccupancySensing, IlluminanceMeasurement, TemperatureMeasurement,
RelativeHumidityMeasurement or BooleanState contribute to the state object. A property provided by exactly
one endpoint keeps its plain name; a property provided by several endpoints gets the zigbee2mqtt
`_<endpoint>` suffix on all of them. A dual relay therefore publishes:

```json
{ "state_1": "ON", "state_2": "OFF" }
```

Suffixing is decided from endpoint *capabilities*, not from current values, so names stay stable while
values are still unknown.

### Firmware updates

Nodes exposing the OTA Requestor cluster (`0/42/2` present) carry a device-level `update` property,
shaped like zigbee2mqtt's:

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

| Field | Meaning |
|-------|---------|
| `state` | `idle`, `available` (a newer firmware is known) or `updating` |
| `installed_version` / `installed_version_string` | BasicInformation `0/40/9` / `0/40/10`. The `_string` variant falls back to the numeric version, so it is never null while the version is known |
| `latest_version` / `latest_version_string` | Target of the last check. **Equal to the installed version when nothing is pending** — that is what tells Home Assistant the node is up to date |
| `latest_source` | `main-net-dcl`, `test-net-dcl` or `local`. Anything but `main-net-dcl` is an uncertified image |
| `latest_release_notes` | Release notes URL, when the DCL entry carries one |
| `progress` | Download progress in percent, present only while `updating` |

`state` is derived from the node's own UpdateState (`0/42/2`): anything other than Idle/Unknown is
`updating`. Right after an install request the bridge reports `updating` for up to 15 minutes even
while the node still says Idle, so the Home Assistant install button does not bounce back before the
device starts downloading. Nothing is persisted: after a bridge restart the state comes from the
node's attributes again.

`available` requires a completed check. The controller polls the DCL on its own schedule but does not
expose the result, so the bridge asks per node: 30 s after startup and every 24 h after that, plus on
demand via `bridge/request/device/ota_update/check`. Unreachable nodes are skipped, and there is a
5 s gap between nodes so a pass does not burst DCL queries.

### State refresh triggers

A re-publish happens on any change of `6/0`, `8/0`, `768/{0,1,3,4,7,8,16384}`, `1030/0`, `1024/0`,
`1026/0`, `1029/0`, `69/0`, `47/12`, `42/{2,3}`, `40/{9,10}`, and on node add, structure change,
availability change, a firmware check/install command and `<prefix>/<node>/get`.

`47/12`, `42/{2,3}` and `40/{9,10}` back device-level properties (`battery`, `update`), so a change
on any endpoint re-publishes the state without being mistaken for a structure change.

### Availability

`<prefix>/<node>/availability` is a retained plain string, `online` or `offline`, tracking the
controller's node availability. It is published when a device is (re)synced and on every availability
change. On decommission the availability, state and discovery topics of that node are cleared.

## Device Commands

### `<prefix>/<node>/set`

JSON object payload:

```json
{ "state": "ON", "brightness": 180, "transition": 2 }
```

| Property | Accepted values |
|----------|-----------------|
| `state` | `ON` / `OFF` / `TOGGLE` (case-insensitive), `true` / `false`, or `null` (adjust level only) |
| `brightness` | 0–254 (255 is accepted and treated as 254) |
| `brightness_percent` | 0–100, scaled to 0–254 |
| `color` | Any zigbee2mqtt color form — see [Color formats](#color-formats) |
| `color_temp` | Mireds (clamped to the endpoint's physical min/max), or a preset: `coolest`, `cool` (250), `neutral` (370), `warm` (454), `warmest` |
| `transition` | Transition time in seconds (converted to Matter's 0.1 s units) |
| `brightness_move`, `brightness_step`, `color_temp_move`, `color_temp_step`, `hue_move`, `hue_step`, `saturation_move`, `saturation_step` | Relative control — see [Move and step](#move-and-step) |

Any other property is ignored with a log warning, as is a property the endpoint does not support
(e.g. `color_temp` on a plain switch).

**Bare payloads.** A payload that is not a JSON object is interpreted as a state value:
`ON`, `OFF`, `TOGGLE`, `true`, `false` (and, for zigbee2mqtt compatibility, the strings `open`, `close`,
`stop`, `lock`, `unlock`, which are currently rejected with a warning because no cluster maps them yet).

**`<prefix>/<node>/set/<property>`** takes the bare value of a single property, JSON-parsed when possible:

```
matter2mqtt/5/set/state        →  ON
matter2mqtt/5/set/brightness   →  180
matter2mqtt/5/set/color_temp   →  warm
matter2mqtt/5/set/color        →  {"hue":120,"saturation":80}
```

### Endpoint targeting

The target endpoint is, in order of precedence:

1. the `_<endpoint>` suffix on a property (`{"state_1":"ON","state_2":"OFF"}` addresses both endpoints of a
   dual relay in one message),
2. the `<endpoint>` topic segment (`<prefix>/<node>/2/set`),
3. the node's first OnOff endpoint.

A suffix that does not match a known OnOff endpoint is treated as part of the property name (matching
zigbee2mqtt). Commands are only accepted for endpoints that expose the OnOff cluster; anything else is
logged and dropped.

### Color formats

`color` accepts every form zigbee2mqtt accepts, resolved in this order (the first form whose keys are
all present wins, so `{"x":…,"y":…,"h":…}` is read as xy):

| Form | Example |
|------|---------|
| CIE xy | `{"x":0.7,"y":0.3}` |
| RGB components, 0–255 | `{"r":255,"g":0,"b":0}` |
| RGB string | `{"rgb":"255,0,0"}` |
| Hex | `{"hex":"#FF0000"}`, or the bare string `"#FF0000"` |
| HSL | `{"h":120,"s":100,"l":50}`, `{"hsl":"120,100,50"}` |
| HSB / HSV | `{"h":120,"s":50,"b":80}`, `{"hsb":"120,50,80"}`, `{"h":120,"s":50,"v":80}`, `{"hsv":"120,50,80"}` |
| Hue / saturation | `{"h":120,"s":50}`, `{"hue":120,"saturation":50}`, or either alone (`{"h":120}`, `{"s":50}`) |

Hue is 0–360, saturation, lightness and value are 0–100, x/y are 0–1, RGB components 0–255. Numeric
strings are accepted (Home Assistant templates produce them). A hue-only payload may carry
`"direction"`, which is passed to the Matter hue move.

Which color space reaches the device follows zigbee2mqtt: **hue/saturation for HSV-style payloads when
the endpoint supports that feature, xy for everything else** (RGB, hex, xy, and HSV on an endpoint
without hue/saturation support). Two Matter-specific additions, because xy support is a feature bit
there and not a given as on Zigbee:

- an endpoint without xy support receives a converted hue/saturation command instead of being skipped;
- an endpoint with neither feature warns and ignores the payload.

The HSV/HSB forms carry a third component (`v` / `b`) which zigbee2mqtt treats as the **light level**,
not as part of the color: `{"h":120,"s":50,"v":80}` also sends `moveToLevelWithOnOff` at 80 % of 254.
This only happens on the hue/saturation path, matching zigbee2mqtt.

### Move and step

Relative control, as in zigbee2mqtt: a `*_move` runs until it is stopped, a `*_step` applies one
increment. A positive value goes up, a negative one down; `0`, `"stop"` and `"release"` stop a move.
Several of these may appear in one message and are sent in the order the message lists them.

| Property | Matter command | Notes |
|----------|----------------|-------|
| `brightness_move` | LevelControl `move`, or `stop` | `brightness_move_onoff` uses `moveWithOnOff`; both stop with the plain `stop` |
| `brightness_step` | LevelControl `step` | `brightness_step_onoff` uses `stepWithOnOff`; honors `transition` |
| `color_temp_move` (or `colortemp_move`) | ColorControl `moveColorTemperature` | See the value forms below |
| `color_temp_step` | ColorControl `stepColorTemperature` | Honors `transition` |
| `hue_move` / `saturation_move` | ColorControl `moveHue` / `moveSaturation` | Stopping sends mode Stop with rate 1, as zigbee2mqtt does |
| `hue_step` / `saturation_step` | ColorControl `stepHue` / `stepSaturation` | Honors `transition` |

`color_temp_move` takes three forms, keeping zigbee2mqtt's differences between them:

- a signed rate (`{"color_temp_move":30}`) over the full 0–600 mireds bound;
- the words `"up"` / `"down"` (`"1"` counts as up), which default to rate 55 and the narrower 153–370
  mireds bound; a sibling `"rate"` property overrides the rate;
- an object `{"rate":20,"minimum":200,"maximum":454}`; the bounds default to 0–600 and a `minimum` that
  is not below `maximum` is rejected.

Matter requires the mireds bounds on both color temperature commands, so `color_temp_step` always sends
0–600.

Move and step properties are dropped with a warning on endpoints without the matching feature
(`brightness_*` needs LevelControl, `color_temp_*` the ColorTemperature feature, `hue_*`/`saturation_*`
the HueSaturation feature). The rate and step units are the raw Matter ones (level 0–254, hue 0–254,
saturation 0–254, mireds), matching what zigbee2mqtt sends to Zigbee.

### Mapping to Matter commands

| Message | Matter command |
|---------|----------------|
| `state` only | OnOff `on` / `off` / `toggle` |
| `state: "OFF"` with `transition` > 0 (dimmable endpoint) | LevelControl `moveToLevelWithOnOff`, level 0 |
| `brightness` (with or without `state`) | LevelControl `moveToLevelWithOnOff` |
| `brightness` with `state: null` | LevelControl `moveToLevel` (level only, no on/off change) |
| `color_temp` | ColorControl `moveToColorTemperature` |
| `color` resolved to xy (RGB, hex, xy, HSV without HS support) | ColorControl `moveToColor` |
| `color` with hue + saturation | ColorControl `enhancedMoveToHueAndSaturation`, or `moveToHueAndSaturation` without the EnhancedHue feature |
| `color` with hue only | ColorControl `enhancedMoveToHue` / `moveToHue` (direction from the payload, else 0) |
| `color` with saturation only | ColorControl `moveToSaturation` |
| `color` with an HSV value component | LevelControl `moveToLevelWithOnOff` in addition to the color command |

LevelControl and ColorControl commands are sent with `optionsMask: 0, optionsOverride: 0`.

zigbee2mqtt decision rules the bridge follows:

- `brightness` without `state` infers the state: 0 turns the light off, anything else turns it on.
- `state: "ON"` with `brightness: 0` is raised to level 1 (it does not turn the light off).
- `state: "TOGGLE"` combined with `brightness` is resolved against the cached OnOff value; if that value
  is unknown the command is rejected with a warning.
- Command order: when the message turns the light **off**, the state command is sent first (some bulbs
  reject color changes while off); otherwise color and color temperature are sent before the state
  command, so the light turns on with the new color.

Commands from one message are invoked sequentially. A failing command is logged and does not stop the
remaining ones.

### `<prefix>/<node>/get`

Reads the state attributes from the device and publishes the result on `<prefix>/<node>`, following
zigbee2mqtt's `get` semantics. Only the paths the node is known to have are requested. The read result
is used for that publish but does not replace the subscription cache; an unreachable node or a failing
read falls back to publishing what the cache holds.

The payload is ignored, and so is the `<endpoint>` segment on the two-level form — `get` always
re-publishes the full device state.

### Errors

Device commands are fire-and-forget: there is no per-device response topic. Unknown devices, unsupported
payloads, endpoints without OnOff, rejected values and failed invocations are reported through the server
log only. Use `<prefix>/<node>` (published after the attribute change lands) to confirm the effect.

## Bridge Commands

Bridge commands are a zigbee2mqtt-style request/response pair:

- Request: `<prefix>/bridge/request/<command>` with a JSON object payload.
- Response: `<prefix>/bridge/response/<command>` (not retained) with
  `{"status":"ok","data":{…}}` or `{"status":"error","error":"<message>"}`.
- A `transaction` property in the request is echoed back in the response for request/response matching.
- An unknown command answers `{"status":"error","error":"unknown command \"…\""}`.
- Commands never throw across the bridge: failures always come back as a `status: "error"` response.

For the five single-value commands below, a bare (non-JSON) payload is accepted and mapped to the
documented key, which is what Home Assistant text and select entities publish:

| Command | Bare payload key |
|---------|------------------|
| `commission` | `code` |
| `commission_mode` | `mode` |
| `wifi_ssid` | `ssid` |
| `wifi_password` | `password` |
| `thread_dataset` | `dataset` |

A bare numeric-looking payload keeps its exact digits (pairing codes, hex datasets are not converted to
numbers). For every other command a payload that is not a JSON object is rejected.

### Command reference

| Command | Request | Response `data` |
|---------|---------|-----------------|
| `commission` | `{"code": "<QR or manual code>", "network": "wifi"\|"thread", "network_only": true}` | `{"node_id": 5}` |
| `commission_mode` | `{"mode": "Auto"\|"WiFi"\|"Thread"\|"Existing (IP)"}` | `{"mode": "…"}` |
| `wifi_credentials` | `{"ssid": "…", "credentials": "…"}` | `{"ssid": "…"}` |
| `wifi_ssid` | `{"ssid": "…"}` | `{"ssid": "…"}` or `{"pending": "password"}` |
| `wifi_password` | `{"password": "…"}` | `{"ssid": "…"}` or `{"pending": "ssid"}` |
| `thread_dataset` | `{"dataset": "<hex TLV>"}` | `{}` |
| `restart` | `{}` | `{}` |
| `device/remove` | `{"id": <node id>}` | `{"id": <node id>}` |
| `device/interview` | `{"id": <node id>}` | `{"id": <node id>}` |
| `device/rename` | `{"id": <node id>, "name": "…"}` | `{"id": <node id>, "name": "…"}` |
| `device/share` | `{"id": <node id>}` | `{"id": <node id>, "manual_code": "…", "qr_code": "MT:…"}` |
| `device/ota_update/check` | `{"id": <node id>}` | `{"id": …, "update_available": true, "latest_version": 16777236, "latest_version_string": "1.0.4", "latest_source": "main-net-dcl", "latest_release_notes": "…"}` |
| `device/ota_update/update` | `{"id": <node id>, "software_version": 16777236}` | `{"id": …, "software_version": 16777236, "software_version_string": "1.0.4"}` |

**commission** mirrors the WebSocket `commission_with_code` orchestration:

- A code starting with `MT:` is treated as a QR code, anything else as a manual pairing code.
- For BLE commissioning the stored `default` WiFi credentials and Thread dataset are offered (only when
  actually present). The network type auto-negotiates via the NetworkCommissioning cluster.
- `network: "wifi"` or `"thread"` restricts commissioning to that credential type and fails early with a
  clear error when it is not stored yet.
- `network_only: true` commissions over IP only ("add an existing device"), without credentials.
- When neither `network` nor `network_only` is given (the bare-code case), the currently selected
  `commission_mode` decides: `Auto` offers all stored credentials, `WiFi`/`Thread` force one type,
  `Existing (IP)` maps to `network_only`.
- Node ids are allocated by the server. A node id that collides with an existing identity on the fabric is
  retried with the next id, up to 5 attempts.
- Progress is mirrored on `bridge/commission_status`; the final result is on
  `bridge/response/commission`.

```
Topic:   matter2mqtt/bridge/request/commission
Payload: {"code":"MT:Y.K9042C00KA0648G00","network":"thread","transaction":"abc"}

Topic:   matter2mqtt/bridge/response/commission
Payload: {"status":"ok","data":{"node_id":7},"transaction":"abc"}
```

**wifi_ssid / wifi_password** exist for the two single-value Home Assistant text entities. The two halves
are combined in memory and persisted only once both are known; re-sending an unchanged SSID reuses the
stored (write-only) password. Until then the response reports which half is still `pending`.
`wifi_credentials` sets both at once. Every credential command re-publishes the masked credential state
topics, including on error, so the UI falls back to the stored truth.

**thread_dataset** stores the hex-encoded operational dataset and registers it with the controller's
credential store, which also enables MeshCoP diagnostics for that Thread network (see
[Thread Network Diagnostics](websockets_api.md#thread-network-diagnostics)).

All credential commands write the reserved `default` credential entry — the same entry the WebSocket API
uses when no `id` is given. Named credential lists are WebSocket-only for now.

**device/rename** writes BasicInformation `nodeLabel` (`0/40/5`). **device/share** opens a commissioning
window and returns the pairing codes for multi-admin sharing.

**device/ota_update/check** queries the DCL and the local image store for a newer firmware, and
remembers the answer for the node's `update` property. **device/ota_update/update** starts the update;
`software_version` is optional and defaults to the target of the last check (or of a check run right
then), which is what Home Assistant's install button needs — it can only send the node id.

Both run at most one operation per node: a request that arrives while a check or install is running for
that node is rejected. A successful install request only means the update was **queued**; the device
downloads and applies it asynchronously, and progress shows up in the `update` property. Failure modes
worth knowing:

- the controller rejects an install while the node reports a non-Idle UpdateState, is offline, or has
  no known update;
- a check answers `update_available: false` both when there is genuinely nothing and when the DCL
  lookup failed — the controller does not distinguish the two;
- check results are cached by the controller without expiry, so a check can answer from that cache
  rather than from a fresh DCL query.

> **Not yet verified on real hardware.** The OTA surface is wired to the same controller calls the
> WebSocket API uses for `check_node_update` / `update_node`, and it is covered by unit tests, but no
> firmware has been pushed to a device over MQTT yet. Before relying on it, please review whether this
> topic/payload shape is the right API and run an end-to-end update on a real node.

**restart** exits the process (exit code 1) about 500 ms after answering, so a supervisor with a restart
policy (systemd `Restart=`, Docker `restart:`) brings the server back up. Without such a supervisor the
server stays down.

## Home Assistant Discovery

The bridge publishes retained [MQTT discovery](https://www.home-assistant.io/integrations/mqtt/#mqtt-discovery)
configuration under the fixed `homeassistant/` prefix (not configurable):

```
homeassistant/<component>/matter2mqtt_bridge/<object_id>/config
homeassistant/<component>/matter2mqtt_<node>/<object_id>/config
```

Discovery is republished on every connect and whenever a node's structure changes; entity topics that
disappear are cleared, and all of a node's discovery topics are cleared when it is decommissioned.

### Clearing what the bridge no longer publishes

A retained topic outlives the process that published it, so anything the bridge stops publishing would
otherwise stay on the broker: an entity dropped or renamed in a new version keeps appearing in Home
Assistant, and a node decommissioned while the bridge was down leaves its state and entities behind.

After publishing the full picture on each connect, the bridge subscribes to
`homeassistant/+/+/+/config`, `<prefix>/+` and `<prefix>/+/availability` — the retained topics the
broker then replays are compared against what it just published, and the leftovers are cleared. The
subscription stays, so every reconnect reconciles again.

Only topics that are provably the bridge's own are touched:

- a discovery config must have a payload referencing this bridge's topic prefix, so a second bridge on
  another prefix, or another integration's entities, are never claimed;
- under the bridge's own prefix, only `<prefix>/<node>` and `<prefix>/<node>/availability` for a node
  that is not commissioned qualify — `bridge/…` topics and command topics are left alone;
- an empty payload is a clear, not content, and is ignored.

Anything unrecognized is left in place: a leftover entity is cosmetic, while deleting another
integration's discovery config would break it.

### Bridge entities

Device `Matter2MQTT Bridge` (identifier `matter2mqtt_bridge`), in publish order:

| Entity | Component | Backing topic |
|--------|-----------|---------------|
| Connection state | `binary_sensor` (connectivity, diagnostic) | `bridge/state` |
| Version | `sensor` (diagnostic) | `bridge/info` |
| Commission status | `sensor` | `bridge/commission_status` |
| Commissioned nodes | `sensor` (count of the device list) | `bridge/devices` |
| WiFi SSID | `text` (config, max 32) | `bridge/request/wifi_ssid` → `bridge/wifi_ssid` |
| WiFi password | `text` (config, password mode, max 64) | `bridge/request/wifi_password` → `bridge/wifi_password` |
| Thread dataset | `text` (config, password mode, max 255) | `bridge/request/thread_dataset` → `bridge/thread_dataset` |
| Commission mode | `select` (config) | `bridge/request/commission_mode` → `bridge/commission_mode` |
| Commission code | `text` (config) | `bridge/request/commission` → `bridge/commission_code` |
| Restart | `button` (restart) | `bridge/request/restart` |

Entity creation order shapes Home Assistant's auto-generated device card: sensors first, configuration in
the middle, restart last.

### Device entities

Per node, derived from endpoint capabilities. Device identifier `matter2mqtt_<node>`, unique ids
`matter2mqtt_<node>_<entity>[_<endpoint>]`; the device name falls back to `Matter node <node>` when
BasicInformation carries no product name.

| Condition | Entity |
|-----------|--------|
| OnOff + LevelControl | `light`, JSON schema, `brightness_scale: 254`, `supported_color_modes` from the ColorControl feature map (`hs`, `xy`, `color_temp`), `min_mireds`/`max_mireds` from the device |
| OnOff only | `switch` (`{"state":"ON"}` / `{"state":"OFF"}` payloads) |
| OccupancySensing | `binary_sensor`, device class `motion` |
| BooleanState | `binary_sensor`, device class `door`, inverted (`contact: false` = open = `on`) |
| IlluminanceMeasurement | `sensor`, `lx`, measurement |
| TemperatureMeasurement | `sensor`, `°C`, measurement |
| RelativeHumidityMeasurement | `sensor`, `%`, measurement |
| PowerSource `47/12` | `sensor`, `%`, battery, diagnostic (device-level) |
| OtaSoftwareUpdateRequestor `42/2` | `update`, device class `firmware`, config category (device-level). Installs via `payload_install: {"id":"<node>"}`; versions are piped through `tojson` so an unknown version stays JSON `null` instead of Jinja's `None` |

All device entities use `availability_mode: all` over two topics — `<prefix>/bridge/state` and
`<prefix>/<node>/availability` — so entities go unavailable both when the bridge is down and when the node
is unreachable. Entity `value_template`s use the resolved property name, so they follow the
`_<endpoint>` suffix rule automatically, and command topics point at `<prefix>/<node>/set` or
`<prefix>/<node>/<endpoint>/set`.

**Known limitation:** Home Assistant's JSON light schema reads fixed property names (`state`,
`brightness`, …). A device with several light endpoints publishes suffixed keys (`state_1`), so those
entities accept commands but do not reflect state. Single-light devices — the common case — work fully.

## Cluster Coverage

Mapped today: OnOff (6), LevelControl (8), ColorControl (768), IlluminanceMeasurement (1024),
TemperatureMeasurement (1026), RelativeHumidityMeasurement (1029), OccupancySensing (1030),
BooleanState (69), PowerSource (47, battery percentage), OtaSoftwareUpdateRequestor (42, firmware
updates) and BasicInformation (40, device metadata and firmware version).

Everything else — including WindowCovering, DoorLock, Thermostat, scenes/groups and diagnostics — is
only reachable through the [WebSocket API](websockets_api.md).

## Relation to the WebSocket API

| Concern | MQTT | WebSocket |
|---------|------|-----------|
| Device state | Retained per-node JSON, zigbee2mqtt property names | `attribute_updated` events, raw `endpoint/cluster/attribute` paths |
| Device control | `<node>/set` with high-level properties | `device_command`, `write_attribute` (raw cluster commands) |
| Commissioning | `bridge/request/commission` (`default` credentials) | `commission_with_code`, `commission_on_network`, named credential lists |
| Node management | `bridge/request/device/{remove,interview,rename,share}` | `remove_node`, `interview_node`, `write_attribute`, `open_commissioning_window` |
| Firmware updates | `bridge/request/device/ota_update/{check,update}` + the `update` state property | `check_node_update`, `update_node`, `initiate_ota_upload` (local image upload) |
| Diagnostics, ACL, bindings, ICD, topology | not exposed | full command set |
| Schema/versioning | none — the topic layout is versioned by the release | `schema_version` negotiation |

Both APIs act on the same controller and the same fabric. A change made over MQTT shows up in the
WebSocket event stream and vice versa.
