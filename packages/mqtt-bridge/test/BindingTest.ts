/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import { NodeId } from "@matter/main";
import { aclEntriesOf, clusterIdOf, withAccess, withoutAccess } from "../src/Binding.js";
import { executeBridgeCommand, type BridgeCommandContext, type ResolvedDevice } from "../src/BridgeCommands.js";

const CONTROLLER = 112233;
const ADMIN = { "1": 5, "2": 2, "3": [CONTROLLER], "4": null, "254": 1 };

// A dimmer switch (OnOff and LevelControl client) on node 20, a dimmable bulb on node 21
const SWITCH = { "0/31/0": [ADMIN], "1/29/2": [3, 6, 8], "1/30/0": [] };
const BULB = { "0/31/0": [ADMIN], "1/29/1": [3, 4, 6, 8, 29], "1/6/0": true, "1/8/0": 100 };

function context(devices: Record<string, { nodeId: number; attributes: Record<string, unknown> }>) {
    const writes: { kind: string; node: unknown; endpoint?: unknown; value: unknown }[] = [];
    const resolveDevice = (key: string): ResolvedDevice | undefined => {
        const device = devices[key];
        return device === undefined
            ? undefined
            : { nodeId: NodeId(device.nodeId), attributes: device.attributes, nodeAttributes: device.attributes };
    };
    const ctx = {
        resolveDevice,
        commandHandler: {
            setAclEntry: (node: unknown, entries: unknown) => {
                writes.push({ kind: "acl", node, value: entries });
                return Promise.resolve([{ status: 0 }]);
            },
            setNodeBinding: (node: unknown, endpoint: unknown, bindings: unknown) => {
                writes.push({ kind: "binding", node, endpoint, value: bindings });
                return Promise.resolve([{ status: 0 }]);
            },
        },
    } as unknown as BridgeCommandContext;
    return { ctx, writes };
}

const ADMIN_ENTRY = { privilege: 5, auth_mode: 2, subjects: [CONTROLLER], targets: null };

describe("Binding", () => {
    it("reads tag-keyed ACL entries from the cache", () => {
        expect(aclEntriesOf([ADMIN])).to.deep.equal([ADMIN_ENTRY]);
        expect(aclEntriesOf(undefined)).to.equal(undefined);
    });

    it("resolves Matter and zigbee2mqtt cluster names", () => {
        expect(["OnOff", "genLevelCtrl", "lightingColorCtrl", 258, "513"].map(clusterIdOf)).to.deep.equal([
            6, 8, 768, 258, 513,
        ]);
        expect(clusterIdOf("nonsense")).to.equal(undefined);
    });

    it("adds access only for what is not granted yet, and removes only its own entries", () => {
        const request = { node: 20n, endpoint: 1, clusters: [6, 8] };
        const granted = withAccess([ADMIN_ENTRY], request);
        expect(granted).to.have.length(2);
        expect(withAccess(granted, request)).to.equal(granted);
        expect(withoutAccess(granted, request)).to.deep.equal([ADMIN_ENTRY]);
        const foreign = {
            privilege: 3,
            auth_mode: 2,
            subjects: [20, 30],
            targets: [{ cluster: 6, endpoint: 1, device_type: null }],
        };
        expect(withoutAccess([ADMIN_ENTRY, foreign], request)).to.deep.equal([ADMIN_ENTRY, foreign]);
    });

    describe("device/bind", () => {
        it("binds the clusters the switch controls and grants it access on the bulb", async () => {
            const { ctx, writes } = context({
                "20": { nodeId: 20, attributes: SWITCH },
                "21": { nodeId: 21, attributes: BULB },
            });
            const response = await executeBridgeCommand("device/bind", '{"from":"20","to":"21","transaction":1}', ctx);
            expect(response).to.deep.equal({
                status: "ok",
                data: {
                    from: "20",
                    from_endpoint: 1,
                    to: "21",
                    to_endpoint: 1,
                    clusters: ["OnOff", "LevelControl"],
                    failed: [],
                },
                transaction: 1,
            });
            expect(writes.map(w => w.kind)).to.deep.equal(["acl", "binding"]);
            expect(writes[0].node).to.equal(NodeId(21));
            expect(writes[0].value).to.deep.equal([
                ADMIN_ENTRY,
                {
                    privilege: 3,
                    auth_mode: 2,
                    subjects: [20n],
                    targets: [
                        { cluster: 6, endpoint: 1, device_type: null },
                        { cluster: 8, endpoint: 1, device_type: null },
                    ],
                },
            ]);
            expect(writes[1]).to.deep.include({ node: NodeId(20), endpoint: 1 });
            expect(writes[1].value).to.deep.equal([
                { node: 21n, group: null, endpoint: 1, cluster: 6 },
                { node: 21n, group: null, endpoint: 1, cluster: 8 },
            ]);
        });

        it("takes explicit clusters by zigbee2mqtt name", async () => {
            const { ctx, writes } = context({
                "20": { nodeId: 20, attributes: SWITCH },
                "21": { nodeId: 21, attributes: BULB },
            });
            const response = await executeBridgeCommand(
                "device/bind",
                '{"from":"20","to":"21","clusters":["genOnOff"]}',
                ctx,
            );
            expect((response.data as { clusters: string[] }).clusters).to.deep.equal(["OnOff"]);
            expect((writes[1].value as unknown[]).length).to.equal(1);
        });

        it("needs no ACL entry between two devices of the same node", async () => {
            const bridge = { ...SWITCH, ...BULB, "3/29/2": [6], "3/30/0": [], "4/29/1": [6], "4/6/0": false };
            const { ctx, writes } = context({
                "12_3": { nodeId: 12, attributes: bridge },
                "12_4": { nodeId: 12, attributes: bridge },
            });
            const response = await executeBridgeCommand(
                "device/bind",
                '{"from":"12_3","from_endpoint":3,"to":"12_4","to_endpoint":4}',
                ctx,
            );
            expect(response.status).to.equal("ok");
            expect(writes.map(w => w.kind)).to.deep.equal(["binding"]);
        });

        it("refuses to rewrite an ACL it cannot read or that has no administrator", async () => {
            for (const acl of [undefined, [{ "1": 3, "2": 2, "3": [5], "4": null }]]) {
                const { ctx, writes } = context({
                    "20": { nodeId: 20, attributes: SWITCH },
                    "21": { nodeId: 21, attributes: { ...BULB, "0/31/0": acl } },
                });
                const response = await executeBridgeCommand("device/bind", '{"from":"20","to":"21"}', ctx);
                expect(response.status).to.equal("error");
                expect(response.error).to.contain("refusing to rewrite it");
                expect(writes).to.deep.equal([]);
            }
        });

        it("refuses a source without a Binding cluster and an unknown device", async () => {
            const { ctx } = context({ "21": { nodeId: 21, attributes: BULB } });
            expect((await executeBridgeCommand("device/bind", '{"from":"21","to":"21"}', ctx)).error).to.contain(
                "has no Binding cluster",
            );
            expect((await executeBridgeCommand("device/bind", '{"from":"99","to":"21"}', ctx)).error).to.contain(
                'unknown source device "99"',
            );
        });
    });

    describe("device/unbind", () => {
        it("removes the binding and the access entry bind added", async () => {
            const bound = {
                ...SWITCH,
                "1/30/0": [
                    { "1": 21, "3": 1, "4": 6, "254": 1 },
                    { "1": 21, "3": 1, "4": 8, "254": 1 },
                    { "1": 22, "3": 1, "4": 6, "254": 1 },
                ],
            };
            const granted = {
                ...BULB,
                "0/31/0": [
                    ADMIN,
                    {
                        "1": 3,
                        "2": 2,
                        "3": [20],
                        "4": [
                            { "0": 6, "1": 1 },
                            { "0": 8, "1": 1 },
                        ],
                        "254": 1,
                    },
                ],
            };
            const { ctx, writes } = context({
                "20": { nodeId: 20, attributes: bound },
                "21": { nodeId: 21, attributes: granted },
            });
            const response = await executeBridgeCommand("device/unbind", '{"from":"20","to":"21"}', ctx);
            expect(response.status).to.equal("ok");
            expect(writes.map(w => w.kind)).to.deep.equal(["binding", "acl"]);
            expect(writes[0].value).to.deep.equal([{ node: 22, group: null, endpoint: 1, cluster: 6 }]);
            expect(writes[1].value).to.deep.equal([ADMIN_ENTRY]);
        });
    });
});
