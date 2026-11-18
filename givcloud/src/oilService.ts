import {Actor, Code, Human, SecretStore, StateMachine} from "anbaric";
import type {HouseholdMonitor} from "./householdMonitor.js";
import {BoilerJuiceClient, OilError, TankReading} from "./oilClient.js";
import type {OilReadings, StoredOilReading} from "./oilReadings.js";
import {OilPoint, oilUsage, recentRate} from "./oilUsage.js";

const loginName = "boilerjuice-login";
const checkEverySeconds = 3 * 3600 - 300;   // BoilerJuice's figures change a few times a day at most
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
        return {tankId: tanks[0], tankCount: tanks.length, capacity: first.capacity};
    }

    private async store(reading : TankReading) {
        await this.readings.add(Date.now() / 1000, reading, reader);
        this.lastCheck = {at: Date.now() / 1000, problem: null};
    }

    // ---- checking the level: from the hourly run, but only every few hours

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
            await this.store(await (await this.api()).tank(link.tankId));
            return {checked: true, problem: null};
        } catch (error) {
            const problem = error instanceof Error ? error.message : String(error);
            this.lastCheck = {at: Date.now() / 1000, problem};
            return {checked: false, problem};
        }
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
        return {
            capacity, readings: rows.map((r) => ({ts: r.ts, litres: r.litres, totalLitres: r.totalLitres, percent: r.percent})),
            days: usage, deliveries, ratePerDay: rate == null ? null : Math.round(rate * 10) / 10,
            daysLeft: rate && usable != null ? Math.floor(usable / rate) : null,
        };
    }
}
