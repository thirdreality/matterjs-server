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
import { AttributeId, ClusterId, EndpointNumber } from "@matter/main/types";
import {
    CREDENTIAL_COMMAND_NAMES,
    DEFAULT_COMMISSION_MODE,
    executeBridgeCommand,
    OTA_COMMAND_NAMES,
    type BridgeCommandContext,
    type ResolvedDevice,
} from "./BridgeCommands.js";
import {
    BRIDGED_BASIC_INFORMATION_CLUSTER_ID,
    BRIDGED_REACHABLE_ATTRIBUTE_ID,
    bridgedDeviceKey,
    bridgedDevicesOf,
    scopedAttributes,
} from "./BridgedDevices.js";
import { controllableEndpointsOf, isDeviceWrite, parseEndpointSet, type DeviceAction } from "./Controls.js";
import { deviceStateOf, isDeviceLevelStateAttribute, isStateAttribute, relevantEndpointsOf } from "./DeviceState.js";
import { bridgeDiscoveryMessagesOf, discoveryMessagesOf } from "./Discovery.js";
import { SWITCH_CLUSTER_ID, switchActionOf } from "./Events.js";
import { deviceDescriptionOf } from "./Exposes.js";
import { lightCapabilitiesOf } from "./LightCapabilities.js";
import { MqttConnection, type BridgeConnection } from "./MqttConnection.js";
import { onOffEndpointsOf } from "./OnOffState.js";
import { OtaTracker, supportsOta } from "./OtaState.js";
import { messageOf, splitByEndpointSuffix } from "./SetCommands.js";
import { staleRetainedReason } from "./StaleTopics.js";
import { DISCOVERY_PREFIX, Topics } from "./Topics.js";

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
    /** Add a `last_seen` timestamp to device states (zigbee2mqtt's `advanced.last_seen`, off by default). */
    lastSeen?: boolean;
    /** Broker connection to use instead of one to `url`, for tests. */
    connection?: BridgeConnection;
}

interface DeviceEntry {
    /** The `<device>` topic segment: the node id, or `<node>_<endpoint>` for a device behind a Matter bridge. */
    key: string;
    nodeId: NodeId;
    /** For a device behind a Matter bridge: the endpoint carrying its BridgedDeviceBasicInformation. */
    bridgedEndpoint?: number;
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
    readonly #connection: BridgeConnection;
    readonly #serverVersion?: string;
    readonly #lastSeenEnabled: boolean;
    /** When each device was last heard from (any attribute report or event), by device key. */
    readonly #lastSeen = new Map<string, number>();
    readonly #observers = new ObserverGroup();
    readonly #ota = new OtaTracker();
    /** Discovery topics of the bridge's own entities, for telling ours from a previous version's. */
    #bridgeDiscoveryTopics = new Array<string>();
    /** Known devices keyed by their `<device>` topic segment. */
    readonly #devices = new Map<string, DeviceEntry>();
    /** Per node: the device key of every endpoint that belongs to a bridged device; others belong to the node. */
    readonly #owners = new Map<string, Map<number, string>>();
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
            commandContext === undefined
                ? undefined
                : {
                      ...commandContext,
                      commandHandler,
                      ota: this.#ota,
                      resolveDevice: device => this.#resolveDevice(device),
                  };
        this.#serverVersion = options.serverVersion;
        this.#lastSeenEnabled = options.lastSeen === true;
        this.#topics = new Topics(options.prefix ?? "matter2mqtt");
        this.#connection =
            options.connection ??
            new MqttConnection({
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
                this.#markSeen(nodeId, data.path.endpointId);
                this.#handleAttributeChanged(nodeId, data.path, data.value);
            } catch (error) {
                logger.warn(`Failed to publish attribute change for node ${nodeId}:`, error);
            }
        });
        this.#observers.on(events.eventChanged, (nodeId, data) => {
            try {
                this.#markSeen(nodeId, data.path.endpointId);
                this.#handleEvent(nodeId, data.path, data.events);
            } catch (error) {
                logger.warn(`Failed to publish event for node ${nodeId}:`, error);
            }
        });
        this.#observers.on(events.nodeAdded, nodeId => {
            try {
                this.#refreshDevice(nodeId, true);
                this.#publishDevices();
            } catch (error) {
                logger.warn(`Failed to publish added node ${nodeId}:`, error);
            }
        });
        this.#observers.on(events.nodeStructureChanged, nodeId => {
            try {
                this.#refreshDevice(nodeId, true);
                this.#publishDevices();
            } catch (error) {
                logger.warn(`Failed to publish structure change for node ${nodeId}:`, error);
            }
        });
        this.#observers.on(events.nodeAvailabilityChanged, nodeId => {
            try {
                for (const entry of this.#entriesOf(nodeId.toString())) {
                    this.#publishAvailability(entry);
                }
                this.#publishDevices();
            } catch (error) {
                logger.warn(`Failed to publish availability for node ${nodeId}:`, error);
            }
        });
        this.#observers.on(events.nodeDecommissioned, nodeId => {
            try {
                for (const key of this.#removeNode(nodeId.toString())) {
                    this.#publishBridgeEvent("device_leave", { friendly_name: key, id: key });
                }
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
        if (
            path.clusterId === BRIDGED_BASIC_INFORMATION_CLUSTER_ID &&
            path.attributeId === BRIDGED_REACHABLE_ATTRIBUTE_ID
        ) {
            const bridged = this.#entryOf(nodeId, path.endpointId);
            if (bridged !== undefined) {
                this.#publishAvailability(bridged);
                this.#publishDevices();
            }
            return;
        }
        if (!isStateAttribute(path.clusterId, path.attributeId)) {
            return;
        }
        let entry = this.#entryOf(nodeId, path.endpointId);
        const endpointKnown =
            entry !== undefined &&
            (isDeviceLevelStateAttribute(path.clusterId, path.attributeId) ||
                entry.relevantEndpoints.includes(path.endpointId));
        if (!endpointKnown) {
            // Unknown device or endpoint: the structure changed ahead of any structure event
            this.#refreshDevice(nodeId, true);
            this.#publishDevices();
            entry = this.#entryOf(nodeId, path.endpointId);
        }
        if (entry === undefined) {
            return;
        }
        this.#publishDeviceState(entry);
    }

    /** zigbee2mqtt-style `action` for button events, on the non-retained `<node>/action` topic. */
    #handleEvent(
        nodeId: NodeId,
        path: { endpointId: number; clusterId: number; eventId: number },
        occurrences: { data: unknown }[],
    ): void {
        if (path.clusterId !== SWITCH_CLUSTER_ID) {
            return;
        }
        const entry = this.#entryOf(nodeId, path.endpointId);
        if (entry === undefined) {
            return;
        }
        const attributes = this.#attributesOf(entry, this.#commandHandler.getNodeDetails(nodeId).attributes);
        for (const { data } of occurrences) {
            const action = switchActionOf(attributes, path.endpointId, path.eventId, data);
            if (action !== undefined) {
                logger.info(`Device ${entry.key} action: ${action}`);
                this.#connection.publish(this.#topics.deviceAction(entry.key), action, false);
            }
        }
    }

    #handleMessage(topic: string, payload: string): void {
        if (topic.startsWith(`${DISCOVERY_PREFIX}/`)) {
            this.#reconcileRetained(topic, payload);
            return;
        }
        const bridgeCommand = this.#topics.parseBridgeRequest(topic);
        if (bridgeCommand !== undefined) {
            void this.#handleBridgeRequest(bridgeCommand, payload);
            return;
        }
        const parsed = this.#topics.parseInbound(topic);
        if (parsed === undefined) {
            // Not a command: the only other thing we subscribe to is our own retained state
            this.#reconcileRetained(topic, payload);
            return;
        }
        const entry = this.#devices.get(parsed.device);
        if (entry === undefined) {
            logger.warn(`Ignoring command for unknown device "${parsed.device}"`);
            return;
        }
        if (parsed.kind === "get") {
            void this.#handleGet(entry);
            return;
        }
        let attributes;
        try {
            attributes = this.#attributesOf(entry, this.#commandHandler.getNodeDetails(entry.nodeId).attributes);
        } catch {
            logger.warn(`Cannot resolve capabilities for "${parsed.device}"`);
            return;
        }
        const controllable = controllableEndpointsOf(attributes);
        const endpoint = parsed.endpoint ?? controllable[0];
        if (endpoint === undefined || !controllable.includes(endpoint)) {
            logger.warn(`Device "${parsed.device}" has nothing to control on endpoint ${endpoint ?? "(none)"}`);
            return;
        }
        const message = messageOf(payload, parsed.attribute);
        if (message === undefined) {
            logger.warn(`Ignoring unsupported set payload for "${parsed.device}": ${payload}`);
            return;
        }
        for (const [targetEndpoint, subMessage] of splitByEndpointSuffix(message, controllable, endpoint)) {
            const result = parseEndpointSet(subMessage, attributes, targetEndpoint);
            if (result === undefined) {
                continue;
            }
            for (const warning of result.warnings) {
                logger.warn(`Set for "${parsed.device}": ${warning}`);
            }
            void this.#runActions(entry, targetEndpoint, result.actions);
        }
    }

    /** Execute parsed set actions in order; a failing action is logged and does not stop the rest. */
    async #runActions(entry: DeviceEntry, endpoint: number, actions: DeviceAction[]): Promise<void> {
        const node = this.#commandHandler.formatNode(entry.nodeId);
        for (const action of actions) {
            const label = isDeviceWrite(action)
                ? `write ${action.clusterId}/${action.attributeId}`
                : action.commandName;
            logger.info(`MQTT command for node ${node}/${endpoint}: ${label}`);
            try {
                if (isDeviceWrite(action)) {
                    await this.#commandHandler.handleWriteAttribute({
                        nodeId: entry.nodeId,
                        endpointId: EndpointNumber(endpoint),
                        clusterId: ClusterId(action.clusterId),
                        attributeId: AttributeId(action.attributeId),
                        value: action.value,
                    });
                } else {
                    await this.#commandHandler.handleInvoke({
                        nodeId: entry.nodeId,
                        endpointId: EndpointNumber(endpoint),
                        clusterId: ClusterId(action.clusterId),
                        commandName: action.commandName,
                        data: action.data,
                    });
                }
            } catch (error) {
                logger.warn(`"${label}" failed for node ${node}:`, error);
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
        const interviewed = command === "device/interview" ? deviceKeyOf(argsOf(payload).id) : undefined;
        if (interviewed !== undefined) {
            this.#publishBridgeEvent("device_interview", {
                friendly_name: interviewed,
                id: interviewed,
                status: "started",
            });
        }
        const response = await executeBridgeCommand(command, payload, this.#commandContext);
        if (interviewed !== undefined) {
            this.#publishInterviewResult(interviewed, response.status === "ok");
        }
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

    /**
     * zigbee2mqtt-style `get`: read the state attributes from the device, then publish. Reads are
     * requested for the paths the node is known to have, and their results overlay the cache for this
     * publish (a direct read does not update the subscription cache). An offline node, or a failing
     * read, falls back to re-publishing what the cache holds.
     */
    async #handleGet(entry: DeviceEntry): Promise<void> {
        const device = entry.key;
        let attributes: AttributesData;
        try {
            attributes = this.#attributesOf(entry, this.#commandHandler.getNodeDetails(entry.nodeId).attributes);
        } catch {
            logger.warn(`Cannot read state for "${device}"`);
            return;
        }
        const paths = Object.keys(attributes).filter(path => {
            const [, clusterId, attributeId] = path.split("/").map(Number);
            return clusterId !== undefined && attributeId !== undefined && isStateAttribute(clusterId, attributeId);
        });
        let fresh: AttributesData | undefined;
        if (paths.length > 0) {
            try {
                fresh = await this.#commandHandler.handleReadAttributes(entry.nodeId, paths);
            } catch (error) {
                logger.info(`Read for "${device}" failed, publishing the cached state:`, error);
            }
        }
        this.#publishDeviceState(entry, fresh);
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
            // Matter OTA updates nodes; what is behind a bridge is the bridge's own business
            if (entry.bridgedEndpoint !== undefined) {
                continue;
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
        this.#bridgeDiscoveryTopics = [];
        for (const message of bridgeDiscoveryMessagesOf(this.#serverVersion, this.#topics)) {
            this.#bridgeDiscoveryTopics.push(message.topic);
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
        // Subscribing last, with the full picture published, means the retained topics the broker
        // now replays can be judged against complete expectations. The subscription stays: every
        // reconnect replays them, so a broker that outlived several bridge versions keeps healing.
        this.#connection.subscribe(this.#topics.reconcileFilters);
    }

    /** Clear a retained topic of ours that should no longer exist. */
    #reconcileRetained(topic: string, payload: string): void {
        const reason = staleRetainedReason(topic, payload, {
            prefix: this.#topics.prefix,
            expectedDiscovery: new Set([
                ...this.#bridgeDiscoveryTopics,
                ...[...this.#devices.values()].flatMap(entry => entry.discoveryTopics),
            ]),
            knownDevices: new Set(this.#devices.keys()),
        });
        if (reason !== undefined) {
            logger.notice(`Clearing stale retained topic ${topic}: ${reason}`);
            this.#connection.clearRetained(topic);
        }
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

    /**
     * Publish the merged zigbee2mqtt-style device state to the device's single topic. `fresh` carries
     * values read directly from the device, which take precedence over the subscription cache.
     */
    #publishDeviceState(entry: DeviceEntry, fresh?: AttributesData): void {
        let details: MatterNodeData;
        try {
            details = this.#commandHandler.getNodeDetails(entry.nodeId);
        } catch {
            logger.warn(`Cannot read state for "${entry.key}"`);
            return;
        }
        const attributes = this.#attributesOf(
            entry,
            fresh === undefined ? details.attributes : { ...details.attributes, ...fresh },
        );
        const state = deviceStateOf(attributes, entry.relevantEndpoints, endpoint =>
            lightCapabilitiesOf(attributes, endpoint),
        );
        const update = this.#ota.updateStateOf(entry.key, attributes);
        if (update !== undefined) {
            state.update = update;
        }
        const seen = this.#lastSeen.get(entry.key);
        if (this.#lastSeenEnabled && seen !== undefined) {
            state.last_seen = new Date(seen).toISOString();
        }
        if (Object.keys(state).length === 0) {
            // Also clears what this topic held before, e.g. a bridge's state from before its devices were split off
            this.#connection.clearRetained(this.#topics.deviceState(entry.key));
            return;
        }
        this.#connection.publish(this.#topics.deviceState(entry.key), JSON.stringify(state), true);
    }

    #resolveDevice(device: string): ResolvedDevice | undefined {
        const entry = this.#devices.get(device);
        if (entry === undefined) {
            return undefined;
        }
        try {
            const { attributes } = this.#commandHandler.getNodeDetails(entry.nodeId);
            return {
                nodeId: entry.nodeId,
                attributes: this.#attributesOf(entry, attributes),
                nodeAttributes: attributes,
            };
        } catch {
            return undefined;
        }
    }

    #markSeen(nodeId: NodeId, endpoint: number): void {
        const node = nodeId.toString();
        this.#lastSeen.set(this.#owners.get(node)?.get(endpoint) ?? node, Date.now());
    }

    #publishBridgeEvent(type: string, data: Record<string, unknown>): void {
        this.#connection.publish(this.#topics.bridgeEvent, JSON.stringify({ type, data }));
    }

    #publishInterviewResult(key: string, successful: boolean): void {
        const description = successful ? this.#describe(key) : undefined;
        this.#publishBridgeEvent("device_interview", {
            friendly_name: key,
            id: key,
            status: successful ? "successful" : "failed",
            ...(description === undefined
                ? {}
                : { supported: description.supported, definition: description.definition }),
        });
    }

    /** The attributes of the device: a bridged device's endpoints, or its node without the bridged devices. */
    #attributesOf(entry: DeviceEntry, attributes: AttributesData): AttributesData {
        const owners = this.#owners.get(entry.nodeId.toString());
        if (owners === undefined || owners.size === 0) {
            return attributes;
        }
        const node = entry.nodeId.toString();
        return scopedAttributes(attributes, endpoint => (owners.get(endpoint) ?? node) === entry.key);
    }

    /** The device an endpoint of a node belongs to. */
    #entryOf(nodeId: NodeId, endpoint: number): DeviceEntry | undefined {
        const node = nodeId.toString();
        return this.#devices.get(this.#owners.get(node)?.get(endpoint) ?? node);
    }

    /** The node's own device and the devices behind it, if it is a bridge. */
    #entriesOf(node: string): DeviceEntry[] {
        return [...this.#devices.values()].filter(entry => entry.nodeId.toString() === node);
    }

    /** A bridged device is available while its bridge is and it reports itself reachable. */
    #isAvailable(entry: DeviceEntry, details: MatterNodeData): boolean {
        if (!details.available) {
            return false;
        }
        if (entry.bridgedEndpoint === undefined) {
            return true;
        }
        const reachable =
            details.attributes[
                `${entry.bridgedEndpoint}/${BRIDGED_BASIC_INFORMATION_CLUSTER_ID}/${BRIDGED_REACHABLE_ATTRIBUTE_ID}`
            ];
        return reachable !== false;
    }

    #publishAvailability(entry: DeviceEntry): void {
        let details: MatterNodeData;
        try {
            details = this.#commandHandler.getNodeDetails(entry.nodeId);
        } catch {
            return;
        }
        this.#connection.publish(
            this.#topics.deviceAvailability(entry.key),
            this.#isAvailable(entry, details) ? "online" : "offline",
            true,
        );
    }

    /**
     * (Re-)sync a node from the controller's attribute cache: split off the devices behind it when it
     * is a Matter bridge, and publish discovery, availability and state of each. Drops the node when it
     * is gone, and devices its bridge no longer has.
     */
    #refreshDevice(nodeId: NodeId, announce = false): void {
        const node = nodeId.toString();
        let details: MatterNodeData;
        try {
            details = this.#commandHandler.getNodeDetails(nodeId);
        } catch {
            for (const key of this.#removeNode(node)) {
                if (announce) {
                    this.#publishBridgeEvent("device_leave", { friendly_name: key, id: key });
                }
            }
            return;
        }
        const known = new Set(this.#entriesOf(node).map(entry => entry.key));

        const bridged = bridgedDevicesOf(details.attributes, details.endpoint_parents);
        const owners = new Map<number, string>();
        for (const [endpoint, members] of bridged) {
            for (const member of members) {
                owners.set(member, bridgedDeviceKey(node, endpoint));
            }
        }
        this.#owners.set(node, owners);

        const keys = new Set([node, ...[...bridged.keys()].map(endpoint => bridgedDeviceKey(node, endpoint))]);
        for (const entry of this.#entriesOf(node)) {
            if (!keys.has(entry.key)) {
                this.#removeDevice(entry.key);
                if (announce) {
                    this.#publishBridgeEvent("device_leave", { friendly_name: entry.key, id: entry.key });
                }
            }
        }
        this.#refreshEntry(nodeId, node, undefined, details);
        for (const endpoint of bridged.keys()) {
            this.#refreshEntry(nodeId, bridgedDeviceKey(node, endpoint), endpoint, details);
        }
        if (announce) {
            // A new node, or a device a bridge just added: Matter commissioning has interviewed it already
            for (const key of [...keys].filter(key => !known.has(key))) {
                this.#publishBridgeEvent("device_joined", { friendly_name: key, id: key });
                this.#publishInterviewResult(key, true);
            }
        }
    }

    #refreshEntry(nodeId: NodeId, key: string, bridgedEndpoint: number | undefined, details: MatterNodeData): void {
        const previous = this.#devices.get(key);
        const entry: DeviceEntry = {
            key,
            nodeId,
            bridgedEndpoint,
            onOffEndpoints: [],
            relevantEndpoints: [],
            discoveryTopics: [],
        };
        const attributes = this.#attributesOf(entry, details.attributes);
        entry.onOffEndpoints = onOffEndpointsOf(attributes);
        entry.relevantEndpoints = relevantEndpointsOf(attributes);
        this.#devices.set(key, entry);

        // Migration/cleanup: state now lives on the single `<device>` topic; clear any retained
        // per-endpoint state topics from earlier layouts
        for (const endpoint of new Set([...entry.relevantEndpoints, ...(previous?.relevantEndpoints ?? [])])) {
            this.#connection.clearRetained(this.#topics.deviceState(key, endpoint));
        }

        this.#publishDiscovery(entry, attributes, previous?.discoveryTopics ?? []);
        this.#connection.publish(
            this.#topics.deviceAvailability(key),
            this.#isAvailable(entry, details) ? "online" : "offline",
            true,
        );
        this.#publishDeviceState(entry);
    }

    /** BasicInformation of a node, or BridgedDeviceBasicInformation of a bridged device. */
    #basicInformationOf(entry: DeviceEntry): string {
        return entry.bridgedEndpoint === undefined
            ? "0/40"
            : `${entry.bridgedEndpoint}/${BRIDGED_BASIC_INFORMATION_CLUSTER_ID}`;
    }

    /** Publish retained HA discovery for the device; clear topics that disappeared. */
    #publishDiscovery(entry: DeviceEntry, attributes: AttributesData, previousTopics: string[]): void {
        const basic = this.#basicInformationOf(entry);
        const messages = discoveryMessagesOf(
            {
                device: entry.key,
                vendorName: stringAttribute(attributes, `${basic}/1`),
                productName: stringAttribute(attributes, `${basic}/3`),
                serialNumber: stringAttribute(attributes, `${basic}/15`),
                serverVersion: this.#serverVersion,
                lastSeen: this.#lastSeenEnabled,
                ...(entry.bridgedEndpoint === undefined
                    ? {}
                    : {
                          name: stringAttribute(attributes, `${basic}/5`),
                          viaDevice: `matter2mqtt_${entry.nodeId.toString()}`,
                      }),
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

    /** Drop a node and the devices behind it; returns their keys. */
    #removeNode(node: string): string[] {
        const keys = this.#entriesOf(node).map(entry => entry.key);
        for (const key of keys) {
            this.#removeDevice(key);
        }
        this.#owners.delete(node);
        return keys;
    }

    #removeDevice(device: string): void {
        const entry = this.#devices.get(device);
        if (entry === undefined) {
            return;
        }
        this.#devices.delete(device);
        this.#ota.forget(device);
        this.#lastSeen.delete(device);
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
        const devices = [...this.#devices.keys()].flatMap(key => this.#describe(key) ?? []);
        this.#connection.publish(this.#topics.bridgeDevices, toBigIntAwareJson(devices), true);
    }

    /** The device's `bridge/devices` entry. */
    #describe(key: string): Record<string, unknown> | undefined {
        const entry = this.#devices.get(key);
        if (entry === undefined) {
            return undefined;
        }
        let details: MatterNodeData;
        try {
            details = this.#commandHandler.getNodeDetails(entry.nodeId);
        } catch {
            return undefined;
        }
        const attributes = this.#attributesOf(entry, details.attributes);
        const basic = this.#basicInformationOf(entry);
        return {
            id: entry.key,
            node_id: details.node_id,
            ...(entry.bridgedEndpoint === undefined
                ? {}
                : { bridge_id: entry.nodeId.toString(), endpoint: entry.bridgedEndpoint }),
            available: this.#isAvailable(entry, details),
            is_bridge: entry.bridgedEndpoint === undefined && details.is_bridge,
            vendor_name: stringAttribute(attributes, `${basic}/1`),
            product_name: stringAttribute(attributes, `${basic}/3`),
            node_label: stringAttribute(attributes, `${basic}/5`),
            serial_number: stringAttribute(attributes, `${basic}/15`),
            unique_id: stringAttribute(attributes, `${basic}/18`),
            onoff_endpoints: entry.onOffEndpoints,
            ...deviceDescriptionOf(
                entry.key,
                attributes,
                entry.relevantEndpoints,
                endpoint => lightCapabilitiesOf(attributes, endpoint),
                supportsOta(attributes),
                basic,
            ),
        };
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

/** The arguments of a bridge request, or none when the payload is not a JSON object. */
function argsOf(payload: string): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(payload);
        return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}
