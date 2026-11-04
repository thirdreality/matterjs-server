/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AttributesData } from "@matter-server/ws-controller";
import { COMMISSION_MODE_NAMES } from "./BridgeCommands.js";
import { controlsOf, hasIdentify, IDENTIFY_EFFECTS } from "./Controls.js";
import { endpointPropertyKeysOf, propertyNameResolver } from "./DeviceState.js";
import { deviceActionsOf } from "./Events.js";
import type { LightCapabilities } from "./LightCapabilities.js";
import { supportsOta } from "./OtaState.js";
import { DEVICE_SENSORS, deviceSensorEndpointOf, ENDPOINT_SENSORS, type SensorEntity } from "./Sensors.js";
import { DISCOVERY_PREFIX, type Topics } from "./Topics.js";

export interface DiscoveryDeviceInfo {
    /** Node id string, the `<device>` topic segment and unique-id base. */
    device: string;
    vendorName?: string;
    productName?: string;
    serialNumber?: string;
    /** Server version, reported as the discovery origin. */
    serverVersion?: string;
    /** Device name; defaults to the product name. */
    name?: string;
    /** Home Assistant identifier of the device this one is reached through (its Matter bridge). */
    viaDevice?: string;
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
        // Entity creation order shapes HA's auto-generated device card: sensors first,
        // configuration in the middle, restart last
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
            topic: `${DISCOVERY_PREFIX}/sensor/matter2mqtt_bridge/commissioned_nodes/config`,
            payload: JSON.stringify({
                name: "Commissioned nodes",
                unique_id: "matter2mqtt_bridge_commissioned_nodes",
                state_topic: topics.bridgeDevices,
                value_template: "{{ value_json | length }}",
                icon: "mdi:devices",
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
                entity_category: "config",
                availability: [{ topic: topics.bridgeState, value_template: "{{ value_json.state }}" }],
                device,
                origin,
            }),
        },
        {
            // Paste a pairing code to commission following the selected mode; result on
            // bridge/response/commission and, human-readable, on the status sensor.
            // The cleared state is a single space (an empty retained payload would be
            // dropped by the broker, leaving the entity "unknown"), trimmed back here.
            topic: `${DISCOVERY_PREFIX}/text/matter2mqtt_bridge/commission_code/config`,
            payload: JSON.stringify({
                name: "Commission code",
                unique_id: "matter2mqtt_bridge_commission_code",
                command_topic: `${topics.prefix}/bridge/request/commission`,
                command_template: '{"code":"{{ value }}"}',
                state_topic: topics.bridgeCommissionCode,
                value_template: "{{ value | trim }}",
                entity_category: "config",
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
        name: info.name ?? info.productName ?? `Matter node ${info.device}`,
        manufacturer: info.vendorName,
        model: info.productName,
        serial_number: info.serialNumber,
        ...(info.viaDevice === undefined ? {} : { via_device: info.viaDevice }),
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
                ...(hasIdentify(attributes, endpoint)
                    ? { effect: true, effect_list: Object.keys(IDENTIFY_EFFECTS) }
                    : {}),
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

        for (const control of controlsOf(attributes, endpoint)) {
            const numbered = nameOf(endpoint, control.primaryKey) !== control.primaryKey;
            const entities = control.discovery(attributes, endpoint, {
                nameOf: key => nameOf(endpoint, key),
                commandTopic: numbered
                    ? `${topics.deviceState(info.device, endpoint)}/set`
                    : `${topics.deviceState(info.device)}/set`,
                entityName: base => (numbered ? `${base} ${endpoint}` : base),
            });
            for (const { component, objectId, config } of entities) {
                add(component, numbered ? `${objectId}_${endpoint}` : objectId, {
                    ...common,
                    ...config,
                    unique_id: `${uidBase}_${objectId}_${endpoint}`,
                });
            }
        }

        const objectId = (base: string) =>
            keys.includes(base) && nameOf(endpoint, base) !== base ? `${base}_${endpoint}` : base;
        for (const sensor of ENDPOINT_SENSORS) {
            if (!sensor.present(attributes, endpoint)) {
                continue;
            }
            const { component, name, ...entity } = sensor.entity(attributes, endpoint);
            add(component, objectId(sensor.key), {
                ...common,
                ...entityConfig(entity, nameOf(endpoint, sensor.key)),
                name: entityName(name),
                unique_id: `${uidBase}_${sensor.key}_${endpoint}`,
            });
        }
    }

    // Buttons: one event entity with every action, plus a device trigger per action for automations
    const actions = deviceActionsOf(attributes);
    if (actions.length > 0) {
        const actionTopic = topics.deviceAction(info.device);
        add("event", "action", {
            name: "Action",
            unique_id: `${uidBase}_action`,
            state_topic: actionTopic,
            value_template: '{ "event_type": "{{ value }}" }',
            event_types: actions,
            availability,
            availability_mode: "all",
            device,
            origin,
        });
        for (const action of actions) {
            add("device_automation", `action_${action}`, {
                automation_type: "trigger",
                type: "action",
                subtype: action,
                payload: action,
                topic: actionTopic,
                device,
                origin,
            });
        }
    }

    // Device-level firmware update entity, for nodes exposing the OTA Requestor cluster.
    // The versions are published as strings and piped through tojson so an unknown version stays
    // JSON null instead of Jinja's "None".
    if (supportsOta(attributes)) {
        add("update", "update", {
            ...common,
            name: "Firmware",
            unique_id: `${uidBase}_update`,
            device_class: "firmware",
            entity_category: "config",
            command_topic: `${topics.prefix}/bridge/request/device/ota_update/update`,
            payload_install: JSON.stringify({ id: info.device }),
            value_template:
                `{"installed_version":{{ value_json['update']['installed_version_string'] | tojson }},` +
                `"latest_version":{{ value_json['update']['latest_version_string'] | tojson }},` +
                `"update_percentage":{{ value_json['update'].get('progress', 'null') }},` +
                `"in_progress":{{ (value_json['update']['state'] == 'updating') | lower }},` +
                `"release_url":{{ value_json['update']['latest_release_notes'] | tojson }}}`,
        });
    }

    const endpointKeys = new Set(
        endpoints.flatMap(endpoint => endpointPropertyKeysOf(attributes, endpoint, capsOf(endpoint))),
    );
    for (const sensor of DEVICE_SENSORS) {
        const endpoint = deviceSensorEndpointOf(attributes, sensor);
        if (endpoint === undefined || endpointKeys.has(sensor.key)) {
            continue;
        }
        const { component, name, ...entity } = sensor.entity(attributes, endpoint);
        add(component, sensor.key, {
            ...common,
            ...entityConfig(entity, sensor.key),
            name,
            unique_id: `${uidBase}_${sensor.key}`,
        });
    }

    return messages;
}

/** Discovery fields of a sensor entity reading the published property `key`. */
function entityConfig(entity: Omit<SensorEntity, "component" | "name">, key: string): Record<string, unknown> {
    const { payload_on, ...rest } = entity;
    return {
        ...rest,
        value_template: `{{ value_json.${key} }}`,
        ...(payload_on === undefined ? {} : { payload_on, payload_off: !payload_on }),
    };
}
