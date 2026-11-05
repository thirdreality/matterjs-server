/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import { executeBridgeCommand, type BridgeCommandContext } from "../src/BridgeCommands.js";
import { graphvizNetworkMapOf, rawNetworkMapOf, type TopologyInput } from "../src/NetworkMap.js";

// A border router, a Thread router (node 5) and a sleepy sensor (node 6) behind it
const TOPOLOGY: TopologyInput = {
    nodes: [
        { id: "br_AABB", kind: "border_router", network_type: "thread", ext_address: "AABB", host_name: "Hub" },
        {
            id: "5",
            kind: "matter",
            network_type: "thread",
            node_id: 5,
            role: "router",
            ext_address: "0005",
            rloc16: 0x400,
            available: true,
        },
        {
            id: "6",
            kind: "matter",
            network_type: "thread",
            node_id: 6n,
            role: "sleepy_end_device",
            ext_address: "0006",
            rloc16: 0x401,
        },
    ],
    connections: [
        { source: "5", target: "br_AABB", network: "thread", strength: "strong", source_to_target: { lqi: 3 } },
        { source: "6", target: "5", network: "thread", strength: "medium" },
        { source: "6", target: "br_AABB", network: "thread", strength: "weak", via_route_table: true },
    ],
};

describe("NetworkMap", () => {
    it("maps the topology onto zigbee2mqtt's raw networkmap", () => {
        const map = rawNetworkMapOf(TOPOLOGY, false);
        expect(map.nodes.map(n => [n.ieeeAddr, n.friendlyName, n.type, n.networkAddress])).to.deep.equal([
            ["AABB", "Hub", "Coordinator", undefined],
            ["0005", "5", "Router", 0x400],
            ["0006", "6", "EndDevice", 0x401],
        ]);
        expect(map.nodes[2].matter).to.deep.include({ role: "sleepy_end_device", kind: "matter" });
        expect(map.links.map(l => [l.source.ieeeAddr, l.target.ieeeAddr, l.linkquality])).to.deep.equal([
            ["0005", "AABB", 3],
            ["0006", "0005", 170],
        ]);
    });

    it("adds route-table links with routes", () => {
        const map = rawNetworkMapOf(TOPOLOGY, true);
        expect(map.links).to.have.length(3);
        expect(map.links[2]).to.deep.include({ linkquality: 85, routes: ["br_AABB"] });
    });

    it("renders a graphviz digraph", () => {
        const dot = graphvizNetworkMapOf(TOPOLOGY, true);
        expect(dot.startsWith("digraph G {")).to.equal(true);
        expect(dot).to.contain('"0006" [shape=ellipse, label="6\\nEndDevice\\nsleepy_end_device"];');
        expect(dot).to.contain('"0006" -> "AABB" [label="85", style=dashed];');
    });

    it("answers bridge/request/networkmap, refreshing first unless told not to", async () => {
        let refreshed = 0;
        const ctx = {
            controller: {
                networkTopology: {
                    getTopology: () => TOPOLOGY,
                    refresh: () => {
                        refreshed++;
                        return Promise.resolve(TOPOLOGY);
                    },
                },
            },
        } as unknown as BridgeCommandContext;
        const raw = await executeBridgeCommand("networkmap", "raw", ctx);
        expect(raw.status).to.equal("ok");
        expect(raw.data).to.deep.include({ type: "raw", routes: false });
        expect(refreshed).to.equal(1);
        const graphviz = await executeBridgeCommand("networkmap", '{"type":"graphviz","refresh":false}', ctx);
        expect(typeof (graphviz.data as { value: unknown }).value).to.equal("string");
        expect(refreshed).to.equal(1);
        expect((await executeBridgeCommand("networkmap", '{"type":"plantuml"}', ctx)).error).to.contain(
            '"raw" or "graphviz"',
        );
    });
});
