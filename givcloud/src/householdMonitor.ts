import {Actor, Job, JobPersistence, StateMachine} from "anbaric";
import type {AlertKind} from "./alerts.js";
import {activeConditions} from "./conditions.js";
import {today} from "./localDate.js";
import type {ReadingStore} from "./readings.js";

// Keeps the day and alert jobs in step with the readings: opens a day job for each new day,
// ends days that are over, raises alerts for new problems and clears ones that have gone away.
export class HouseholdMonitor {
    constructor(
        private readonly readings : ReadingStore,
        private readonly days : StateMachine,
        private readonly alerts : StateMachine,
        private readonly persistence : JobPersistence,
        private readonly reader : Actor,
    ) {}

    // Jobs from a list come back with their properties not yet loaded; load them so they can be read synchronously.
    async jobs(workflowId : string, states : Array<string>) : Promise<Array<{job : Job, props : Map<string, any>}>> {
        const found = (await Promise.all(states.map((state) =>
            this.persistence.list(this.reader, 500, 0, {workflowId, state, killed: false, order: "newest"})))).flat();
        return Promise.all(found.map(async (job) => {
            await job.properties.prewarm();
            return {job, props: await job.properties.toMap()};
        }));
    }

    async recordingDays() {
        return this.jobs("energy-days", ["recording"]);
    }

    async ensureDay(date : string, actor : Actor) {
        const all = await this.jobs("energy-days", ["recording", "closing", "complete"]);
        if (!all.some(({props}) => props.get("date") === date)) {
            await this.days.startJob(new Map([["date", date]]), actor);
        }
    }

    async endDaysBefore(date : string, actor : Actor) : Promise<number> {
        const over = (await this.recordingDays()).filter(({props}) => props.get("date") < date);
        for (const {job} of over) await this.days.updateJob(job.id, new Map([["dayEnded", true]]), actor);
        return over.length;
    }

    async openAlerts() {
        return this.jobs("alerts", ["open", "acknowledged"]);
    }

    async check(actor : Actor) : Promise<{raised : Array<AlertKind>, cleared : Array<AlertKind>, daysEnded : number}> {
        const latest = await this.readings.latest();
        const conditions = activeConditions(latest, Date.now() / 1000);
        const open = await this.openAlerts();
        const openKinds = new Set(open.map(({props}) => props.get("kind") as AlertKind));
        const raised : Array<AlertKind> = [], cleared : Array<AlertKind> = [];

        for (const [kind, message] of conditions) {
            if (openKinds.has(kind)) continue;
            await this.alerts.startJob(new Map([["kind", kind], ["message", message], ["raisedAt", new Date().toISOString()]]), actor);
            raised.push(kind);
        }
        const offline = conditions.has("collector-offline");
        for (const {job, props} of open) {
            const kind = props.get("kind") as AlertKind;
            if (conditions.has(kind) || (offline && kind !== "collector-offline")) continue;   // no fresh data to judge by
            await this.alerts.updateJob(job.id, new Map<string, any>([["cleared", true], ["clearedAt", new Date().toISOString()]]), actor);
            cleared.push(kind);
        }
        return {raised, cleared, daysEnded: await this.endDaysBefore(today(), actor)};
    }
}
