/**
 * @license
 * Copyright 2026 ThirdReality
 * SPDX-License-Identifier: Apache-2.0
 */

import { Diagnostic, LogDestination, LogFormat, Logger, LogLevel } from "@matter/main";

/** zigbee2mqtt's level names, by matter.js LogLevel (NOTICE has no zigbee2mqtt counterpart). */
const LEVEL_NAMES: Readonly<Record<number, string>> = {
    [LogLevel.DEBUG]: "debug",
    [LogLevel.INFO]: "info",
    [LogLevel.NOTICE]: "info",
    [LogLevel.WARN]: "warning",
    [LogLevel.ERROR]: "error",
    [LogLevel.FATAL]: "error",
};

const LEVELS_BY_NAME: Readonly<Record<string, LogLevel>> = {
    debug: LogLevel.DEBUG,
    info: LogLevel.INFO,
    warning: LogLevel.WARN,
    error: LogLevel.ERROR,
};

/**
 * Log facilities never forwarded: the broker link's own messages (a publish failing while the broker is
 * away) would be published over that same link, fail again and log again.
 */
const SILENT_FACILITIES = new Set(["MqttConnection"]);

const DESTINATION = "mqtt";

const plain = LogFormat("plain");

/** The zigbee2mqtt `bridge/logging` payload for a log message, or undefined when it is not forwarded. */
export function logPayloadOf(message: Diagnostic.Message): string | undefined {
    if (SILENT_FACILITIES.has(message.facility)) {
        return undefined;
    }
    return JSON.stringify({
        level: LEVEL_NAMES[message.level] ?? "info",
        message: plain(message.values),
        namespace: message.facility,
    });
}

/**
 * Forward server log messages at `level` and above to `publish` (zigbee2mqtt's `bridge/logging`) until the
 * returned function is called. `none`, or any unknown level, forwards nothing.
 */
export function forwardLogs(level: string, publish: (payload: string) => void): () => void {
    const threshold = LEVELS_BY_NAME[level];
    if (threshold === undefined) {
        return () => {};
    }
    let publishing = false;
    Logger.destinations[DESTINATION] = LogDestination({
        name: DESTINATION,
        level: threshold,
        add(message: Diagnostic.Message) {
            if (publishing || message.level < threshold) {
                return;
            }
            const payload = logPayloadOf(message);
            if (payload === undefined) {
                return;
            }
            // A message logged while publishing must not recurse into another publish
            publishing = true;
            try {
                publish(payload);
            } finally {
                publishing = false;
            }
        },
    });
    return () => {
        delete Logger.destinations[DESTINATION];
    };
}
