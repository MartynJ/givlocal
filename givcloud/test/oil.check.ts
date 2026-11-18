// Checks reading BoilerJuice's tank page and working out oil use from a series of levels.
import {parseTankPage, tankIdsOnPage} from "../src/oilClient.js";
import {oilUsage, recentRate} from "../src/oilUsage.js";
import {samplePage} from "./oilFixtures.js";

let failed = 0;
const check = (name : string, ok : boolean, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
    if (!ok) failed++;
};

const r = parseTankPage(samplePage(1050, 1150));
check("usable litres", r.litres === 1050, String(r.litres));
check("total litres", r.totalLitres === 1150, String(r.totalLitres));
check("percentages", r.percent === 86 && r.totalPercent === 94, `${r.percent} / ${r.totalPercent}`);
check("capacity (value before title)", r.capacity === 1225, String(r.capacity));
check("level name", r.levelName === "Medium", String(r.levelName));
let threw = false;
try { parseTankPage("<html><body>Sign in</body></html>"); } catch { threw = true; }
check("a page without a level is refused", threw);
check("tank ids from links", JSON.stringify(tankIdsOnPage(`<a href="/uk/users/tanks/123/edit">a</a> <a href="/uk/users/tanks/123">b</a> <a href='/uk/users/tanks/456/edit'>c</a>`)) === '["123","456"]');

// A week: about 10 litres a day, with ±2 litres of noise every 3 hours, and a 500-litre delivery on day 4.
const start = Date.UTC(2026, 10, 2, 0, 30) / 1000;
const points = [];
let level = 600;
for (let i = 0; i <= 7 * 8; i++) {
    if (i === 4 * 8 + 3) level += 500;
    level -= 10 / 8;
    points.push({ts: start + i * 3 * 3600, litres: level + (i % 2 ? 2 : -2)});
}
const {days, deliveries} = oilUsage(points, 1225);
check("one delivery found", deliveries.length === 1 && Math.abs(deliveries[0].litres - 495) < 10, JSON.stringify(deliveries));
const full = days.filter((d) => d.date > "2026-11-02" && d.date < "2026-11-09");
const total = full.reduce((s, d) => s + d.used, 0);
check("daily use is about 10 litres, noise cancelled", full.every((d) => Math.abs(d.used - 10) <= 1.5 || d.date === deliveries[0].date),
    full.map((d) => `${d.date.slice(5)}:${d.used}`).join(" "));
check("delivery day doesn't count the delivery as use (within the noise)", (days.find((d) => d.date === deliveries[0].date)?.used ?? 99) < 15);
const rate = recentRate(points, 1225);
check("recent rate about 10 a day", rate != null && Math.abs(rate - 10) < 1, rate?.toFixed(2));
check("no rate from under two days", recentRate(points.slice(0, 10), 1225) === null);
check("a lower level is never negative use", oilUsage([{ts: start, litres: 500}, {ts: start + 3600, litres: 520}], 1225).days.every((d) => d.used >= 0));

process.exit(failed ? 1 : 0);
