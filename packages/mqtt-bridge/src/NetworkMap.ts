/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

/** The parts of the controller's network topology (ws-client `NetworkTopology`) the map is built from. */
export interface TopologyInput {
    nodes: {
        id: string;
        kind: string;
        network_type: string;
        node_id?: number | bigint;
        role?: string;
        available?: boolean;
        ext_address?: string;
        rloc16?: number;
        network_name?: string;
        ssid?: string;
        host_name?: string;
        vendor_name?: string;
        model_name?: string;
    }[];
    connections: {
        source: string;
        target: string;
        network: string;
        strength: string;
        source_to_target?: { lqi?: number; rssi?: number };
        target_to_source?: { lqi?: number; rssi?: number };
        via_route_table?: boolean;
    }[];
}

/** zigbee2mqtt device types: the border router plays the coordinator, Thread routers and Wi-Fi APs route. */
function deviceTypeOf(node: TopologyInput["nodes"][number]): string {
    if (node.kind === "border_router") {
        return "Coordinator";
    }
    if (node.kind === "wifi_ap" || node.role === "leader" || node.role === "router") {
        return "Router";
    }
    return "EndDevice";
}

/** A link quality in zigbee2mqtt's 0-255 range: the measured LQI, else one from the strength summary. */
function linkQualityOf(connection: TopologyInput["connections"][number]): number {
    const lqi = connection.source_to_target?.lqi ?? connection.target_to_source?.lqi;
    if (lqi !== undefined) {
        return lqi;
    }
    return { strong: 255, medium: 170, weak: 85 }[connection.strength] ?? 0;
}

function friendlyNameOf(node: TopologyInput["nodes"][number]): string {
    if (node.node_id !== undefined) {
        return node.node_id.toString();
    }
    return node.host_name ?? node.ssid ?? node.id;
}

/**
 * zigbee2mqtt's raw `networkmap` from the Matter topology: `nodes` and `links`, keyed by the Thread extended
 * address where there is one. Each node also carries the Matter details zigbee2mqtt has no field for. Without
 * `routes`, links only known from a route table are left out, as zigbee2mqtt leaves out routing links.
 */
export function rawNetworkMapOf(topology: TopologyInput, routes: boolean) {
    const addressOf = new Map(topology.nodes.map(node => [node.id, node.ext_address ?? node.id]));
    return {
        nodes: topology.nodes.map(node => ({
            ieeeAddr: addressOf.get(node.id),
            friendlyName: friendlyNameOf(node),
            type: deviceTypeOf(node),
            networkAddress: node.rloc16,
            matter: {
                id: node.id,
                kind: node.kind,
                network_type: node.network_type,
                ...(node.role === undefined ? {} : { role: node.role }),
                ...(node.available === undefined ? {} : { available: node.available }),
                ...(node.network_name === undefined ? {} : { network_name: node.network_name }),
                ...(node.ssid === undefined ? {} : { ssid: node.ssid }),
                ...(node.vendor_name === undefined ? {} : { vendor_name: node.vendor_name }),
                ...(node.model_name === undefined ? {} : { model_name: node.model_name }),
            },
        })),
        links: topology.connections
            .filter(connection => routes || connection.via_route_table !== true)
            .map(connection => {
                const linkquality = linkQualityOf(connection);
                return {
                    source: { ieeeAddr: addressOf.get(connection.source) ?? connection.source },
                    target: { ieeeAddr: addressOf.get(connection.target) ?? connection.target },
                    linkquality,
                    lqi: linkquality,
                    network: connection.network,
                    strength: connection.strength,
                    routes: connection.via_route_table === true ? [connection.target] : [],
                };
            }),
    };
}

function quoted(text: string): string {
    return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** zigbee2mqtt's `graphviz` networkmap: a DOT digraph, routers as boxes, links labelled with their quality. */
export function graphvizNetworkMapOf(topology: TopologyInput, routes: boolean): string {
    const map = rawNetworkMapOf(topology, routes);
    const lines = ["digraph G {", "node[shape=record];"];
    for (const node of map.nodes) {
        const shape = node.type === "EndDevice" ? "ellipse" : "box";
        const label = [node.friendlyName, node.type, node.matter.role].filter(part => part !== undefined).join("\n");
        lines.push(`  ${quoted(String(node.ieeeAddr))} [shape=${shape}, label=${quoted(label)}];`);
    }
    for (const link of map.links) {
        const style = link.routes.length > 0 ? "dashed" : "solid";
        lines.push(
            `  ${quoted(String(link.source.ieeeAddr))} -> ${quoted(String(link.target.ieeeAddr))} [label=${quoted(String(link.linkquality))}, style=${style}];`,
        );
    }
    lines.push("}");
    return lines.join("\n");
}
