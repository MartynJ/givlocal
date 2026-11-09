import {Code} from "anbaric";
import type {HouseholdMonitor} from "./householdMonitor.js";
import {localDate, today} from "./localDate.js";
import {BatteryModule, Reading, ReadingExtra, readingColumns, ReadingStore} from "./readings.js";

const collector = new Code("home-collector");
const maxBatch = 500;
const oldestAcceptedSeconds = 90 * 86400;

const finiteOrNull = (value : unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const shortText = (value : unknown) => typeof value === "string" ? value.slice(0, 40) : undefined;
const numbers = (value : unknown, limit : number) =>
    Array.isArray(value) ? value.filter((v) : v is number => typeof v === "number" && Number.isFinite(v)).slice(0, limit) : [];

const toModules = (value : unknown) : Array<BatteryModule> | undefined => Array.isArray(value)
    ? value.slice(0, 8).map((m : any) => ({
        serial: shortText(m?.serial) ?? "", address: shortText(m?.address) ?? "",
        cells: numbers(m?.cells, 32), temps: numbers(m?.temps, 16), voltage: finiteOrNull(m?.voltage) ?? 0,
    }))
    : undefined;

export const toReading = (body : any, nowSeconds : number) : Omit<Reading, "day"> => {
    const ts = body?.ts;
    if (typeof ts !== "number" || ts > nowSeconds + 300 || ts < nowSeconds - oldestAcceptedSeconds) {
        throw new Error("each reading needs a ts (epoch seconds) within the last 90 days");
    }
    const extra : ReadingExtra = {
        status: shortText(body.status), fault_code: finiteOrNull(body.fault_code) ?? undefined,
        inverter_serial: shortText(body.inverter_serial), e_import_total: finiteOrNull(body.e_import_total) ?? undefined,
        e_export_total: finiteOrNull(body.e_export_total) ?? undefined,
        e_battery_throughput_total: finiteOrNull(body.e_battery_throughput_total) ?? undefined,
        modules: toModules(body.modules),
    };
    const reading : any = {ts, extra};
    for (const c of readingColumns) reading[c] = finiteOrNull(body[c]);
    if (reading.soc == null) throw new Error("each reading needs soc");
    return reading;
};

// Accepts one reading or a batch (the collector catches up after being offline).
export const acceptUpload = async (body : unknown, readings : ReadingStore, monitor : HouseholdMonitor) => {
    const batch = (Array.isArray(body) ? body : [body]).slice(0, maxBatch);
    const now = Date.now() / 1000;
    const parsed = batch.map((item) => toReading(item, now));
    let stored = 0;
    for (const reading of parsed) if (await readings.add(reading, collector)) stored++;
    for (const day of new Set(parsed.map((r) => localDate(r.ts)))) await monitor.ensureDay(day, collector);
    const newest = Math.max(...parsed.map((r) => r.ts));
    await monitor.endDaysBefore(today(), collector);
    if (now - newest < 3600) await monitor.check(collector);
    return {received: parsed.length, stored};
};
