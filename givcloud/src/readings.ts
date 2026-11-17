import {Actor, SqlStore} from "anbaric";
import {localDate} from "./localDate.js";

export const readingColumns = [
    "soc", "p_battery", "p_grid", "p_load", "p_pv", "p_inverter", "v_ac", "f_ac", "v_battery", "i_battery",
    "t_battery", "t_inverter", "e_import_day", "e_export_day", "e_charge_day", "e_discharge_day", "e_pv_day",
] as const;

export type Reading = {ts : number, day : string, extra : ReadingExtra} & Record<typeof readingColumns[number], number | null>;

export type BatteryModule = {serial : string, address : string, cells : Array<number>, temps : Array<number>, voltage : number};

export type ReadingExtra = {
    status? : string,
    fault_code? : number,
    inverter_serial? : string,
    e_import_total? : number,
    e_export_total? : number,
    e_battery_throughput_total? : number,
    modules? : Array<BatteryModule>,
};

// Limits no real reading from this kind of system can exceed. Now and then the dongle sends a garbled reply, and a
// single impossible value (a 3,000 kWh day counter, say) would otherwise swamp a day's totals and savings.
const limits : Partial<Record<typeof readingColumns[number], [number, number]>> = {
    soc: [0, 100],
    p_battery: [-20000, 20000], p_grid: [-30000, 30000], p_load: [0, 30000], p_pv: [0, 30000], p_inverter: [-20000, 20000],
    t_battery: [-40, 90], t_inverter: [-40, 120],
    e_import_day: [0, 300], e_export_day: [0, 300], e_charge_day: [0, 300], e_discharge_day: [0, 300], e_pv_day: [0, 300],
};

export const isPlausible = (reading : Partial<Record<typeof readingColumns[number], number | null>>) =>
    Object.entries(limits).every(([column, [low, high]]) => {
        const v = reading[column as typeof readingColumns[number]];
        return v == null || (v >= low && v <= high);
    });

const usesPostgres = ["cloud", "postgres"].includes(process.env.ANBARIC_SQL_STORE_TYPE ?? "");

// Statements are written with `?`; Postgres wants `$1, $2, …`.
const portable = (sql : string) => {
    let n = 0;
    return usesPostgres ? sql.replace(/\?/g, () => `$${++n}`) : sql;
};

const toNumber = (value : unknown) : number | null => {
    const n = typeof value === "string" ? Number(value) : value;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
};

export class ReadingStore {
    constructor(private readonly sql : SqlStore, private readonly actor : Actor) {}

    async prepare() {
        await this.sql.execute(this.actor, `CREATE TABLE IF NOT EXISTS givlocal_readings (
            ts BIGINT PRIMARY KEY,
            day TEXT NOT NULL,
            ${readingColumns.map((c) => `${c} DOUBLE PRECISION`).join(", ")},
            extra TEXT
        )`);
        await this.sql.execute(this.actor, "CREATE INDEX IF NOT EXISTS givlocal_readings_day ON givlocal_readings (day)");
    }

    // Returns true when the reading was new (the collector may resend after a dropped connection).
    async add(reading : Omit<Reading, "day">, actor : Actor) : Promise<boolean> {
        const values = [Math.round(reading.ts), localDate(reading.ts), ...readingColumns.map((c) => toNumber(reading[c])),
            JSON.stringify(reading.extra ?? {})];
        const inserted = await this.sql.execute(actor, portable(
            `INSERT INTO givlocal_readings (ts, day, ${readingColumns.join(", ")}, extra)
             VALUES (${values.map(() => "?").join(", ")}) ON CONFLICT (ts) DO NOTHING`), values);
        return inserted > 0;
    }

    async latest() : Promise<Reading | undefined> {
        const rows = await this.sql.query(this.actor, "SELECT * FROM givlocal_readings ORDER BY ts DESC LIMIT 5");
        return rows.map((row) => this.hydrate(row)).find(isPlausible);
    }

    async forDay(day : string) : Promise<Array<Reading>> {
        const rows = await this.sql.query(this.actor, portable("SELECT * FROM givlocal_readings WHERE day = ? ORDER BY ts"), [day]);
        return rows.map((row) => this.hydrate(row)).filter(isPlausible);
    }

    async between(fromDay : string, toDay : string) : Promise<Array<Reading>> {
        const rows = await this.sql.query(this.actor,
            portable("SELECT * FROM givlocal_readings WHERE day >= ? AND day <= ? ORDER BY ts"), [fromDay, toDay]);
        return rows.map((row) => this.hydrate(row)).filter(isPlausible);
    }

    async count() : Promise<number> {
        const rows = await this.sql.query(this.actor, "SELECT COUNT(*) AS n FROM givlocal_readings");
        return Number(rows[0]?.n ?? 0);
    }

    private hydrate(row : Record<string, any>) : Reading {
        const reading : any = {ts: Number(row.ts), day: row.day, extra: row.extra ? JSON.parse(row.extra) : {}};
        for (const c of readingColumns) reading[c] = toNumber(row[c]);
        return reading;
    }
}
