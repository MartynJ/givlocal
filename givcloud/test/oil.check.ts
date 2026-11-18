// Checks reading BoilerJuice's tank page and working out oil use from a series of levels.
import {parseOrdersPage, parseTankPage, tankIdsOnPage} from "../src/oilClient.js";
import {oilUsage, recentRate, useSince} from "../src/oilUsage.js";
import {connectedTankPage, ordersPage, samplePage} from "./oilFixtures.js";

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


// The real pages, as found on a BoilerJuice account.
const c = parseTankPage(connectedTankPage(620, 1120));
check("connected tank: usable, total, both percentages and size", c.litres === 620 && c.totalLitres === 1120 && c.percent === 25 && c.totalPercent === 45 && c.capacity === 2500, JSON.stringify(c));
const e = parseTankPage(`<div id="usable-oil"><p>We estimate that you have 1120 litres of oil left in your tank.</p><div data-percentage="45"></div></div><input value="2500" class="form-control" type="text" name="tank_size" id="tank_size" />`);
check("tank page without a monitor: one gauge is all the oil", e.litres === null && e.totalLitres === 1120 && e.totalPercent === 45 && e.percent === null && e.capacity === 2500, JSON.stringify(e));
const orders = parseOrdersPage(ordersPage);
check("two oil orders, shop order left out", orders.length === 2, JSON.stringify(orders.map((o) => o.order)));
check("order details", orders[0].delivered === "2026-09-23" && orders[0].litres === 500 && orders[0].pencePerLitre === 107.95
    && orders[1].ordered === "2026-02-28" && orders[1].litres === 1000, JSON.stringify(orders));

const since = useSince(points, 1225, start + 4 * 86400);
check("average over a period leaves out the delivery", since != null && Math.abs(since.perDay - 10) < 1.5, JSON.stringify(since));
check("no average from under a day", useSince(points, 1225, points[points.length - 3].ts) === null);


// Weekly readings copied from BoilerJuice's app, with the 500-litre delivery on 23 Sep from the orders.
const { dayStart } = await import("../src/localDate.js");
const weekly = [["2026-09-14", 880], ["2026-09-21", 870], ["2026-09-28", 1320], ["2026-10-05", 1320], ["2026-10-12", 1300],
    ["2026-10-26", 1260], ["2026-11-02", 1240], ["2026-11-09", 1190], ["2026-11-16", 1130]]
    .map(([d, l]) => ({ts: dayStart(d as string) + 43200, litres: l as number}));
const sepOrder = [{date: "2026-09-23", litres: 500}];
const w = oilUsage(weekly, 2500, sepOrder);
check("delivery taken from the order", w.deliveries.length === 1 && w.deliveries[0].fromOrder && w.deliveries[0].litres === 500, JSON.stringify(w.deliveries));
const sepWeek = useSince(weekly.slice(1, 3), 2500, 0, sepOrder)!.used;
check("delivery week's use allowed for: 870 + 500 − 1320 = 50", Math.abs(sepWeek - 50) < 1, sepWeek.toFixed(1));
const novDay = w.days.find((d) => d.date === "2026-11-05")?.used;
check("a week's fall spread over its days (50 litres / 7)", novDay != null && Math.abs(novDay - 50 / 7) < 0.2, String(novDay));
const sinceDelivery = useSince(weekly, 2500, dayStart("2026-09-23"), sepOrder);
check("since the delivery: 1370 − 1130 over 54 days", sinceDelivery != null && Math.abs(sinceDelivery.used - (870 + 500 - 1130) * (5 / 7) - 0) < 60
    && sinceDelivery.days > 50 && sinceDelivery.days < 56, JSON.stringify(sinceDelivery));
const noOrder = oilUsage(weekly, 2500);
check("without the order, the delivery week is left out rather than guessed",
    noOrder.deliveries[0].fromOrder === false && !noOrder.days.some((d) => d.date === "2026-09-24"), JSON.stringify(noOrder.deliveries));

process.exit(failed ? 1 : 0);
