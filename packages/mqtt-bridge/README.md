# @matter-server/mqtt-bridge

MQTT bridge for matter.js server (matter2mqtt). Publishes Matter device state to an MQTT
broker and accepts commands over MQTT, in a zigbee2mqtt-style topic layout.

Enabled by passing `--mqtt-url` to matter-server; without the flag the bridge is not started
and the server behaves exactly like the upstream release.

```bash
matter-server --mqtt-url mqtt://user:password@localhost:1883 --mqtt-prefix matter2mqtt
```

## Topics

| Topic | Direction | Payload |
| --- | --- | --- |
| `<prefix>/bridge/state` | publish, retained (LWT) | `{"state":"online"}` / `{"state":"offline"}` |
| `<prefix>/bridge/info` | publish, retained | server version, BLE proxy state |
| `<prefix>/bridge/devices` | publish, retained | JSON array of known devices |
| `<prefix>/bridge/request/<command>` | subscribe | bridge command, answered on `<prefix>/bridge/response/<command>` |
| `<prefix>/<node>/availability` | publish, retained | `online` / `offline` |
| `<prefix>/<node>` | publish, retained | full merged state JSON, e.g. `{"state":"ON","brightness":200,"color_mode":"hs","color":{"hue":240,"saturation":100},"color_temp":250}`; sensors add `occupancy`, `illuminance` (lx), `temperature`, `humidity`, `battery`, `contact`; a property provided by several endpoints (e.g. a dual relay) gets the zigbee2mqtt `_<endpoint>` suffix (`state_1`), unique properties stay plain |
| `<prefix>/<node>/set` | subscribe | `{"state":"ON","brightness":180,"color":{"hue":240,"saturation":100}}` or a bare state string |
| `<prefix>/<node>/set/<property>` | subscribe | bare payload form, e.g. `ON` on `.../set/state` |
| `<prefix>/<node>/get` | subscribe | re-publishes the current state (payload ignored) |
| `<prefix>/<node>/<endpoint>/set` | subscribe | per-endpoint command variant; payloads may also target endpoints via the `_<endpoint>` property suffix (`{"state_1":"ON"}`) |

`<node>` is the Matter node id. Home Assistant MQTT discovery is published under the
`homeassistant/` prefix for the bridge itself and for every device.

Full reference (state properties and conversions, `/set` semantics and Matter command mapping,
bridge commands, HA discovery): [docs/mqtt_api.md](../../docs/mqtt_api.md)
([中文版](../../docs/mqtt_api.zh-CN.md)).

Security note: MQTT commands carry full control of the Matter fabric. Keep the broker on
localhost or a firewalled LAN and use credentials.
