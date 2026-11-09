import type {Reading} from "./readings.js";

export const readingIntervalSeconds = 300;

export type DayTotals = {
    importKwh : number | null, exportKwh : number | null, chargeKwh : number | null, dischargeKwh : number | null,
    pvKwh : number | null, homeKwh : number, socMin : number | null, socMax : number | null, samples : number, coverage : number,
};

// The inverter's own day counters only go up, so the day's figure is their maximum.
// House use isn't counted by the inverter, so it is integrated from the load readings.
export const dayTotals = (readings : Array<Reading>) : DayTotals => {
    const max = (key : keyof Reading) => {
        const values = readings.map((r) => r[key]).filter((v) : v is number => typeof v === "number");
        return values.length ? Math.round(Math.max(...values) * 100) / 100 : null;
    };
    let homeKwh = 0;
    for (let i = 1; i < readings.length; i++) {
        const a = readings[i - 1], b = readings[i], dt = b.ts - a.ts;
        if (dt > 0 && dt <= readingIntervalSeconds * 3 && a.p_load != null && b.p_load != null) {
            homeKwh += (a.p_load + b.p_load) / 2 * dt / 3_600_000;
        }
    }
    const socs = readings.map((r) => r.soc).filter((v) : v is number => v != null);
    return {
        importKwh: max("e_import_day"), exportKwh: max("e_export_day"), chargeKwh: max("e_charge_day"),
        dischargeKwh: max("e_discharge_day"), pvKwh: max("e_pv_day"), homeKwh: Math.round(homeKwh * 100) / 100,
        socMin: socs.length ? Math.min(...socs) : null, socMax: socs.length ? Math.max(...socs) : null,
        samples: readings.length, coverage: Math.min(1, Math.round(readings.length * readingIntervalSeconds / 864) / 100),
    };
};
