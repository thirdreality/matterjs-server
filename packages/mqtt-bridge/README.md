# @matter-server/mqtt-bridge

MQTT bridge for matter.js server (matter2mqtt). Publishes Matter device state to an MQTT
broker and accepts commands over MQTT, in a zigbee2mqtt-style topic layout.

Enabled by passing `--mqtt-url` to matter-server; without the flag the bridge is not started
and the server behaves exactly like the upstream release.

```bash
matter-server --mqtt-url mqtt://user:password@localhost:1883 --mqtt-prefix matter2mqtt
```

## Topics (current milestone)

| Topic | Direction | Payload |
| --- | --- | --- |
| `<prefix>/bridge/state` | publish, retained (LWT) | `{"state":"online"}` / `{"state":"offline"}` |
| `<prefix>/bridge/info` | publish, retained | server version, BLE proxy state |
| `<prefix>/bridge/devices` | publish, retained | JSON array of known devices |
| `<prefix>/<node>/availability` | publish, retained | `online` / `offline` |
| `<prefix>/<node>` | publish, retained | device state JSON, e.g. `{"state":"ON"}` |
| `<prefix>/<node>/set` | subscribe | `{"state":"ON"\|"OFF"\|"TOGGLE"}` or bare string |
| `<prefix>/<node>/set/state` | subscribe | bare payload form: `ON` / `OFF` / `TOGGLE` |
| `<prefix>/<node>/get` | subscribe | re-publishes the current state (payload ignored) |
| `<prefix>/<node>/<endpoint>` and `.../set`, `.../get` | both | per-endpoint variant for multi-endpoint devices |

`<node>` is the Matter node id. Only the OnOff cluster is mapped in this milestone; further
clusters, commissioning commands, and Home Assistant discovery follow in later milestones.

Security note: MQTT commands carry full control of the Matter fabric. Keep the broker on
localhost or a firewalled LAN and use credentials.
