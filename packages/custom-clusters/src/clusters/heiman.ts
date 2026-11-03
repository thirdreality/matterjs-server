/**
 * @license
 * Copyright 2025-2026 Open Home Foundation
 * SPDX-License-Identifier: Apache-2.0
 */

import { attribute, cluster, uint8, writable, command, uint16, field, mandatory } from "@matter/main/model";

/**
 * Input to the {@link HeimanCluster.mutingSensor} command.
 */
class MutingSensorCommand {
    @field(0x0, uint16, mandatory)
    mutingTime!: number;
}

/**
 * Input to the {@link HeimanCluster.sirenActivate} command.
 */
class SirenActivateCommand {
    /** 0 default, 1 smoke, 2 CO, 3 gas, 4 doorbell, 5 heat alarm. */
    @field(0x0, uint8, mandatory)
    sirenType!: number;

    /** 0 to 100. Models without volume control ignore the value. */
    @field(0x1, uint8, mandatory)
    volume!: number;

    /** 0 stops the siren, 1 to 0xfffe sounds it for that duration, 0xffff sounds it until stopped. */
    @field(0x2, uint16, mandatory)
    duration!: number;
}

@cluster(0x120bfc01)
export class HeimanCluster {
    @attribute(0x0010, uint8)
    tamperAlarm?: number;

    @attribute(0x0011, uint8)
    preheatingState?: number;

    @attribute(0x0012, uint8)
    noDisturbingState?: number;

    @attribute(0x0013, uint8)
    sensorType?: number;

    @attribute(0x0014, uint8, writable)
    sirenActive?: number;

    @attribute(0x0015, uint8, writable)
    alarmMute?: number;

    @attribute(0x0016, uint8, writable)
    lowPowerMode?: number;

    @attribute(0x1004, uint8, writable)
    indicatorEnable?: number;

    /**
     * This command is used for muting sensor for a specific period if there is an alarm, like a fire alarm.
     */
    @command(0x00, MutingSensorCommand)
    mutingSensor(_request: MutingSensorCommand): void {}

    /**
     * Sounds or stops the sensor's siren.
     */
    @command(0x01, SirenActivateCommand)
    sirenActivate(_request: SirenActivateCommand): void {}
}
