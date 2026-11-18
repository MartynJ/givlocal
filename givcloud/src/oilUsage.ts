import {localDate} from "./localDate.js";

export type OilPoint = {ts : number, litres : number};
export type OilDay = {date : string, used : number};
export type Delivery = {ts : number, date : string, litres : number};

// A rise bigger than this between two readings is a delivery, not sensor noise.
export const deliveryThreshold = (capacity : number | null) => Math.max(100, 0.08 * (capacity ?? 0));

// Litres used per day from a series of tank levels. The level drifts up and down a little from reading to reading
// (temperature, sensor noise), so each day's use is the net fall across it rather than the sum of every fall,
// which would count the noise. Big rises are deliveries and aren't counted as negative use.
export const oilUsage = (points : Array<OilPoint>, capacity : number | null) => {
    const threshold = deliveryThreshold(capacity);
    const byDay = new Map<string, number>();
    const deliveries : Array<Delivery> = [];
    for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1], cur = points[i];
        const date = localDate(cur.ts);
        const fall = prev.litres - cur.litres;
        if (-fall > threshold) {
            deliveries.push({ts: cur.ts, date, litres: Math.round(-fall)});
            byDay.set(date, byDay.get(date) ?? 0);
            continue;
        }
        byDay.set(date, (byDay.get(date) ?? 0) + fall);
    }
    const days : Array<OilDay> = [...byDay].sort(([a], [b]) => a.localeCompare(b))
        .map(([date, used]) => ({date, used: Math.round(Math.max(0, used) * 10) / 10}));
    return {days, deliveries};
};

// Average use per day over roughly the last `window` days, from the levels themselves (so days when the level
// didn't change still count), leaving out deliveries. Null until there's at least two days of readings.
export const recentRate = (points : Array<OilPoint>, capacity : number | null, windowDays = 14) => {
    if (points.length < 2) return null;
    const end = points[points.length - 1].ts, from = end - windowDays * 86400;
    const recent = points.filter((p) => p.ts >= from);
    const span = (end - recent[0].ts) / 86400;
    if (span < 2) return null;
    const threshold = deliveryThreshold(capacity);
    let used = 0;
    for (let i = 1; i < recent.length; i++) {
        const fall = recent[i - 1].litres - recent[i].litres;
        if (-fall <= threshold) used += fall;
    }
    return Math.max(0, used) / span;
};

// Litres used and the average per day from `from` to the latest reading, leaving out deliveries. The window is cut
// to the readings there are, so `days` says how much of it the figure really covers. Null with under a day of readings.
export const useSince = (points : Array<OilPoint>, capacity : number | null, from : number) => {
    const recent = points.filter((p) => p.ts >= from);
    if (recent.length < 2) return null;
    const days = (recent[recent.length - 1].ts - recent[0].ts) / 86400;
    if (days < 1) return null;
    const threshold = deliveryThreshold(capacity);
    let used = 0;
    for (let i = 1; i < recent.length; i++) {
        const fall = recent[i - 1].litres - recent[i].litres;
        if (-fall <= threshold) used += fall;
    }
    used = Math.max(0, used);
    return {used: Math.round(used), days: Math.round(days * 10) / 10, perDay: Math.round(used / days * 10) / 10};
};
