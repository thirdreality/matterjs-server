/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import { Diagnostic, Logger, LogLevel } from "@matter/main";
import { forwardLogs, logPayloadOf } from "../src/Logging.js";

describe("Logging", () => {
    it("formats a log message as zigbee2mqtt's bridge/logging payload", () => {
        const message = Diagnostic.message({
            level: LogLevel.WARN,
            facility: "MqttBridge",
            prefix: "",
            values: ["Node", 5, "is gone"],
        });
        expect(JSON.parse(logPayloadOf(message) ?? "{}")).to.deep.equal({
            level: "warning",
            message: "Node 5 is gone",
            namespace: "MqttBridge",
        });
    });

    it("never forwards the broker link's own messages", () => {
        const message = Diagnostic.message({
            level: LogLevel.WARN,
            facility: "MqttConnection",
            prefix: "",
            values: ["x"],
        });
        expect(logPayloadOf(message)).to.equal(undefined);
    });

    it("forwards messages at the level and above until stopped", () => {
        const published: string[] = [];
        const stop = forwardLogs("warning", payload => published.push(payload));
        const logger = Logger.get("LoggingTest");
        logger.info("quiet");
        logger.warn("loud");
        logger.error("louder");
        stop();
        logger.error("after stop");
        expect(published.map(p => (JSON.parse(p) as { message: string }).message)).to.deep.equal(["loud", "louder"]);
    });

    it("does not recurse when publishing logs itself", () => {
        const logger = Logger.get("LoggingTest");
        let calls = 0;
        const stop = forwardLogs("info", () => {
            calls++;
            logger.warn("publishing logged something");
        });
        logger.warn("first");
        stop();
        expect(calls).to.equal(1);
    });

    it("forwards nothing for none", () => {
        const published: string[] = [];
        const stop = forwardLogs("none", payload => published.push(payload));
        Logger.get("LoggingTest").error("ignored");
        stop();
        expect(published).to.deep.equal([]);
    });
});
