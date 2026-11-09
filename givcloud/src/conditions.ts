import type {AlertKind} from "./alerts.js";
import type {Reading} from "./readings.js";

export const offlineAfterSeconds = 20 * 60;
const maxCellSpreadMv = 100;
const batteryTempRange = [2, 45];

// What is wrong right now, judged from the latest reading.
export const activeConditions = (latest : Reading | undefined, nowSeconds : number) : Map<AlertKind, string> => {
    const conditions = new Map<AlertKind, string>();
    if (!latest) return conditions;

    const age = nowSeconds - latest.ts;
    if (age > offlineAfterSeconds) {
        conditions.set("collector-offline", `No readings from home for ${Math.round(age / 60)} minutes`);
        return conditions;   // the other checks would be judging stale data
    }
    const {fault_code, status, modules} = latest.extra;
    if ((fault_code ?? 0) !== 0 || (status && !["Normal", "Waiting"].includes(status))) {
        conditions.set("inverter-fault", `Inverter reports ${status ?? "a problem"}${fault_code ? ` (fault code ${fault_code})` : ""}`);
    }
    const cells = (modules ?? []).flatMap((m) => m.cells);
    if (cells.length) {
        const spreadMv = Math.round((Math.max(...cells) - Math.min(...cells)) * 1000);
        if (spreadMv > maxCellSpreadMv) conditions.set("cell-imbalance", `Cell spread is ${spreadMv} mV (over ${maxCellSpreadMv} mV)`);
    }
    const t = latest.t_battery;
    if (t != null && (t < batteryTempRange[0] || t > batteryTempRange[1])) {
        conditions.set("battery-temperature", `Battery is at ${t.toFixed(1)} °C (outside ${batteryTempRange[0]}–${batteryTempRange[1]} °C)`);
    }
    return conditions;
};
