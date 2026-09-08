/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    ConfigStorage,
    toBigIntAwareJson,
    type AttributesData,
    type ControllerCommandHandler,
    type MatterNodeData,
} from "@matter-server/ws-controller";
import { Logger, NodeId, ObserverGroup } from "@matter/main";
import { ClusterId, EndpointNumber } from "@matter/main/types";
import {
    CREDENTIAL_COMMAND_NAMES,
    DEFAULT_COMMISSION_MODE,
    executeBridgeCommand,
    OTA_COMMAND_NAMES,
    type BridgeCommandContext,
} from "./BridgeCommands.js";
import { deviceStateOf, isDeviceLevelStateAttribute, isStateAttribute, relevantEndpointsOf } from "./DeviceState.js";
import { bridgeDiscoveryMessagesOf, discoveryMessagesOf } from "./Discovery.js";
import { lightCapabilitiesOf } from "./LightCapabilities.js";
import { MqttConnection } from "./MqttConnection.js";
import { onOffEndpointsOf, onOffValueOf } from "./OnOffState.js";
import { OtaTracker, supportsOta } from "./OtaState.js";
import { messageOf, parseSetObject, splitByEndpointSuffix } from "./SetCommands.js";
import { Topics } from "./Topics.js";

const logger = Logger.get("MqttBridge");

/** zigbee2mqtt-style bridge state payload: `{"state":"online"}`. */
function bridgeStatePayload(state: "online" | "offline"): string {
    return JSON.stringify({ state });
}

/** Shown on the HA bridge card in place of stored secrets. */
const SECRET_MASK = "********";

/** How often the bridge asks for firmware updates (zigbee2mqtt's default check interval). */
const OTA_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Delay before the first pass, keeping startup and commissioning traffic clear. */
const OTA_CHECK_START_DELAY_MS = 30 * 1000;
/** Gap between nodes, so a pass does not burst DCL queries. */
const OTA_CHECK_NODE_GAP_MS = 5 * 1000;

export interface MqttBridgeOptions {
    /** Broker URL, e.g. `mqtt://user:password@localhost:1883`. */
    url: string;
    /** Topic prefix. Default: `matter2mqtt`. */
    prefix?: string;
    /** MQTT client id. Default: `matter2mqtt`. */
    clientId?: string;
    /** Server version, published in `bridge/info`. */
    serverVersion?: string;
}

interface DeviceEntry {
    nodeId: NodeId;
    onOffEndpoints: number[];
    /** Endpoints contributing properties to the published device state. */
    relevantEndpoints: number[];
    /** Retained HA discovery topics published for this device, for cleanup on removal. */
    discoveryTopics: string[];
}

/**
 * MQTT bridge (matter2mqtt): publishes Matter device state to an MQTT broker and routes
 * inbound MQTT commands to the {@link ControllerCommandHandler}, following a
 * zigbee2mqtt-style topic layout (see package README).
 *
 * The bridge is an additional consumer of the controller's shared event hub, alongside
 * the WebSocket handler; it never blocks or alters existing server functionality.
 */
export class MqttBridge {
    readonly #commandHandler: ControllerCommandHandler;
    readonly #commandContext?: BridgeCommandContext;
    readonly #topics: Topics;
    readonly #connection: MqttConnection;
    readonly #serverVersion?: string;
    readonly #observers = new ObserverGroup();
    readonly #ota = new OtaTracker();
    /** Known devices keyed by node id string (the `<device>` topic segment). */
    readonly #devices = new Map<string, DeviceEntry>();
    #started = false;
    /** True once the initial publish has run; gates re-publishing from reconnect events. */
    #ready = false;
    #otaCheckTimer?: ReturnType<typeof setTimeout>;

    constructor(
        commandHandler: ControllerCommandHandler,
        options: MqttBridgeOptions,
        commandContext?: Omit<BridgeCommandContext, "commandHandler">,
    ) {
        this.#commandHandler = commandHandler;
        this.#commandContext =
            commandContext === undefined ? undefined : { ...commandContext, commandHandler, ota: this.#ota };
        this.#serverVersion = options.serverVersion;
        this.#topics = new Topics(options.prefix ?? "matter2mqtt");
        this.#connection = new MqttConnection({
            url: options.url,
            clientId: options.clientId ?? "matter2mqtt",
            will: { topic: this.#topics.bridgeState, payload: bridgeStatePayload("offline") },
        });
    }

    async start(): Promise<void> {
        if (this.#started) {
            return;
        }
        this.#started = true;

        this.#connection.connect(
            (topic, payload) => this.#handleMessage(topic, payload),
            // Re-publish everything on every (re)connect: a broker restart published our last
            // will (bridge offline) and may have lost retained state. Guarded until the initial
            // publish below has run, which needs the started command handler.
            () => {
                if (this.#ready) {
                    this.#publishAll();
                }
            },
        );
        this.#connection.subscribe(this.#topics.commandFilters);

        // The Matter stack is otherwise only started once a WebSocket client connects
        await this.#commandHandler.start();

        const { events } = this.#commandHandler;

        // Shared Observables: an uncaught throw would abort the emit and starve other consumers
        this.#observers.on(events.attributeChanged, (nodeId, data) => {
            try {
                this.#handleAttributeChanged(nodeId, data.path, data.value);
            } catch (error) {
                logger.warn(`Failed to publish attribute change for node ${nodeId}:`, error);
            }
        });
        this.#observers.on(events.nodeAdded, nodeId => {
            try {
                this.#refreshDevice(nodeId);
                this.#publishDevices();
            } catch (error) {
                logger.warn(`Failed to publish added node ${nodeId}:`, error);
            }
        });
        this.#observers.on(events.nodeStructureChanged, nodeId => {
            try {
                this.#refreshDevice(nodeId);
                this.#publishDevices();
            } catch (error) {
                logger.warn(`Failed to publish structure change for node ${nodeId}:`, error);
            }
        });
        this.#observers.on(events.nodeAvailabilityChanged, (nodeId, available) => {
            try {
                this.#connection.publish(
                    this.#topics.deviceAvailability(nodeId.toString()),
                    available ? "online" : "offline",
                    true,
                );
                this.#publishDevices();
            } catch (error) {
                logger.warn(`Failed to publish availability for node ${nodeId}:`, error);
            }
        });
        this.#observers.on(events.nodeDecommissioned, nodeId => {
            try {
                this.#removeDevice(nodeId.toString());
                this.#publishDevices();
            } catch (error) {
                logger.warn(`Failed to clear topics for removed node ${nodeId}:`, error);
            }
        });

        this.#ready = true;
        this.#publishAll();
        this.#scheduleOtaCheck(OTA_CHECK_START_DELAY_MS);
        // Fresh process: reset the commissioning feedback of the HA bridge card.
        // The cleared code is a space: an empty retained payload would be dropped.
        this.#connection.publish(this.#topics.bridgeCommissionStatus, "idle", true);
        this.#connection.publish(this.#topics.bridgeCommissionCode, " ", true);

        logger.notice(`MQTT bridge started with prefix "${this.#topics.prefix}"`);
    }

    async stop(): Promise<void> {
        if (!this.#started) {
            return;
        }
        this.#started = false;
        this.#ready = false;
        if (this.#otaCheckTimer !== undefined) {
            clearTimeout(this.#otaCheckTimer);
            this.#otaCheckTimer = undefined;
        }
        this.#observers.close();
        await this.#connection.close({ topic: this.#topics.bridgeState, payload: bridgeStatePayload("offline") });
    }

    #handleAttributeChanged(
        nodeId: NodeId,
        path: { endpointId: number; clusterId: number; attributeId: number },
        _value: unknown,
    ): void {
        if (!isStateAttribute(path.clusterId, path.attributeId)) {
            return;
        }
        const device = nodeId.toString();
        let entry = this.#devices.get(device);
        const endpointKnown =
            entry !== undefined &&
            (isDeviceLevelStateAttribute(path.clusterId, path.attributeId) ||
                entry.relevantEndpoints.includes(path.endpointId));
        if (!endpointKnown) {
            // Unknown device or endpoint: the structure changed ahead of any structure event
            entry = this.#refreshDevice(nodeId);
            this.#publishDevices();
        }
        if (entry === undefined) {
            return;
        }
        this.#publishDeviceState(entry);
    }

    #handleMessage(topic: string, payload: string): void {
        const bridgeCommand = this.#topics.parseBridgeRequest(topic);
        if (bridgeCommand !== undefined) {
            void this.#handleBridgeRequest(bridgeCommand, payload);
            return;
        }
        const parsed = this.#topics.parseInbound(topic);
        if (parsed === undefined) {
            return;
        }
        const entry = this.#devices.get(parsed.device);
        if (entry === undefined) {
            logger.warn(`Ignoring command for unknown device "${parsed.device}"`);
            return;
        }
        if (parsed.kind === "get") {
            this.#handleGet(entry, parsed.endpoint);
            return;
        }
        const endpoint = parsed.endpoint ?? entry.onOffEndpoints[0];
        if (endpoint === undefined || !entry.onOffEndpoints.includes(endpoint)) {
            logger.warn(`Device "${parsed.device}" has no OnOff support on endpoint ${endpoint ?? "(none)"}`);
            return;
        }

        let attributes;
        try {
            attributes = this.#commandHandler.getNodeDetails(entry.nodeId).attributes;
        } catch {
            logger.warn(`Cannot resolve capabilities for "${parsed.device}"`);
            return;
        }
        const message = messageOf(payload, parsed.attribute);
        if (message === undefined) {
            logger.warn(`Ignoring unsupported set payload for "${parsed.device}": ${payload}`);
            return;
        }
        for (const [targetEndpoint, subMessage] of splitByEndpointSuffix(message, entry.onOffEndpoints, endpoint)) {
            const caps = lightCapabilitiesOf(attributes, targetEndpoint);
            const result = parseSetObject(subMessage, caps, onOffValueOf(attributes, targetEndpoint));
            if (result === undefined) {
                continue;
            }
            for (const warning of result.warnings) {
                logger.warn(`Set for "${parsed.device}": ${warning}`);
            }
            void this.#runCommands(entry, targetEndpoint, result.commands);
        }
    }

    /** Execute parsed set commands in order; a failing command is logged and does not stop the rest. */
    async #runCommands(
        entry: DeviceEntry,
        endpoint: number,
        commands: { clusterId: number; commandName: string; data: Record<string, unknown> }[],
    ): Promise<void> {
        const node = this.#commandHandler.formatNode(entry.nodeId);
        for (const command of commands) {
            logger.info(`MQTT command for node ${node}/${endpoint}: ${command.commandName}`);
            try {
                await this.#commandHandler.handleInvoke({
                    nodeId: entry.nodeId,
                    endpointId: EndpointNumber(endpoint),
                    clusterId: ClusterId(command.clusterId),
                    commandName: command.commandName,
                    data: command.data,
                });
            } catch (error) {
                logger.warn(`Command "${command.commandName}" failed for node ${node}:`, error);
            }
        }
    }

    /** Run a bridge/request command and answer on bridge/response (not retained). */
    async #handleBridgeRequest(command: string, payload: string): Promise<void> {
        if (this.#commandContext === undefined) {
            this.#connection.publish(
                this.#topics.bridgeResponse(command),
                JSON.stringify({ status: "error", error: "bridge commands are not available" }),
            );
            return;
        }
        logger.info(`Bridge command "${command}" requested`);
        if (command === "commission") {
            // Progress feedback for the HA bridge card; also clear the code input
            this.#connection.publish(this.#topics.bridgeCommissionStatus, "commissioning...", true);
            this.#connection.publish(this.#topics.bridgeCommissionCode, " ", true);
        }
        const response = await executeBridgeCommand(command, payload, this.#commandContext);
        this.#connection.publish(this.#topics.bridgeResponse(command), JSON.stringify(response));
        if (CREDENTIAL_COMMAND_NAMES.includes(command)) {
            // Also on error: resets the HA text entities back to the stored truth
            this.#publishCredentialState();
        }
        if (command === "commission_mode") {
            this.#publishCommissionMode();
        }
        if (OTA_COMMAND_NAMES.includes(command)) {
            // The check result and the requested-update flag only live in the bridge, so the
            // device's `update` property has to be re-published explicitly
            this.#publishDeviceStateOf((response.data as { id?: unknown })?.id);
        }
        if (command === "commission") {
            const summary =
                response.status === "ok"
                    ? `ok: node ${(response.data as { node_id?: number })?.node_id}`
                    : `error: ${response.error}`;
            this.#connection.publish(this.#topics.bridgeCommissionStatus, summary, true);
        }
        if (response.status === "ok") {
            logger.info(`Bridge command "${command}" succeeded`);
        }
    }

    /** zigbee2mqtt-style `get`: re-publish the full current state from the attribute cache. */
    #handleGet(entry: DeviceEntry, _endpoint?: number): void {
        this.#publishDeviceState(entry);
    }

    /**
     * The controller learns about firmware updates from its own DCL poll but does not expose that,
     * so the bridge has to ask per node for the `update` property to ever leave `idle`. Chained
     * timeouts rather than an interval: a slow pass can never overlap the next one.
     */
    #scheduleOtaCheck(delay: number): void {
        if (this.#commandContext === undefined) {
            return;
        }
        this.#otaCheckTimer = setTimeout(() => {
            void this.#runOtaCheckPass().finally(() => {
                if (this.#started) {
                    this.#scheduleOtaCheck(OTA_CHECK_INTERVAL_MS);
                }
            });
        }, delay);
        // Never hold up shutdown
        this.#otaCheckTimer.unref?.();
    }

    async #runOtaCheckPass(): Promise<void> {
        for (const [device, entry] of [...this.#devices]) {
            if (!this.#started) {
                return;
            }
            let details: MatterNodeData;
            try {
                details = this.#commandHandler.getNodeDetails(entry.nodeId);
            } catch {
                continue;
            }
            // An unreachable node cannot be updated anyway, and a running check owns the node
            if (!details.available || !supportsOta(details.attributes) || !this.#ota.begin(device)) {
                continue;
            }
            try {
                const update = await this.#commandHandler.checkNodeUpdate(entry.nodeId);
                if (update !== null) {
                    logger.notice(`Firmware ${update.software_version_string} available for node ${device}`);
                }
                this.#ota.setAvailableUpdate(device, update);
            } catch (error) {
                logger.info(`Firmware check for node ${device} failed:`, error);
            } finally {
                this.#ota.end(device);
            }
            this.#publishDeviceState(entry);
            await new Promise(resolve => setTimeout(resolve, OTA_CHECK_NODE_GAP_MS).unref?.());
        }
    }

    /** Re-publish one device's state, addressed the way a bridge command response identifies it. */
    #publishDeviceStateOf(id: unknown): void {
        const device = deviceKeyOf(id);
        const entry = device === undefined ? undefined : this.#devices.get(device);
        if (entry !== undefined) {
            this.#publishDeviceState(entry);
        }
    }

    /** Publish the complete retained picture: all devices, device list, info and online state. */
    #publishAll(): void {
        for (const message of bridgeDiscoveryMessagesOf(this.#serverVersion, this.#topics)) {
            this.#connection.publish(message.topic, message.payload, true);
        }
        for (const nodeId of this.#commandHandler.getNodeIds()) {
            try {
                this.#refreshDevice(nodeId);
            } catch (error) {
                logger.warn(`Failed to publish state for node ${nodeId}:`, error);
            }
        }
        this.#publishDevices();
        this.#publishBridgeInfo();
        this.#publishCredentialState();
        this.#publishCommissionMode();
        this.#connection.publish(this.#topics.bridgeState, bridgeStatePayload("online"), true);
    }

    /** Retained mode of the HA commission select; a fresh process starts back at Auto. */
    #publishCommissionMode(): void {
        if (this.#commandContext === undefined) {
            return;
        }
        const mode = this.#commandContext.commissionMode ?? DEFAULT_COMMISSION_MODE;
        this.#connection.publish(this.#topics.bridgeCommissionMode, mode, true);
    }

    /** Retained credential feedback for the HA bridge card; secrets only ever appear masked. */
    #publishCredentialState(): void {
        const context = this.#commandContext;
        if (context === undefined) {
            return;
        }
        const wifi = context.config.getWifiCredentials(ConfigStorage.DEFAULT_CREDENTIAL_ID);
        const thread = context.config.getThreadCredentials(ConfigStorage.DEFAULT_CREDENTIAL_ID);
        const ssid = context.wifiInput?.ssid ?? wifi?.ssid ?? "";
        const password = context.wifiInput?.password ?? wifi?.credentials ?? "";
        this.#connection.publish(this.#topics.bridgeWifiSsid, ssid, true);
        this.#connection.publish(this.#topics.bridgeWifiPassword, password.length > 0 ? SECRET_MASK : "", true);
        this.#connection.publish(this.#topics.bridgeThreadDataset, thread?.dataset ? SECRET_MASK : "", true);
    }

    /** Publish the merged zigbee2mqtt-style device state to the single `<node>` topic. */
    #publishDeviceState(entry: DeviceEntry): void {
        const device = entry.nodeId.toString();
        let details: MatterNodeData;
        try {
            details = this.#commandHandler.getNodeDetails(entry.nodeId);
        } catch {
            logger.warn(`Cannot read state for "${device}"`);
            return;
        }
        const state = deviceStateOf(details.attributes, entry.relevantEndpoints, endpoint =>
            lightCapabilitiesOf(details.attributes, endpoint),
        );
        const update = this.#ota.updateStateOf(device, details.attributes);
        if (update !== undefined) {
            state.update = update;
        }
        if (Object.keys(state).length === 0) {
            return;
        }
        this.#connection.publish(this.#topics.deviceState(device), JSON.stringify(state), true);
    }

    /**
     * (Re-)sync a device from the controller's attribute cache: track its OnOff endpoints
     * and publish availability and current state. Returns undefined if the node is gone.
     */
    #refreshDevice(nodeId: NodeId): DeviceEntry | undefined {
        const device = nodeId.toString();

        let details: MatterNodeData;
        try {
            details = this.#commandHandler.getNodeDetails(nodeId);
        } catch {
            this.#removeDevice(device);
            return undefined;
        }

        const onOffEndpoints = onOffEndpointsOf(details.attributes);
        const relevantEndpoints = relevantEndpointsOf(details.attributes);
        const previous = this.#devices.get(device);
        const entry: DeviceEntry = { nodeId, onOffEndpoints, relevantEndpoints, discoveryTopics: [] };
        this.#devices.set(device, entry);

        // Migration/cleanup: state now lives on the single `<node>` topic; clear any retained
        // per-endpoint state topics from earlier layouts
        for (const endpoint of new Set([...relevantEndpoints, ...(previous?.relevantEndpoints ?? [])])) {
            this.#connection.clearRetained(this.#topics.deviceState(device, endpoint));
        }

        this.#publishDiscovery(entry, details, previous?.discoveryTopics ?? []);
        this.#connection.publish(
            this.#topics.deviceAvailability(device),
            details.available ? "online" : "offline",
            true,
        );
        this.#publishDeviceState(entry);
        return entry;
    }

    /** Publish retained HA discovery for the device; clear topics that disappeared. */
    #publishDiscovery(entry: DeviceEntry, details: MatterNodeData, previousTopics: string[]): void {
        const device = entry.nodeId.toString();
        const { attributes } = details;
        const messages = discoveryMessagesOf(
            {
                device,
                vendorName: stringAttribute(attributes, "0/40/1"),
                productName: stringAttribute(attributes, "0/40/3"),
                serialNumber: stringAttribute(attributes, "0/40/15"),
                serverVersion: this.#serverVersion,
            },
            attributes,
            entry.relevantEndpoints,
            endpoint => lightCapabilitiesOf(attributes, endpoint),
            this.#topics,
        );
        entry.discoveryTopics = messages.map(m => m.topic);
        for (const stale of previousTopics.filter(topic => !entry.discoveryTopics.includes(topic))) {
            this.#connection.clearRetained(stale);
        }
        for (const message of messages) {
            this.#connection.publish(message.topic, message.payload, true);
        }
    }

    #removeDevice(device: string): void {
        const entry = this.#devices.get(device);
        if (entry === undefined) {
            return;
        }
        this.#devices.delete(device);
        this.#ota.forget(device);
        for (const topic of entry.discoveryTopics) {
            this.#connection.clearRetained(topic);
        }
        this.#connection.clearRetained(this.#topics.deviceState(device));
        for (const endpoint of entry.relevantEndpoints) {
            this.#connection.clearRetained(this.#topics.deviceState(device, endpoint));
        }
        this.#connection.clearRetained(this.#topics.deviceAvailability(device));
    }

    #publishDevices(): void {
        const devices = this.#commandHandler.getNodeIds().map(nodeId => {
            const details = this.#commandHandler.getNodeDetails(nodeId);
            const { attributes } = details;
            return {
                id: nodeId.toString(),
                node_id: details.node_id,
                available: details.available,
                is_bridge: details.is_bridge,
                vendor_name: stringAttribute(attributes, "0/40/1"),
                product_name: stringAttribute(attributes, "0/40/3"),
                node_label: stringAttribute(attributes, "0/40/5"),
                serial_number: stringAttribute(attributes, "0/40/15"),
                unique_id: stringAttribute(attributes, "0/40/18"),
                onoff_endpoints: this.#devices.get(nodeId.toString())?.onOffEndpoints ?? [],
            };
        });
        this.#connection.publish(this.#topics.bridgeDevices, toBigIntAwareJson(devices), true);
    }

    #publishBridgeInfo(): void {
        this.#connection.publish(
            this.#topics.bridgeInfo,
            JSON.stringify({
                version: this.#serverVersion,
                ble_enabled: this.#commandHandler.bleEnabled,
                ble_proxy_enabled: this.#commandHandler.bleProxyEnabled,
                prefix: this.#topics.prefix,
            }),
            true,
        );
    }
}

function stringAttribute(attributes: AttributesData, path: string): string | undefined {
    const value = attributes[path];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** The `<device>` topic segment for a node id as it appears in a bridge command response. */
function deviceKeyOf(id: unknown): string | undefined {
    if (typeof id !== "bigint" && typeof id !== "number" && typeof id !== "string") {
        return undefined;
    }
    try {
        return BigInt(id).toString();
    } catch {
        return undefined;
    }
}
