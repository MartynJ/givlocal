import {Actor, SqlStore} from "anbaric";
import {localDate} from "./localDate.js";

export type Direction = "import" | "export";

const usesPostgres = ["cloud", "postgres"].includes(process.env.ANBARIC_SQL_STORE_TYPE ?? "");
const portable = (sql : string) => {
    let n = 0;
    return usesPostgres ? sql.replace(/\?/g, () => `$${++n}`) : sql;
};

// Half-hourly readings from the billing meter, as Octopus reports them (a day or so behind).
export class MeterIntervals {
    constructor(private readonly sql : SqlStore, private readonly actor : Actor) {}

    async prepare() {
        await this.sql.execute(this.actor, `CREATE TABLE IF NOT EXISTS octopus_intervals (
            start_ts BIGINT NOT NULL, direction TEXT NOT NULL, day TEXT NOT NULL, kwh DOUBLE PRECISION NOT NULL,
            PRIMARY KEY (start_ts, direction))`);
        await this.sql.execute(this.actor, "CREATE INDEX IF NOT EXISTS octopus_intervals_day ON octopus_intervals (day)");
    }

    async save(direction : Direction, intervals : Array<{start : number, kwh : number}>, actor : Actor) {
        for (const {start, kwh} of intervals) {
            await this.sql.execute(actor, portable(`INSERT INTO octopus_intervals (start_ts, direction, day, kwh) VALUES (?, ?, ?, ?)
                ON CONFLICT (start_ts, direction) DO UPDATE SET kwh = excluded.kwh`), [start, direction, localDate(start), kwh]);
        }
    }

    async forDay(day : string, direction : Direction) : Promise<Array<{start : number, kwh : number}>> {
        const rows = await this.sql.query(this.actor, portable(
            "SELECT start_ts, kwh FROM octopus_intervals WHERE day = ? AND direction = ? ORDER BY start_ts"), [day, direction]);
        return rows.map((r) => ({start: Number(r.start_ts), kwh: Number(r.kwh)}));
    }
}
