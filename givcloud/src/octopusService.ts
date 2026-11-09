import {Actor, Code, Human, SecretStore, StateMachine} from "anbaric";
import type {HouseholdMonitor} from "./householdMonitor.js";
import {addDays, dayEnd, dayStart, localDate, today} from "./localDate.js";
import type {Direction, MeterIntervals} from "./meterIntervals.js";
import type {ReadingStore} from "./readings.js";
import {daySavings} from "./savings.js";
import {Account, krakenApiBase, OctopusClient, OctopusError, rateAt, unitRates} from "./octopusClient.js";

const keyName = "octopus-api-key";
const backfillDays = 30;
const giveUpAfterDays = 7;          // cost a day with whatever readings arrived once it is this old
const syncer = new Code("octopus");
const round = (n : number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

export type Link = {accountNumber : string, importMpan : string, importSerial : string, exportMpan : string | null,
    exportSerial : string | null, deviceId : string | null, tariff : string | null};

// Everything that talks to Octopus: the key in the secret store, finding the meters, fetching readings,
// costing days and the near-live Home Mini readings. The two state machines call into this.
export class OctopusService {
    linkMachine! : StateMachine;
    daysMachine! : StateMachine;
    private client? : {key : string, api : OctopusClient};
    private accountCache? : {at : number, number : string, account : Account};
    private liveCache? : {at : number, value : unknown};
    private names = new Map<string, string>();
    private queue : Promise<unknown> = Promise.resolve();

    constructor(private readonly secrets : SecretStore, private readonly intervals : MeterIntervals, private readonly readings : ReadingStore,
                private readonly monitor : HouseholdMonitor, private readonly reader : Actor) {}

    attach(linkMachine : StateMachine, daysMachine : StateMachine) {
        this.linkMachine = linkMachine;
        this.daysMachine = daysMachine;
    }

    private async api() : Promise<OctopusClient> {
        let key : string;
        try { key = await this.secrets.retrieve(keyName, this.reader); }
        catch { throw new OctopusError("No Octopus API key has been entered"); }
        if (this.client?.key !== key) this.client = {key, api: new OctopusClient(key)};
        return this.client.api;
    }

    // ---- the link job

    async currentLink() {
        const jobs = await this.monitor.jobs("octopus-link", ["awaiting-key", "finding-meters", "linked"]);
        return jobs[0];
    }

    async linked() : Promise<Link | undefined> {
        const current = await this.currentLink();
        if (current?.job.state !== "linked") return undefined;
        return Object.fromEntries(["accountNumber", "importMpan", "importSerial", "exportMpan", "exportSerial", "deviceId", "tariff"]
            .map((k) => [k, current.props.get(k) ?? null])) as Link;
    }

    async ensureLinkJob(actor : Actor) {
        return (await this.currentLink())?.job ?? await this.linkMachine.startJob(new Map(), actor);
    }

    async saveKey(apiKey : string, person : Human) {
        const current = await this.currentLink();
        if (current?.job.state === "finding-meters") throw new OctopusError("Still checking the last key – try again in a moment");
        if (current?.job.state === "linked") await this.linkMachine.updateJob(current.job.id, new Map([["disconnect", true]]), person);
        await this.secrets.delete(keyName, person).catch(() => undefined);
        await this.secrets.create(person, keyName, apiKey);
        const job = current?.job.state === "awaiting-key" ? current.job : await this.linkMachine.startJob(new Map(), person);
        await this.linkMachine.updateJob(job.id, new Map([["keySaved", true]]), person);
        return job.id;
    }

    async disconnect(person : Human) {
        const current = await this.currentLink();
        await this.secrets.delete(keyName, person).catch(() => undefined);
        this.client = undefined;
        this.accountCache = undefined;
        if (current?.job.state === "linked") await this.linkMachine.updateJob(current.job.id, new Map([["disconnect", true]]), person);
        await this.linkMachine.startJob(new Map(), person);
    }

    // ---- discovery

    private async account(number : string) : Promise<Account> {
        if (this.accountCache?.number === number && Date.now() - this.accountCache.at < 3_600_000) return this.accountCache.account;
        const account = await (await this.api()).account(number);
        this.accountCache = {at: Date.now(), number, account};
        return account;
    }

    private static tariffOn(points : Account["properties"][number]["electricity_meter_points"], mpan : string, epochSeconds : number) : string | null {
        const t = epochSeconds * 1000;
        const agreement = points.find((p) => p.mpan === mpan)?.agreements.find((a) =>
            (!a.valid_from || Date.parse(a.valid_from) <= t) && (!a.valid_to || t < Date.parse(a.valid_to)));
        return agreement?.tariff_code ?? null;
    }

    private static points(account : Account) {
        const current = account.properties.filter((p) => !p.moved_out_at);
        return (current.length ? current : account.properties).flatMap((p) => p.electricity_meter_points ?? []);
    }

    async discover() : Promise<Link> {
        const api = await this.api();
        const numbers = await api.accountNumbers();
        if (!numbers.length) throw new OctopusError("That key has no Octopus accounts");
        for (const accountNumber of numbers) {
            const account = await api.account(accountNumber);
            const points = OctopusService.points(account);
            const now = Date.now() / 1000;
            const importPoint = points.find((p) => !p.is_export && OctopusService.tariffOn(points, p.mpan, now))
                ?? points.find((p) => !p.is_export);
            if (!importPoint) continue;
            const exportPoint = points.find((p) => p.is_export);
            const active = await api.activeMeters(accountNumber).catch(() => []);
            const serialFor = (p : typeof importPoint) => active.find((m) => m.mpan === p.mpan)?.serialNumber
                ?? p.meters.at(-1)?.serial_number ?? null;
            const devices = active.find((m) => m.mpan === importPoint.mpan)?.deviceIds ?? [];
            const importSerial = serialFor(importPoint);
            if (!importSerial) throw new OctopusError("Found the account but not its electricity meter's serial number");
            this.accountCache = {at: Date.now(), number: accountNumber, account};
            return {
                accountNumber, importMpan: importPoint.mpan, importSerial,
                exportMpan: exportPoint?.mpan ?? null, exportSerial: exportPoint ? serialFor(exportPoint) : null,
                deviceId: (devices.find((d) => d.type.toUpperCase() === "ESME") ?? devices[0])?.deviceId ?? null,
                tariff: OctopusService.tariffOn(points, importPoint.mpan, now),
            };
        }
        throw new OctopusError("Found the account but no electricity meter on it");
    }

    // ---- hourly sync: open a job for each finished day, fetch readings, mark days whose readings are all in

    syncSoon() {
        setTimeout(() => this.sync(syncer).catch((e) => console.error("octopus sync", e)), 3000);
    }

    sync(actor : Actor) : Promise<{daysOpened : number, daysComplete : number, problem : string | null}> {
        const run = this.queue.then(() => this.syncNow(actor));
        this.queue = run.catch(() => undefined);
        return run;
    }

    private async syncNow(actor : Actor) {
        const link = await this.linked();
        if (!link) return {daysOpened: 0, daysComplete: 0, problem: null};
        try {
            const api = await this.api();
            const all = await this.monitor.jobs("meter-days", ["awaiting-meter-data", "costing", "costed"]);
            const known = new Set(all.map(({props}) => props.get("date")));
            let daysOpened = 0;
            for (let d = addDays(today(), -backfillDays); d < today(); d = addDays(d, 1)) {
                if (known.has(d)) continue;
                await this.daysMachine.startJob(new Map([["date", d]]), actor);
                daysOpened++;
            }
            const waiting = (await this.monitor.jobs("meter-days", ["awaiting-meter-data"]))
                .map(({job, props}) => ({job, date: props.get("date") as string}));
            if (!waiting.length) return {daysOpened, daysComplete: 0, problem: null};

            const from = new Date(dayStart(waiting.map((w) => w.date).sort()[0]) * 1000), to = new Date();
            const fetchInto = async (direction : Direction, mpan : string | null, serial : string | null) => {
                if (!mpan || !serial) return;
                const rows = await api.consumption(mpan, serial, from, to);
                await this.intervals.save(direction, rows.map((r) => ({start: Date.parse(r.interval_start) / 1000, kwh: r.consumption})), actor);
            };
            await fetchInto("import", link.importMpan, link.importSerial);
            await fetchInto("export", link.exportMpan, link.exportSerial);

            let daysComplete = 0;
            for (const {job, date} of waiting) {
                const expected = Math.round((dayEnd(date) - dayStart(date)) / 1800);
                const received = (await this.intervals.forDay(date, "import")).length;
                if (received >= expected || date < addDays(today(), -giveUpAfterDays)) {
                    await this.daysMachine.updateJob(job.id, new Map<string, any>([
                        ["meterDataComplete", true], ["intervalsReceived", received], ["intervalsExpected", expected]]), actor);
                    daysComplete++;
                }
            }
            return {daysOpened, daysComplete, problem: null};
        } catch (error) {
            return {daysOpened: 0, daysComplete: 0, problem: error instanceof Error ? error.message : String(error)};
        }
    }

    // ---- costing one day

    async costDay(date : string) : Promise<Record<string, number | string | null>> {
        const link = await this.linked();
        if (!link) return {note: "Octopus was disconnected before this day could be costed"};
        const api = await this.api();
        const start = dayStart(date), end = dayEnd(date);
        const from = new Date(start * 1000), to = new Date(end * 1000);
        const points = OctopusService.points(await this.account(link.accountNumber));
        const notes : Array<string> = [];

        const price = async (direction : Direction, mpan : string | null) => {
            const rows = await this.intervals.forDay(date, direction);
            const kwh = rows.reduce((s, r) => s + r.kwh, 0);
            const tariff = mpan ? OctopusService.tariffOn(points, mpan, start) : null;
            if (!mpan || !tariff) return {kwh: rows.length ? kwh : null, pounds: null, tariff, standing: null, rows, rates: null};
            const rates = await unitRates(api, tariff, from, to);
            if (!rates) {
                notes.push(`${tariff}'s ${direction} rates aren't published in a form the app can price yet`);
                return {kwh, pounds: null, tariff, standing: null, rows, rates: null};
            }
            let pence = 0, unpriced = 0;
            for (const r of rows) {
                const rate = rates.rateAt(r.start);
                if (rate == null) unpriced++;
                else pence += r.kwh * rate;
            }
            if (unpriced) notes.push(`${unpriced} ${direction} half-hours had no published rate`);
            const standingRates = direction === "import" ? await api.rates(tariff, "standing-charges", from, to) : [];
            const standing = direction === "import" ? rateAt(standingRates, start) : null;
            return {kwh, pounds: pence / 100, tariff, standing: standing == null ? null : standing / 100, rows, rates};
        };

        const imp = await price("import", link.importMpan);
        const exp = await price("export", link.exportMpan);
        const expected = Math.round((end - start) / 1800);
        const received = (await this.intervals.forDay(date, "import")).length;
        if (received < expected) notes.push(`Octopus had ${received} of ${expected} half-hourly readings`);
        const net = imp.pounds == null ? null : imp.pounds + (imp.standing ?? 0) - (exp.pounds ?? 0);

        // Savings need the inverter's readings for the day as well as the meter's.
        let saved : ReturnType<typeof daySavings> | null = null;
        const dayReadings = await this.readings.forDay(date);
        if (net != null && imp.rates && dayReadings.length) {
            saved = daySavings({start, end, readings: dayReadings, imports: imp.rows, exports: exp.rows,
                rateAt: imp.rates.rateAt, standingCharge: imp.standing ?? 0, actualNetCost: net});
            if (saved.coverage < 0.5) {
                notes.push("Too few inverter readings to work out savings");
                saved = null;
            } else if (saved.coverage < 0.98) {
                const time = new Date(saved.coveredUntil * 1000).toLocaleTimeString("en-GB", {timeZone: "Europe/London", hour: "2-digit", minute: "2-digit"});
                notes.push(`Home collector offline from ${time}, so savings after then aren't counted`);
            }
        } else if (net != null && !dayReadings.length) notes.push("No inverter readings for this day, so no savings figure");
        return {
            homeKwh: saved ? round(saved.homeKwh, 2) : null, withoutSystemCost: saved ? round(saved.withoutSystemCost) : null,
            savings: saved ? round(saved.savings) : null, savingsCoverage: saved ? round(saved.coverage, 3) : null,
            importKwh: imp.kwh == null ? null : round(imp.kwh, 3), exportKwh: exp.kwh == null ? null : round(exp.kwh, 3),
            importCost: imp.pounds == null ? null : round(imp.pounds), standingCharge: imp.standing == null ? null : round(imp.standing),
            exportEarnings: exp.pounds == null ? null : round(exp.pounds), netCost: net == null ? null : round(net),
            averageImportRate: imp.pounds != null && imp.kwh ? round(imp.pounds * 100 / imp.kwh, 1) : null,
            tariff: imp.tariff, exportTariff: exp.tariff, note: notes.join("; ") || null,
        };
    }

    // ---- what the dashboard shows

    private async tariffName(code : string | null) : Promise<string | null> {
        if (!code) return null;
        if (!this.names.has(code)) this.names.set(code, await (await this.api()).productName(code));
        return this.names.get(code)!;
    }

    async status() {
        const current = await this.currentLink();
        const link = await this.linked();
        let tariffs : {import : string | null, export : string | null} = {import: null, export: null};
        let rateNow : number | null = null;
        if (link) {
            try {
                const points = OctopusService.points(await this.account(link.accountNumber));
                const now = Date.now() / 1000;
                const importTariff = OctopusService.tariffOn(points, link.importMpan, now);
                const exportTariff = link.exportMpan ? OctopusService.tariffOn(points, link.exportMpan, now) : null;
                tariffs = {import: await this.tariffName(importTariff), export: await this.tariffName(exportTariff)};
                if (importTariff) {
                    const rates = await unitRates(await this.api(), importTariff, new Date(Date.now() - 86_400_000), new Date(Date.now() + 3_600_000));
                    rateNow = rates?.rateAt(now) ?? null;
                }
            } catch (error) { console.error("octopus status", error); }
        }
        return {
            state: current?.job.state ?? "awaiting-key", jobId: current?.job.id ?? null,
            problem: current?.props.get("problem") ?? null,
            account: link ? `${link.accountNumber}` : null,
            hasExport: Boolean(link?.exportMpan), hasLive: Boolean(link?.deviceId),
            tariffs, unitRateNow: rateNow,
        };
    }

    async days(n : number) {
        const from = addDays(today(), -n);
        const jobs = await this.monitor.jobs("meter-days", ["awaiting-meter-data", "costing", "costed"]);
        return jobs.map(({job, props}) => ({id: job.id, state: job.state, ...Object.fromEntries(props)}))
            .filter((d : any) => d.date >= from)
            .sort((a : any, b : any) => a.date.localeCompare(b.date));
    }

    // What Octopus returns for the meter's smart devices (no secrets), to work out why live readings are missing.
    async diagnostics() {
        const link = await this.linked();
        if (!link) return {linked: false};
        const key = await this.secrets.retrieve(keyName, this.reader);
        const now = Date.now();
        const iso = (msAgo : number) => new Date(now - msAgo).toISOString();
        const plain = (msAgo : number) => iso(msAgo).replace(/\.\d{3}Z$/, "Z");
        const offset = (msAgo : number) => iso(msAgo).replace(/\.\d{3}Z$/, "+00:00");
        const results : Array<unknown> = [];
        for (const base of [this.client?.api.base ?? undefined, krakenApiBase]) {
            const api = new OctopusClient(key, base);
            let meters : unknown;
            try {
                const number = (await api.accountNumbers())[0];
                meters = await api.activeMeters(number);
            } catch (error) { results.push({base, error: String(error)}); continue; }
            const devices = [...new Set((meters as Array<any>).flatMap((m) => m.deviceIds.map((d : any) => d.deviceId)))];
            const variants : Array<[string, {start? : string, end? : string, grouping? : string}]> = [
                ["latest", {}],
                ["1 day half-hourly", {start: plain(86_400_000), end: plain(0), grouping: "HALF_HOURLY"}],
                ["1 day, +00:00 times", {start: offset(86_400_000), end: offset(0), grouping: "HALF_HOURLY"}],
                ["1 hour, no grouping", {start: plain(3_600_000), end: plain(0)}],
                ["7 days hourly", {start: plain(7 * 86_400_000), end: plain(0), grouping: "HOURLY"}],
            ];
            const probes = [];
            for (const deviceId of devices) {
                for (const [label, args] of variants) {
                    try {
                        const rows = await api.telemetryRaw(deviceId, args);
                        probes.push({deviceId, label, rows: rows.length, last: rows.at(-1) ?? null});
                    } catch (error) { probes.push({deviceId, label, error: String(error)}); }
                }
            }
            results.push({base: api.base, meters, probes});
        }
        return {chosenDevice: link.deviceId, results};
    }

    // The Home Mini's readings via Octopus: power now and energy used so far today.
    async live() {
        if (this.liveCache && Date.now() - this.liveCache.at < 15_000) return this.liveCache.value;
        const link = await this.linked();
        if (!link?.deviceId) return {available: false};
        const api = await this.api();
        const now = new Date();
        const recent = await api.telemetry(link.deviceId, new Date(now.getTime() - 10 * 60_000), now, "TEN_SECONDS");
        const latest = [...recent].reverse().find((r) => r.demand != null);
        const day = await api.telemetry(link.deviceId, new Date(dayStart(today()) * 1000), now, "HALF_HOURLY");
        const todayWh = day.reduce((s, r) => s + (Number(r.consumptionDelta) || 0), 0);
        const value = {
            available: true,
            readAt: latest?.readAt ?? null,
            demandW: latest?.demand != null ? Number(latest.demand) : null,
            todayImportKwh: day.length ? round(todayWh / 1000, 2) : null,
            date: localDate(now.getTime() / 1000),
        };
        this.liveCache = {at: Date.now(), value};
        return value;
    }
}
