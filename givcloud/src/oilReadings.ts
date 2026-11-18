import {Actor, SqlStore} from "anbaric";
import type {OilOrder, TankReading} from "./oilClient.js";

const usesPostgres = ["cloud", "postgres"].includes(process.env.ANBARIC_SQL_STORE_TYPE ?? "");
const portable = (sql : string) => {
    let n = 0;
    return usesPostgres ? sql.replace(/\?/g, () => `$${++n}`) : sql;
};
const toNumber = (v : unknown) => {
    const n = typeof v === "string" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
};

export type StoredOilReading = TankReading & {ts : number};

// Each tank level read from BoilerJuice.
export class OilReadings {
    constructor(private readonly sql : SqlStore, private readonly actor : Actor) {}

    async prepare() {
        await this.sql.execute(this.actor, `CREATE TABLE IF NOT EXISTS oil_readings (
            ts BIGINT PRIMARY KEY, litres DOUBLE PRECISION, total_litres DOUBLE PRECISION, percent DOUBLE PRECISION,
            total_percent DOUBLE PRECISION, capacity DOUBLE PRECISION, level_name TEXT)`);
        await this.sql.execute(this.actor, `CREATE TABLE IF NOT EXISTS oil_orders (
            order_no TEXT PRIMARY KEY, ordered TEXT NOT NULL, delivered TEXT, litres DOUBLE PRECISION NOT NULL,
            pence_per_litre DOUBLE PRECISION, status TEXT)`);
    }

    // Orders as BoilerJuice lists them; a later read updates the status and delivery date.
    async saveOrders(orders : Array<OilOrder>, actor : Actor) {
        for (const o of orders) {
            await this.sql.execute(actor, portable(`INSERT INTO oil_orders (order_no, ordered, delivered, litres, pence_per_litre, status)
                VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (order_no) DO UPDATE SET delivered = excluded.delivered, litres = excluded.litres,
                pence_per_litre = excluded.pence_per_litre, status = excluded.status`),
                [o.order, o.ordered, o.delivered, o.litres, o.pencePerLitre, o.status]);
        }
    }

    async orders() : Promise<Array<OilOrder>> {
        const rows = await this.sql.query(this.actor, "SELECT * FROM oil_orders ORDER BY ordered");
        return rows.map((r) => ({order: String(r.order_no), ordered: r.ordered, delivered: r.delivered ?? null,
            litres: Number(r.litres), pencePerLitre: toNumber(r.pence_per_litre), status: r.status ?? ""}));
    }

    async add(ts : number, r : TankReading, actor : Actor) {
        await this.sql.execute(actor, portable(`INSERT INTO oil_readings (ts, litres, total_litres, percent, total_percent, capacity, level_name)
            VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (ts) DO NOTHING`),
            [Math.round(ts), r.litres, r.totalLitres, r.percent, r.totalPercent, r.capacity, r.levelName]);
    }

    async since(ts : number) : Promise<Array<StoredOilReading>> {
        const rows = await this.sql.query(this.actor, portable("SELECT * FROM oil_readings WHERE ts >= ? ORDER BY ts"), [Math.round(ts)]);
        return rows.map((r) => ({
            ts: Number(r.ts), litres: toNumber(r.litres), totalLitres: toNumber(r.total_litres), percent: toNumber(r.percent),
            totalPercent: toNumber(r.total_percent), capacity: toNumber(r.capacity), levelName: r.level_name ?? null,
        }));
    }

    async latest() : Promise<StoredOilReading | undefined> {
        const rows = await this.sql.query(this.actor, "SELECT ts FROM oil_readings ORDER BY ts DESC LIMIT 1");
        return rows.length ? (await this.since(Number(rows[0].ts)))[0] : undefined;
    }
}
