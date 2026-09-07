/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AttributesData } from "@matter-server/ws-controller";
import { COMMISSION_MODE_NAMES } from "./BridgeCommands.js";
import { endpointPropertyKeysOf, propertyNameResolver, sensorPresenceOf } from "./DeviceState.js";
import type { LightCapabilities } from "./LightCapabilities.js";
import type { Topics } from "./Topics.js";

/** Home Assistant MQTT discovery prefix (HA default). */
const DISCOVERY_PREFIX = "homeassistant";

export interface DiscoveryDeviceInfo {
    /** Node id string, the `<device>` topic segment and unique-id base. */
    device: string;
    vendorName?: string;
    productName?: string;
    serialNumber?: string;
    /** Server version, reported as the discovery origin. */
    serverVersion?: string;
}

export interface DiscoveryMessage {
    topic: string;
    payload: string;
}

/**
 * Discovery for the bridge itself: connectivity and version, zigbee2mqtt-style.
 * M2's commissioning command entities (permit join etc.) will join this device.
 */
export function bridgeDiscoveryMessagesOf(serverVersion: string | undefined, topics: Topics): DiscoveryMessage[] {
    const device = {
        identifiers: ["matter2mqtt_bridge"],
        name: "Matter2MQTT Bridge",
        manufacturer: "ThirdReality",
        model: "matter2mqtt",
        sw_version: serverVersion,
    };
    const origin = { name: "matter2mqtt", sw_version: serverVersion };
    return [
        {
            topic: `${DISCOVERY_PREFIX}/binary_sensor/matter2mqtt_bridge/connection_state/config`,
            payload: JSON.stringify({
                name: "Connection state",
                unique_id: "matter2mqtt_bridge_connection_state",
                state_topic: topics.bridgeState,
                value_template: "{{ value_json.state }}",
                payload_on: "online",
                payload_off: "offline",
                device_class: "connectivity",
                entity_category: "diagnostic",
                device,
                origin,
            }),
        },
        {
            topic: `${DISCOVERY_PREFIX}/sensor/matter2mqtt_bridge/version/config`,
            payload: JSON.stringify({
                name: "Version",
                unique_id: "matter2mqtt_bridge_version",
                state_topic: topics.bridgeInfo,
                value_template: "{{ value_json.version }}",
                entity_category: "diagnostic",
                availability: [{ topic: topics.bridgeState, value_template: "{{ value_json.state }}" }],
                device,
                origin,
            }),
        },
        {
            topic: `${DISCOVERY_PREFIX}/text/matter2mqtt_bridge/wifi_ssid/config`,
            payload: JSON.stringify({
                name: "WiFi SSID",
                unique_id: "matter2mqtt_bridge_wifi_ssid",
                command_topic: `${topics.prefix}/bridge/request/wifi_ssid`,
                state_topic: topics.bridgeWifiSsid,
                max: 32,
                entity_category: "config",
                availability: [{ topic: topics.bridgeState, value_template: "{{ value_json.state }}" }],
                device,
                origin,
            }),
        },
        {
            topic: `${DISCOVERY_PREFIX}/text/matter2mqtt_bridge/wifi_password/config`,
            payload: JSON.stringify({
                name: "WiFi password",
                unique_id: "matter2mqtt_bridge_wifi_password",
                command_topic: `${topics.prefix}/bridge/request/wifi_password`,
                state_topic: topics.bridgeWifiPassword,
                mode: "password",
                max: 64,
                entity_category: "config",
                availability: [{ topic: topics.bridgeState, value_template: "{{ value_json.state }}" }],
                device,
                origin,
            }),
        },
        {
            topic: `${DISCOVERY_PREFIX}/text/matter2mqtt_bridge/thread_dataset/config`,
            payload: JSON.stringify({
                name: "Thread dataset",
                unique_id: "matter2mqtt_bridge_thread_dataset",
                command_topic: `${topics.prefix}/bridge/request/thread_dataset`,
                state_topic: topics.bridgeThreadDataset,
                mode: "password",
                max: 255,
                entity_category: "config",
                availability: [{ topic: topics.bridgeState, value_template: "{{ value_json.state }}" }],
                device,
                origin,
            }),
        },
        {
            // Routes a bare-code commission: Auto offers all stored credentials (the network
            // type auto-negotiates), WiFi/Thread force one, Existing (IP) joins over network
            topic: `${DISCOVERY_PREFIX}/select/matter2mqtt_bridge/commission_mode/config`,
            payload: JSON.stringify({
                name: "Commission mode",
                unique_id: "matter2mqtt_bridge_commission_mode",
                command_topic: `${topics.prefix}/bridge/request/commission_mode`,
                state_topic: topics.bridgeCommissionMode,
                options: COMMISSION_MODE_NAMES,
                availability: [{ topic: topics.bridgeState, value_template: "{{ value_json.state }}" }],
                device,
                origin,
            }),
        },
        {
            // Paste a pairing code to commission following the selected mode; result on
            // bridge/response/commission and, human-readable, on the status sensor
            topic: `${DISCOVERY_PREFIX}/text/matter2mqtt_bridge/commission_code/config`,
            payload: JSON.stringify({
                name: "Commission code",
                unique_id: "matter2mqtt_bridge_commission_code",
                command_topic: `${topics.prefix}/bridge/request/commission`,
                command_template: '{"code":"{{ value }}"}',
                state_topic: topics.bridgeCommissionCode,
                availability: [{ topic: topics.bridgeState, value_template: "{{ value_json.state }}" }],
                device,
                origin,
            }),
        },
        {
            topic: `${DISCOVERY_PREFIX}/sensor/matter2mqtt_bridge/commission_status/config`,
            payload: JSON.stringify({
                name: "Commission status",
                unique_id: "matter2mqtt_bridge_commission_status",
                state_topic: topics.bridgeCommissionStatus,
                availability: [{ topic: topics.bridgeState, value_template: "{{ value_json.state }}" }],
                device,
                origin,
            }),
        },
        {
            topic: `${DISCOVERY_PREFIX}/button/matter2mqtt_bridge/restart/config`,
            payload: JSON.stringify({
                name: "Restart",
                unique_id: "matter2mqtt_bridge_restart",
                command_topic: `${topics.prefix}/bridge/request/restart`,
                payload_press: "{}",
                device_class: "restart",
                availability: [{ topic: topics.bridgeState, value_template: "{{ value_json.state }}" }],
                device,
                origin,
            }),
        },
    ];
}

/**
 * Generate the Home Assistant MQTT discovery messages for one device, derived from its
 * endpoint capabilities: light (JSON schema) or switch for OnOff endpoints, binary_sensor
 * and sensor entities for the sensor clusters. Messages are published retained; the topics
 * are also used to clear discovery when a device is removed.
 */
export function discoveryMessagesOf(
    info: DiscoveryDeviceInfo,
    attributes: AttributesData,
    endpoints: number[],
    capsOf: (endpoint: number) => LightCapabilities,
    topics: Topics,
): DiscoveryMessage[] {
    const messages: DiscoveryMessage[] = [];
    const nameOf = propertyNameResolver(attributes, endpoints, capsOf);
    const uidBase = `matter2mqtt_${info.device}`;

    const availability = [
        { topic: topics.bridgeState, value_template: "{{ value_json.state }}" },
        { topic: topics.deviceAvailability(info.device) },
    ];
    const device = {
        identifiers: [uidBase],
        name: info.productName ?? `Matter node ${info.device}`,
        manufacturer: info.vendorName,
        model: info.productName,
        serial_number: info.serialNumber,
    };
    const origin = { name: "matter2mqtt", sw_version: info.serverVersion };
    const common = {
        state_topic: topics.deviceState(info.device),
        availability,
        availability_mode: "all",
        device,
        origin,
    };

    const add = (component: string, objectId: string, config: Record<string, unknown>) => {
        messages.push({
            topic: `${DISCOVERY_PREFIX}/${component}/${uidBase}/${objectId}/config`,
            payload: JSON.stringify(config),
        });
    };

    for (const endpoint of endpoints) {
        const caps = capsOf(endpoint);
        const keys = endpointPropertyKeysOf(attributes, endpoint, caps);
        const suffixed = nameOf(endpoint, "state") !== "state";
        const entityName = (base: string) => (suffixed ? `${base} ${endpoint}` : base);

        if (caps.onOff && caps.brightness) {
            const colorModes: string[] = [];
            if (caps.hueSaturation) {
                colorModes.push("hs");
            }
            if (caps.xy) {
                colorModes.push("xy");
            }
            if (caps.colorTemp) {
                colorModes.push("color_temp");
            }
            // Known limit: HA's JSON light schema reads fixed property names, so a device with
            // several light endpoints (suffixed state_N keys) shows commands only; single-light
            // devices (the norm) work fully.
            add("light", suffixed ? `light_${endpoint}` : "light", {
                ...common,
                schema: "json",
                name: entityName("Light"),
                unique_id: `${uidBase}_light_${endpoint}`,
                command_topic: suffixed
                    ? `${topics.deviceState(info.device, endpoint)}/set`
                    : `${topics.deviceState(info.device)}/set`,
                brightness: true,
                brightness_scale: 254,
                ...(colorModes.length > 0 ? { supported_color_modes: colorModes } : {}),
                ...(caps.colorTemp
                    ? {
                          min_mireds: caps.colorTempMinMireds ?? 153,
                          max_mireds: caps.colorTempMaxMireds ?? 500,
                      }
                    : {}),
            });
        } else if (caps.onOff) {
            const key = nameOf(endpoint, "state");
            add("switch", suffixed ? `switch_${endpoint}` : "switch", {
                ...common,
                name: entityName("Switch"),
                unique_id: `${uidBase}_switch_${endpoint}`,
                command_topic: suffixed
                    ? `${topics.deviceState(info.device, endpoint)}/set`
                    : `${topics.deviceState(info.device)}/set`,
                value_template: `{{ value_json.${key} }}`,
                payload_on: '{"state":"ON"}',
                payload_off: '{"state":"OFF"}',
                state_on: "ON",
                state_off: "OFF",
            });
        }

        const sensors = sensorPresenceOf(attributes, endpoint);
        const objectId = (base: string) =>
            keys.includes(base) && nameOf(endpoint, base) !== base ? `${base}_${endpoint}` : base;
        if (sensors.occupancy) {
            const key = nameOf(endpoint, "occupancy");
            add("binary_sensor", objectId("occupancy"), {
                ...common,
                name: entityName("Occupancy"),
                unique_id: `${uidBase}_occupancy_${endpoint}`,
                device_class: "motion",
                value_template: `{{ value_json.${key} }}`,
                payload_on: true,
                payload_off: false,
            });
        }
        if (sensors.contact) {
            const key = nameOf(endpoint, "contact");
            // zigbee2mqtt semantics: contact true = closed; HA door class: on = open
            add("binary_sensor", objectId("contact"), {
                ...common,
                name: entityName("Contact"),
                unique_id: `${uidBase}_contact_${endpoint}`,
                device_class: "door",
                value_template: `{{ value_json.${key} }}`,
                payload_on: false,
                payload_off: true,
            });
        }
        if (sensors.illuminance) {
            const key = nameOf(endpoint, "illuminance");
            add("sensor", objectId("illuminance"), {
                ...common,
                name: entityName("Illuminance"),
                unique_id: `${uidBase}_illuminance_${endpoint}`,
                device_class: "illuminance",
                unit_of_measurement: "lx",
                state_class: "measurement",
                value_template: `{{ value_json.${key} }}`,
            });
        }
        if (sensors.temperature) {
            const key = nameOf(endpoint, "temperature");
            add("sensor", objectId("temperature"), {
                ...common,
                name: entityName("Temperature"),
                unique_id: `${uidBase}_temperature_${endpoint}`,
                device_class: "temperature",
                unit_of_measurement: "°C",
                state_class: "measurement",
                value_template: `{{ value_json.${key} }}`,
            });
        }
        if (sensors.humidity) {
            const key = nameOf(endpoint, "humidity");
            add("sensor", objectId("humidity"), {
                ...common,
                name: entityName("Humidity"),
                unique_id: `${uidBase}_humidity_${endpoint}`,
                device_class: "humidity",
                unit_of_measurement: "%",
                state_class: "measurement",
                value_template: `{{ value_json.${key} }}`,
            });
        }
    }

    // Device-level battery (first PowerSource occurrence)
    for (const path of Object.keys(attributes)) {
        const [, cluster, attribute] = path.split("/").map(Number);
        if (cluster === 47 && attribute === 12) {
            add("sensor", "battery", {
                ...common,
                name: "Battery",
                unique_id: `${uidBase}_battery`,
                device_class: "battery",
                unit_of_measurement: "%",
                state_class: "measurement",
                entity_category: "diagnostic",
                value_template: "{{ value_json.battery }}",
            });
            break;
        }
    }

    return messages;
}
