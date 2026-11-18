import {dayEnd, dayStart, localDate} from "./localDate.js";

export type OilPoint = {ts : number, litres : number};
export type OrderDelivery = {date : string, litres : number};          // from the account's oil orders
export type OilDay = {date : string, used : number};
export type Delivery = {ts : number, date : string, litres : number, fromOrder : boolean};
type Step = {from : number, to : number, used : number};

// A rise bigger than this between two readings is a delivery, not sensor noise.
export const deliveryThreshold = (capacity : number | null) => Math.max(100, 0.08 * (capacity ?? 0));

// The oil used between each pair of readings. Readings may be daily or weekly. Where the level rose by a delivery
// and the order says how much came, the use across that step is still known (before + delivered − after);
// a rise with no matching order is left out, as its use can't be told apart from the delivery.
const steps = (points : Array<OilPoint>, capacity : number | null, orders : Array<OrderDelivery>) => {
    const threshold = deliveryThreshold(capacity);
    const unmatched = [...orders];
    const out : Array<Step> = [];
    const deliveries : Array<Delivery> = [];
    for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1], cur = points[i];
        const rise = cur.litres - prev.litres;
        if (rise <= threshold) {
            out.push({from: prev.ts, to: cur.ts, used: -rise});
            continue;
        }
        const k = unmatched.findIndex((o) => o.date >= localDate(prev.ts) && o.date <= localDate(cur.ts));
        if (k >= 0) {
            const [order] = unmatched.splice(k, 1);
            deliveries.push({ts: dayStart(order.date) + 12 * 3600, date: order.date, litres: order.litres, fromOrder: true});
            out.push({from: prev.ts, to: cur.ts, used: Math.max(0, prev.litres + order.litres - cur.litres)});
        } else {
            deliveries.push({ts: cur.ts, date: localDate(cur.ts), litres: Math.round(rise), fromOrder: false});
        }
    }
    return {steps: out, deliveries};
};

// Litres used per day. A step spanning several days (weekly readings) is spread evenly over the time it covers.
// Each day's use is the net fall across it, so the small ups and downs between readings cancel out.
export const oilUsage = (points : Array<OilPoint>, capacity : number | null, orders : Array<OrderDelivery> = []) => {
    const {steps: all, deliveries} = steps(points, capacity, orders);
    const byDay = new Map<string, number>();
    for (const s of all) {
        if (s.to <= s.from) continue;
        for (let t = s.from; t < s.to;) {
            const date = localDate(t), end = Math.min(s.to, dayEnd(date));
            byDay.set(date, (byDay.get(date) ?? 0) + s.used * (end - t) / (s.to - s.from));
            t = end;
        }
    }
    const days : Array<OilDay> = [...byDay].sort(([a], [b]) => a.localeCompare(b))
        .map(([date, used]) => ({date, used: Math.round(Math.max(0, used) * 10) / 10}));
    return {days, deliveries};
};

// Litres used and the average per day from `from` to the latest reading. `days` is the time the readings actually
// cover in that window, so a period longer than the history says so. Null with under a day covered.
export const useSince = (points : Array<OilPoint>, capacity : number | null, from : number, orders : Array<OrderDelivery> = []) => {
    let used = 0, covered = 0;
    for (const s of steps(points, capacity, orders).steps) {
        const start = Math.max(s.from, from);
        if (s.to <= start || s.to <= s.from) continue;
        const share = (s.to - start) / (s.to - s.from);
        used += s.used * share;
        covered += s.to - start;
    }
    const days = covered / 86400;
    if (days < 1) return null;
    used = Math.max(0, used);
    return {used: Math.round(used), days: Math.round(days * 10) / 10, perDay: Math.round(used / days * 10) / 10};
};

// Average use per day over roughly the last `windowDays` of readings. Null until they cover two days.
export const recentRate = (points : Array<OilPoint>, capacity : number | null, windowDays = 14, orders : Array<OrderDelivery> = []) => {
    if (points.length < 2) return null;
    const result = useSince(points, capacity, points[points.length - 1].ts - windowDays * 86400, orders);
    return result && result.days >= 2 ? result.used / result.days : null;
};
