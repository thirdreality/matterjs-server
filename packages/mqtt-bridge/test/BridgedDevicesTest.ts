/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ControllerCommandHandler } from "@matter-server/ws-controller";
import { NodeId, Observable } from "@matter/main";
import { bridgedDevicesOf, scopedAttributes } from "../src/BridgedDevices.js";
import { MqttBridge } from "../src/MqttBridge.js";
import type { BridgeConnection } from "../src/MqttConnection.js";

// A Zigbee-to-Matter bridge: aggregator on ep1; a bulb on ep3; a dual switch on ep4 with its two relays
// on ep5/ep6; an unreachable contact sensor on ep7 with a battery
const BRIDGE: Record<string, unknown> = {
    "0/40/1": "ThirdReality",
    "0/40/3": "Smart Bridge MZ1",
    "1/29/0": [{ "0": 0x000e, "1": 1 }],
    "1/29/3": [3, 4, 5, 6, 7],
    "3/29/0": [
        { "0": 0x0100, "1": 3 },
        { "0": 0x0013, "1": 2 },
    ],
    "3/57/1": "ThirdReality",
    "3/57/3": "Smart Bulb",
    "3/57/5": "Living room",
    "3/57/17": true,
    "3/6/0": true,
    "3/8/0": 100,
    "4/29/0": [{ "0": 0x0013, "1": 2 }],
    "4/29/3": [5, 6],
    "4/57/5": "Hall switch",
    "4/57/17": true,
    "5/6/0": false,
    "6/6/0": true,
    "7/29/0": [
        { "0": 0x0015, "1": 2 },
        { "0": 0x0013, "1": 2 },
    ],
    "7/57/5": "Back door",
    "7/57/17": false,
    "7/69/0": true,
    "7/47/12": 200,
};
const PARENTS = { "1": 0, "3": 1, "4": 1, "5": 4, "6": 4, "7": 1 };

describe("BridgedDevices", () => {
    it("groups the endpoints of each bridged device", () => {
        const devices = bridgedDevicesOf(BRIDGE, PARENTS);
        expect([...devices.entries()].map(([ep, members]) => [ep, [...members]])).to.deep.equal([
            [3, [3]],
            [4, [4, 5, 6]],
            [7, [7]],
        ]);
    });

    it("falls back to PartsList without endpoint parents", () => {
        expect([...(bridgedDevicesOf(BRIDGE).get(4) ?? [])]).to.deep.equal([4, 5, 6]);
    });

    it("finds nothing on a node that is not a bridge", () => {
        expect(bridgedDevicesOf({ "1/6/0": true }).size).to.equal(0);
    });

    it("scopes attributes to endpoints", () => {
        expect(Object.keys(scopedAttributes(BRIDGE, ep => ep === 5))).to.deep.equal(["5/6/0"]);
    });
});

interface Published {
    topic: string;
    payload: string;
    retain: boolean;
}

function harness(initial: Record<string, unknown>, options: { lastSeen?: boolean; withCommands?: boolean } = {}) {
    let attributes = { ...initial };
    const published: Published[] = [];
    const invoked: unknown[] = [];
    let onMessage: (topic: string, payload: string) => void = () => {};
    const connection: BridgeConnection = {
        connect: handler => {
            onMessage = handler;
        },
        subscribe: () => {},
        publish: (topic, payload, retain = false) => published.push({ topic, payload, retain }),
        clearRetained: topic => published.push({ topic, payload: "", retain: true }),
        close: () => Promise.resolve(),
    };
    const events = {
        attributeChanged: new Observable<[NodeId, { path: Record<string, number>; value: unknown }]>(),
        eventChanged: new Observable<[NodeId, { path: Record<string, number>; events: { data: unknown }[] }]>(),
        nodeAdded: new Observable<[NodeId]>(),
        nodeStructureChanged: new Observable<[NodeId]>(),
        nodeAvailabilityChanged: new Observable<[NodeId, boolean]>(),
        nodeDecommissioned: new Observable<[NodeId]>(),
    };
    const commandHandler = {
        start: () => Promise.resolve(),
        events,
        bleEnabled: false,
        bleProxyEnabled: false,
        getNodeIds: () => [NodeId(12)],
        getNodeDetails: () => ({
            node_id: 12,
            available: true,
            is_bridge: true,
            attributes,
            endpoint_parents: PARENTS,
        }),
        formatNode: (nodeId: NodeId) => String(nodeId),
        handleInvoke: (request: unknown) => {
            invoked.push(request);
            return Promise.resolve();
        },
        interviewNode: () => Promise.resolve(),
    } as unknown as ControllerCommandHandler;
    const commandContext = options.withCommands
        ? {
              config: { getWifiCredentials: () => undefined, getThreadCredentials: () => undefined },
              controller: {},
          }
        : undefined;
    const bridge = new MqttBridge(
        commandHandler,
        { url: "mqtt://test", connection, lastSeen: options.lastSeen },
        commandContext as never,
    );
    const last = (topic: string) => published.filter(p => p.topic === topic).at(-1)?.payload;
    const bridgeEvents = () =>
        published
            .filter(p => p.topic === "matter2mqtt/bridge/event")
            .map(p => JSON.parse(p.payload) as Record<string, unknown>);
    return {
        bridge,
        events,
        published,
        invoked,
        last,
        bridgeEvents,
        send: (topic: string, payload: string) => onMessage(topic, payload),
        setAttributes: (next: Record<string, unknown>) => {
            attributes = next;
        },
    };
}

describe("MqttBridge with a Matter bridge", () => {
    it("publishes each bridged device on its own topic", async () => {
        const h = harness(BRIDGE);
        await h.bridge.start();
        expect(JSON.parse(h.last("matter2mqtt/12_3") ?? "{}")).to.deep.equal({ state: "ON", brightness: 100 });
        expect(JSON.parse(h.last("matter2mqtt/12_4") ?? "{}")).to.deep.equal({ state_5: "OFF", state_6: "ON" });
        expect(JSON.parse(h.last("matter2mqtt/12_7") ?? "{}")).to.deep.equal({ contact: true, battery: 100 });
        // The bridge node itself has no state of its own left, so an old combined state is cleared
        expect(h.last("matter2mqtt/12")).to.equal("");
        await h.bridge.stop();
    });

    it("follows each device's reachability", async () => {
        const h = harness(BRIDGE);
        await h.bridge.start();
        expect(h.last("matter2mqtt/12_3/availability")).to.equal("online");
        expect(h.last("matter2mqtt/12_7/availability")).to.equal("offline");
        h.setAttributes({ ...BRIDGE, "7/57/17": true });
        h.events.attributeChanged.emit(NodeId(12), {
            path: { endpointId: 7, clusterId: 57, attributeId: 17 },
            value: true,
        });
        expect(h.last("matter2mqtt/12_7/availability")).to.equal("online");
        await h.bridge.stop();
    });

    it("announces each bridged device to Home Assistant through the bridge", async () => {
        const h = harness(BRIDGE);
        await h.bridge.start();
        const light = JSON.parse(h.last("homeassistant/light/matter2mqtt_12_3/light/config") ?? "{}");
        expect(light.device).to.include({
            name: "Living room",
            manufacturer: "ThirdReality",
            model: "Smart Bulb",
            via_device: "matter2mqtt_12",
        });
        expect(light.state_topic).to.equal("matter2mqtt/12_3");
        const devices = JSON.parse(h.last("matter2mqtt/bridge/devices") ?? "[]") as Record<string, unknown>[];
        expect(devices.map(d => [d.id, d.bridge_id, d.available, d.is_bridge])).to.deep.equal([
            ["12", undefined, true, true],
            ["12_3", "12", true, false],
            ["12_4", "12", true, false],
            ["12_7", "12", false, false],
        ]);
        expect(devices[1]).to.include({ node_label: "Living room", product_name: "Smart Bulb", endpoint: 3 });
        await h.bridge.stop();
    });

    it("routes commands to the bridged device's endpoints", async () => {
        const h = harness(BRIDGE);
        await h.bridge.start();
        h.send("matter2mqtt/12_4/set", '{"state_6":"OFF"}');
        h.send("matter2mqtt/12_3/set", "OFF");
        expect(h.invoked).to.have.length(2);
        expect(h.invoked[0]).to.deep.include({ endpointId: 6, commandName: "off" });
        expect(h.invoked[1]).to.deep.include({ endpointId: 3, commandName: "off" });
        await h.bridge.stop();
    });

    it("publishes a state change to the device that owns the endpoint", async () => {
        const h = harness(BRIDGE);
        await h.bridge.start();
        h.setAttributes({ ...BRIDGE, "5/6/0": true });
        h.events.attributeChanged.emit(NodeId(12), {
            path: { endpointId: 5, clusterId: 6, attributeId: 0 },
            value: true,
        });
        expect(JSON.parse(h.last("matter2mqtt/12_4") ?? "{}")).to.deep.equal({ state_5: "ON", state_6: "ON" });
        await h.bridge.stop();
    });

    it("clears a device the bridge no longer has", async () => {
        const h = harness(BRIDGE);
        await h.bridge.start();
        const remaining = Object.fromEntries(Object.entries(BRIDGE).filter(([path]) => !path.startsWith("7/")));
        h.setAttributes(remaining);
        h.events.nodeStructureChanged.emit(NodeId(12));
        expect(h.last("matter2mqtt/12_7")).to.equal("");
        expect(h.last("matter2mqtt/12_7/availability")).to.equal("");
        expect(h.last("homeassistant/binary_sensor/matter2mqtt_12_7/contact/config")).to.equal("");
        const devices = JSON.parse(h.last("matter2mqtt/bridge/devices") ?? "[]") as { id: string }[];
        expect(devices.map(d => d.id)).to.deep.equal(["12", "12_3", "12_4"]);
        await h.bridge.stop();
    });

    describe("bridge/event", () => {
        it("announces nothing for the devices already there at start", async () => {
            const h = harness(BRIDGE);
            await h.bridge.start();
            expect(h.bridgeEvents()).to.deep.equal([]);
            await h.bridge.stop();
        });

        it("announces a device the bridge adds, with its definition", async () => {
            const h = harness(BRIDGE);
            await h.bridge.start();
            h.setAttributes({ ...BRIDGE, "8/57/5": "Porch light", "8/57/17": true, "8/6/0": false });
            h.events.nodeStructureChanged.emit(NodeId(12));
            const events = h.bridgeEvents();
            expect(events.map(e => e.type)).to.deep.equal(["device_joined", "device_interview"]);
            expect(events[0].data).to.deep.equal({ friendly_name: "12_8", id: "12_8" });
            expect(events[1].data).to.deep.include({ friendly_name: "12_8", status: "successful", supported: true });
            expect((events[1].data as { definition: { exposes: unknown[] } }).definition.exposes).to.have.length(1);
            await h.bridge.stop();
        });

        it("announces devices that leave", async () => {
            const h = harness(BRIDGE);
            await h.bridge.start();
            h.setAttributes(Object.fromEntries(Object.entries(BRIDGE).filter(([path]) => !path.startsWith("7/"))));
            h.events.nodeStructureChanged.emit(NodeId(12));
            h.events.nodeDecommissioned.emit(NodeId(12));
            expect(h.bridgeEvents().map(e => [e.type, (e.data as { id: string }).id])).to.deep.equal([
                ["device_leave", "12_7"],
                ["device_leave", "12"],
                ["device_leave", "12_3"],
                ["device_leave", "12_4"],
            ]);
            await h.bridge.stop();
        });

        it("reports an interview requested over MQTT", async () => {
            const h = harness(BRIDGE, { withCommands: true });
            await h.bridge.start();
            h.send("matter2mqtt/bridge/request/device/interview", '{"id":12}');
            await new Promise(resolve => setImmediate(resolve));
            expect(h.bridgeEvents().map(e => (e.data as { status: string }).status)).to.deep.equal([
                "started",
                "successful",
            ]);
            await h.bridge.stop();
        });
    });

    describe("last_seen", () => {
        it("is off by default", async () => {
            const h = harness(BRIDGE);
            await h.bridge.start();
            h.events.attributeChanged.emit(NodeId(12), {
                path: { endpointId: 3, clusterId: 6, attributeId: 0 },
                value: true,
            });
            expect(JSON.parse(h.last("matter2mqtt/12_3") ?? "{}").last_seen).to.equal(undefined);
            expect(h.last("homeassistant/sensor/matter2mqtt_12_3/last_seen/config")).to.equal(undefined);
            await h.bridge.stop();
        });

        it("stamps the device that reported, when enabled", async () => {
            const h = harness(BRIDGE, { lastSeen: true });
            await h.bridge.start();
            const before = Date.now();
            h.events.attributeChanged.emit(NodeId(12), {
                path: { endpointId: 3, clusterId: 6, attributeId: 0 },
                value: true,
            });
            const seen = Date.parse(JSON.parse(h.last("matter2mqtt/12_3") ?? "{}").last_seen);
            expect(seen).to.be.at.least(before - 1000);
            expect(JSON.parse(h.last("matter2mqtt/12_4") ?? "{}").last_seen).to.equal(undefined);
            const sensor = JSON.parse(h.last("homeassistant/sensor/matter2mqtt_12_3/last_seen/config") ?? "{}");
            expect(sensor).to.include({
                device_class: "timestamp",
                enabled_by_default: false,
                entity_category: "diagnostic",
            });
            await h.bridge.stop();
        });
    });
});
