import {Actor, Code, Human, SecretStore, StateMachine} from "anbaric";
import type {HouseholdMonitor} from "./householdMonitor.js";
import {BoilerJuiceClient, OilError, TankReading} from "./oilClient.js";
import type {OilReadings, StoredOilReading} from "./oilReadings.js";
import {OilPoint, oilUsage, recentRate, useSince} from "./oilUsage.js";

const loginName = "boilerjuice-login";
const checkEverySeconds = 23 * 3600;   // once a day is plenty: BoilerJuice updates the level about daily
const reader = new Code("boilerjuice");

export type OilLink = {tankId : string, tankCount : number};

// The level used for usage: all the oil in the tank where BoilerJuice gives it, else the usable oil.
const level = (r : StoredOilReading) : number | null => r.totalLitres ?? r.litres;

// Everything that talks to BoilerJuice: the sign-in kept in the secret store, finding the tank and reading its level.
export class OilService {
    linkMachine! : StateMachine;
    private client? : {secret : string, api : BoilerJuiceClient};
    private lastCheck? : {at : number, problem : string | null};
    private queue : Promise<unknown> = Promise.resolve();

    constructor(private readonly secrets : SecretStore, private readonly readings : OilReadings,
                private readonly monitor : HouseholdMonitor, private readonly app : Actor) {}

    attach(linkMachine : StateMachine) { this.linkMachine = linkMachine; }

    private async api() : Promise<BoilerJuiceClient> {
        let secret : string;
        try { secret = await this.secrets.retrieve(loginName, this.app); }
        catch { throw new OilError("No BoilerJuice sign-in has been entered"); }
        if (this.client?.secret !== secret) {
            const {email, password} = JSON.parse(secret);
            this.client = {secret, api: new BoilerJuiceClient(email, password)};
        }
        return this.client.api;
    }

    // ---- the link job

    async currentLink() {
        return (await this.monitor.jobs("oil-link", ["awaiting-login", "finding-tank", "linked"]))[0];
    }

    async linked() : Promise<OilLink | undefined> {
        const current = await this.currentLink();
        if (current?.job.state !== "linked") return undefined;
        return {tankId: current.props.get("tankId"), tankCount: current.props.get("tankCount") ?? 1};
    }

    async ensureLinkJob(actor : Actor) {
        return (await this.currentLink())?.job ?? await this.linkMachine.startJob(new Map(), actor);
    }

    async saveLogin(email : string, password : string, person : Human) {
        const current = await this.currentLink();
        if (current?.job.state === "finding-tank") throw new OilError("Still checking the last sign-in – try again in a moment");
        if (current?.job.state === "linked") await this.linkMachine.updateJob(current.job.id, new Map([["disconnect", true]]), person);
        await this.secrets.delete(loginName, person).catch(() => undefined);
        await this.secrets.create(person, loginName, JSON.stringify({email, password}));
        this.client = undefined;
        const job = current?.job.state === "awaiting-login" ? current.job : await this.linkMachine.startJob(new Map(), person);
        await this.linkMachine.updateJob(job.id, new Map([["loginSaved", true]]), person);
        return job.id;
    }

    async disconnect(person : Human) {
        const current = await this.currentLink();
        await this.secrets.delete(loginName, person).catch(() => undefined);
        this.client = undefined;
        this.lastCheck = undefined;
        if (current?.job.state === "linked") await this.linkMachine.updateJob(current.job.id, new Map([["disconnect", true]]), person);
        await this.linkMachine.startJob(new Map(), person);
    }

    // Signs in, finds the tank and takes a first reading. Called by the link job.
    async discover() : Promise<OilLink & {capacity : number | null}> {
        const api = await this.api();
        const tanks = await api.tanks();
        if (!tanks.length) throw new OilError("Signed in to BoilerJuice, but found no tank on the account");
        const first = await api.tank(tanks[0]);
        await this.store(first);
        await this.saveOrders(api);
        return {tankId: tanks[0], tankCount: tanks.length, capacity: first.capacity};
    }

    // Deliveries come from the account's oil orders. Failing to read them doesn't stop the level being recorded.
    private async saveOrders(api : BoilerJuiceClient) {
        try { await this.readings.saveOrders(await api.orders(), reader); }
        catch (error) { console.error("oil orders", error); }
    }

    private async store(reading : TankReading) {
        await this.readings.add(Date.now() / 1000, reading, reader);
        this.lastCheck = {at: Date.now() / 1000, problem: null};
    }

    // ---- checking the level: from the hourly run, but only once a day

    poll(force = false) : Promise<{checked : boolean, problem : string | null}> {
        const run = this.queue.then(() => this.pollNow(force));
        this.queue = run.catch(() => undefined);
        return run;
    }

    private async pollNow(force : boolean) {
        const link = await this.linked();
        if (!link) return {checked: false, problem: null};
        const last = Math.max(this.lastCheck?.at ?? 0, (await this.readings.latest())?.ts ?? 0);
        if (!force && Date.now() / 1000 - last < checkEverySeconds) return {checked: false, problem: null};
        try {
            const api = await this.api();
            await this.store(await api.tank(link.tankId));
            await this.saveOrders(api);
            return {checked: true, problem: null};
        } catch (error) {
            const problem = error instanceof Error ? error.message : String(error);
            this.lastCheck = {at: Date.now() / 1000, problem};
            return {checked: false, problem};
        }
    }

    // The shape of a BoilerJuice page (ids, the text around oil figures, links, chart data), without the whole page,
    // so changes to BoilerJuice's site can be diagnosed. Only paths under /uk/users/ on the account.
    async diagnostics(path? : string) {
        const link = await this.linked();
        const target = path ?? (link ? `/uk/users/tanks/${link.tankId}/edit` : "/uk/users/tanks");
        if (!/^\/uk\/users\/[\w\-\/]*$/.test(target)) throw new OilError("Only /uk/users/ pages can be inspected");
        const {html, url} = await (await this.api()).raw(target);
        const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
        const around = (re : RegExp, width = 90) => [...text.matchAll(re)].slice(0, 40)
            .map((m) => text.slice(Math.max(0, m.index! - width), m.index! + m[0].length + width).trim())
            .map((snippet) => snippet.replace(/(billing|delivery)?\s*address.*$/i, "[address left out]")
                .replace(/\b[A-Z]{1,2}\d[A-Z\d]?(\s*\d[A-Z]{2})?\b/g, "[postcode]"));
        // BoilerJuice's pages carry the account holder's name, email and address; those parts are left out.
        const personal = /(dataLayer|email|firstName|surname|address|postcode|phone)/i;
        const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1].trim())
            .filter((js) => !personal.test(js))
            .filter((js) => /\d{2,}/.test(js) && /(data|label|chart|series|level|litre|usage|history|reading)/i.test(js))
            .map((js) => js.length > 1500 ? js.slice(0, 1500) + ` …(${js.length} chars)` : js).slice(0, 12);
        return {
            path: new URL(url).pathname, bytes: html.length, title: html.match(/<title>([^<]*)/i)?.[1]?.trim() ?? null,
            ids: [...new Set([...html.matchAll(/\bid\s*=\s*"([^"]+)"/gi)].map((m) => m[1]))].slice(0, 150),
            dataAttributes: [...new Set([...html.matchAll(/\b(data-[\w-]+)\s*=\s*"([^"]{0,40})"/gi)].map((m) => `${m[1]}="${m[2]}"`))].slice(0, 120),
            inputs: [...html.matchAll(/<input\b[^>]*>/gi)].map((m) => m[0]).filter((t) => !/type\s*=\s*"(hidden|password|email)"/i.test(t)
                && !/name\s*=\s*"[^"]*(name|address|phone|postcode|email)[^"]*"/i.test(t)).slice(0, 40),
            litres: around(/litre/gi), percent: around(/\d+\s*%/g, 60), usage: around(/(usage|history|consumption|per day|daily)/gi),
            links: [...new Set([...html.matchAll(/href\s*=\s*"(\/uk\/users\/[^"#?]*)/gi)].map((m) => m[1]))],
            apiLike: [...new Set([...html.matchAll(/["'](\/(?:api|uk\/api|uk\/users)[^"'\s]*(?:json|readings|levels|history|usage|chart)[^"'\s]*)["']/gi)].map((m) => m[1]))],
            scripts,
        };
    }

    // ---- what the dashboard shows

    async status() {
        const current = await this.currentLink();
        const latest = await this.readings.latest();
        return {
            state: current?.job.state ?? "awaiting-login", jobId: current?.job.id ?? null,
            problem: current?.props.get("problem") ?? this.lastCheck?.problem ?? null,
            tankCount: current?.props.get("tankCount") ?? null,
            lastChecked: this.lastCheck?.at ?? latest?.ts ?? null,
            latest: latest ?? null,
        };
    }

    async history(days : number) {
        const rows = await this.readings.since(Date.now() / 1000 - days * 86400);
        const capacity = [...rows].reverse().find((r) => r.capacity != null)?.capacity ?? null;
        const points : Array<OilPoint> = rows.flatMap((r) => level(r) == null ? [] : [{ts: r.ts, litres: level(r)!}]);
        const {days: usage, deliveries} = oilUsage(points, capacity);
        const rate = recentRate(points, capacity);
        const latest = rows.at(-1);
        const usable = latest?.litres ?? (latest ? level(latest) : null);
        const orders = (await this.readings.orders()).map((o) => ({...o,
            cost: o.pencePerLitre == null ? null : Math.round(o.litres * o.pencePerLitre) / 100}));
        const lastDelivered = [...orders].reverse().find((o) => o.delivered)?.delivered ?? null;
        const now = Date.now() / 1000;
        const periods = Object.fromEntries([["7", 7], ["30", 30], ["90", 90], ["365", 365]]
            .map(([k, n]) => [k, useSince(points, capacity, now - (n as number) * 86400)]));
        periods.delivery = lastDelivered ? useSince(points, capacity, Date.parse(lastDelivered + "T00:00:00Z") / 1000) : null;
        return {
            capacity, readings: rows.map((r) => ({ts: r.ts, litres: r.litres, totalLitres: r.totalLitres, percent: r.percent})),
            days: usage, deliveries, orders, lastDelivered, periods,
            ratePerDay: rate == null ? null : Math.round(rate * 10) / 10,
            daysLeft: rate && usable != null ? Math.floor(usable / rate) : null,
        };
    }
}
