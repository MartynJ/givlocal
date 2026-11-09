import type {Reading} from "./readings.js";

// One-way efficiency between the house's AC supply and the battery, measured from this inverter's own
// counters (energy in/out at the AC side against energy charged/discharged): about 3% lost each way.
export const batteryEfficiency = 0.97;
const slot = 1800;

type Counter = "e_pv_day" | "e_charge_day" | "e_discharge_day";

// The inverter's day counters run up from zero at midnight, so the energy between any two readings is known
// exactly even across a gap; within a gap it is spread evenly over the half hours the gap covers.
export const spreadCounter = (readings : Array<Reading>, start : number, end : number, counter : Counter) => {
    const slots = new Array<number>(Math.round((end - start) / slot)).fill(0);
    let prev = {ts: start, v: 0};
    for (const r of readings) {
        const v = r[counter];
        if (v == null || r.ts < start || r.ts >= end) continue;
        if (v < prev.v) { prev = {ts: r.ts, v}; continue; }       // a glitch or a late reset: start again from here
        const delta = v - prev.v, span = r.ts - prev.ts;
        if (span <= 0) slots[Math.min(slots.length - 1, Math.floor((r.ts - start) / slot))] += delta;
        else {
            for (let i = Math.floor((prev.ts - start) / slot); i < slots.length && start + i * slot < r.ts; i++) {
                const overlap = Math.min(r.ts, start + (i + 1) * slot) - Math.max(prev.ts, start + i * slot);
                if (overlap > 0) slots[i] += delta * overlap / span;
            }
        }
        prev = {ts: r.ts, v};
    }
    return {slots, coveredUntil: prev.ts};
};

export type SavingsInput = {
    start : number, end : number, readings : Array<Reading>,
    imports : Array<{start : number, kwh : number}>, exports : Array<{start : number, kwh : number}>,
    rateAt : (epochSeconds : number) => number | null,   // import unit rate, pence per kWh
    standingCharge : number,                             // pounds per day
    actualNetCost : number,                              // pounds: import + standing − export earnings
};

// What the day would have cost if everything the house used had come from the grid at the same tariff,
// and how much less it actually cost with the solar panels and battery.
export const daySavings = (input : SavingsInput) => {
    const {start, end, readings} = input;
    const pv = spreadCounter(readings, start, end, "e_pv_day");
    const charge = spreadCounter(readings, start, end, "e_charge_day");
    const discharge = spreadCounter(readings, start, end, "e_discharge_day");
    const coveredUntil = Math.min(pv.coveredUntil, charge.coveredUntil, discharge.coveredUntil);
    const coverage = (coveredUntil - start) / (end - start);

    const byStart = (rows : Array<{start : number, kwh : number}>) => new Map(rows.map((r) => [Math.round(r.start), r.kwh]));
    const imp = byStart(input.imports), exp = byStart(input.exports);
    let homeKwh = 0, pence = 0;
    for (let i = 0; i < pv.slots.length; i++) {
        const t = start + i * slot;
        // Not clamped at zero: within a reading gap, energy is spread evenly, so a single half hour can come out
        // slightly negative, but the day's total stays exact.
        const home = (imp.get(t) ?? 0) - (exp.get(t) ?? 0) + pv.slots[i]
            + discharge.slots[i] * batteryEfficiency - charge.slots[i] / batteryEfficiency;
        homeKwh += home;
        pence += home * (input.rateAt(t) ?? 0);
    }
    const withoutSystemCost = pence / 100 + input.standingCharge;
    return {homeKwh, withoutSystemCost, savings: withoutSystemCost - input.actualNetCost, coverage, coveredUntil};
};
