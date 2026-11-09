// Drives the health-check machine in memory: with the last reading 30 minutes old it should raise a
// collector-offline alert and close yesterday; a fresh reading should then clear the alert.
import {Code, JobPersistenceFactory, QueueFactory, SqlStoreFactory} from "anbaric";
import {alertsMachine} from "../src/alerts.js";
import {energyDaysMachine} from "../src/energyDays.js";
import {healthChecksMachine} from "../src/healthChecks.js";
import {HouseholdMonitor} from "../src/householdMonitor.js";
import {addDays, localDate, today} from "../src/localDate.js";
import {ReadingStore} from "../src/readings.js";

const actor = new Code("test");
const persistence = JobPersistenceFactory.instance(), queue = QueueFactory.instance();
const readings = new ReadingStore(SqlStoreFactory.instance(), actor);
await readings.prepare();
const days = energyDaysMachine(readings, persistence, queue), alerts = alertsMachine(persistence, queue);
const monitor = new HouseholdMonitor(readings, days, alerts, persistence, actor);
const checks = healthChecksMachine(monitor, undefined, persistence, queue);
const settle = () => new Promise((r) => setTimeout(r, 1500));
const assert = (ok : boolean, what : string) => { console.log(ok ? "PASS" : "FAIL", what); if (!ok) process.exitCode = 1; };

const now = Math.floor(Date.now() / 1000);
await readings.add({ts: now - 1800, soc: 50, extra: {status: "Normal"}} as any, actor);
await days.startJob(new Map([["date", addDays(today(), -1)]]), actor);
const run = await checks.startJob(new Map(), actor);
await settle();
const done = await persistence.retrieve(run.id, actor);
assert(done.state === "done", `health check finished (state ${done.state})`);
assert(JSON.stringify(await done.properties.get("alertsRaised")) === '["collector-offline"]', "raised collector-offline");
assert(await done.properties.get("daysEnded") === 1, "closed yesterday");
const open = await monitor.openAlerts();
assert(open.length === 1 && open[0].props.get("kind") === "collector-offline", "offline alert is open");

await readings.add({ts: now - 30, soc: 51, extra: {status: "Normal"}} as any, actor);
await checks.startJob(new Map(), actor);
await settle();
assert((await monitor.openAlerts()).length === 0, "fresh reading cleared the offline alert");
const yesterday = (await monitor.jobs("energy-days", ["complete"])).find(({props}) => props.get("date") === addDays(today(), -1));
assert(Boolean(yesterday), "yesterday's day job is complete");
assert(localDate(now) === today(), "local date helper agrees with today()");
process.exit();
