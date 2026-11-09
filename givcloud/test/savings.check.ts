// A made-up day: the battery charges 10 kWh from the grid overnight at 6.6p and discharges 9 kWh during the
// day, covering the house; solar adds 3 kWh at midday, 1 kWh of which is exported at 15p. Readings stop for
// six hours in the middle of the day, which mustn't change the totals.
import {batteryEfficiency, daySavings, spreadCounter} from "../src/savings.js";
import {dayEnd, dayStart} from "../src/localDate.js";

const assert = (ok : boolean, what : string) => { console.log(ok ? "PASS" : "FAIL", what); if (!ok) process.exitCode = 1; };
const near = (a : number, b : number, eps = 0.01) => Math.abs(a - b) < eps;
const date = "2026-11-10", start = dayStart(date), end = dayEnd(date), h = (x : number) => start + x * 3600;

// Counters at each reading (kWh since midnight).
const at = (ts : number, pv : number, chg : number, dis : number) => ({ts, e_pv_day: pv, e_charge_day: chg, e_discharge_day: dis} as any);
const readings = [
    at(h(1), 0, 2, 0), at(h(5.5), 0, 10, 0), at(h(9), 0, 10, 2),
    /* gap 09:00–15:00 */ at(h(15), 3, 10, 6), at(h(23.5), 3, 10, 9),
];
const nightImports = [];
for (let t = h(0); t < h(5.5); t += 1800) nightImports.push({start: t, kwh: 10 / 11 / batteryEfficiency + 0.1});   // battery + 0.1 kWh house
const exports = [{start: h(12), kwh: 1}];
const night = (t : number) => { const m = ((t - start) / 60) % 1440; return m < 330 || m >= 1410; };
const rateAt = (t : number) => night(t) ? 6.6 : 36.48;
const importKwh = nightImports.reduce((s, r) => s + r.kwh, 0);
const actual = importKwh * 6.6 / 100 + 0.52 - 1 * 15 / 100;
const r = daySavings({start, end, readings, imports: nightImports, exports, rateAt, standingCharge: 0.52, actualNetCost: actual});

const pv = spreadCounter(readings, start, end, "e_pv_day");
assert(near(pv.slots.reduce((a, b) => a + b, 0), 3), "solar spread across the gap still totals 3 kWh");
const expectedHome = 11 * 0.1 + 9 * batteryEfficiency + 3 - 1;
assert(near(r.homeKwh, expectedHome), `house used ${r.homeKwh.toFixed(2)} kWh (expected ${expectedHome.toFixed(2)})`);
const expectedWithout = (11 * 0.1 * 6.6 + (9 * batteryEfficiency + 2) * 36.48) / 100 + 0.52;
assert(near(r.withoutSystemCost, expectedWithout), `without the system £${r.withoutSystemCost.toFixed(2)} (expected £${expectedWithout.toFixed(2)})`);
assert(near(r.savings, expectedWithout - actual), `saved £${r.savings.toFixed(2)}`);
assert(near(r.coverage, 23.5 / 24, 0.001), "coverage runs to the last reading");
