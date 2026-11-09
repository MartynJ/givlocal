import {readFile} from "node:fs/promises";
import {createServer, IncomingMessage, ServerResponse} from "node:http";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {
    Code, Human, JobPersistenceFactory, JobRunScheduler, QueueFactory, SecretStoreFactory, serializeJob, SqlStoreFactory,
} from "anbaric";
import {alertsMachine} from "./alerts.js";
import {acceptUpload} from "./collectorUpload.js";
import {CollectorToken} from "./collectorToken.js";
import {offlineAfterSeconds} from "./conditions.js";
import {dayTotals} from "./dayTotals.js";
import {energyDaysMachine} from "./energyDays.js";
import {everyHour, healthChecksMachine} from "./healthChecks.js";
import {HouseholdMonitor} from "./householdMonitor.js";
import {addDays, homeTimeZone, isDate, today} from "./localDate.js";
import {MeterIntervals} from "./meterIntervals.js";
import {OctopusError} from "./octopusClient.js";
import {meterDaysMachine, octopusLinkMachine} from "./octopusMachines.js";
import {OctopusService} from "./octopusService.js";
import {readingColumns, ReadingStore} from "./readings.js";

const app = new Code("givlocal");
// One persistence and one queue, shared by every machine and by the routes that read jobs.
const persistence = JobPersistenceFactory.instance();
const queue = QueueFactory.instance();
const readings = new ReadingStore(SqlStoreFactory.instance(), app);
await readings.prepare();
const secrets = SecretStoreFactory.instance();
const token = new CollectorToken(secrets, app);
await token.get();

const days = energyDaysMachine(readings, persistence, queue);
const alerts = alertsMachine(persistence, queue);
const monitor = new HouseholdMonitor(readings, days, alerts, persistence, app);
const intervals = new MeterIntervals(SqlStoreFactory.instance(), app);
await intervals.prepare();
const octopus = new OctopusService(secrets, intervals, readings, monitor, app);
octopus.attach(octopusLinkMachine(octopus, persistence, queue), meterDaysMachine(octopus, persistence, queue));
await octopus.ensureLinkJob(app);
octopus.syncSoon();   // catch up straight away after a restart or deploy
const healthChecks = healthChecksMachine(monitor, octopus, persistence, queue);
JobRunScheduler.instance().schedule(healthChecks, everyHour);

const staticDir = join(dirname(fileURLToPath(import.meta.url)), "..", "static");
const deployed = Boolean(process.env.ANBARIC_APP_ID);

// Locally there is no platform session, so a stand-in person is used.
const signedInPerson = async (request : IncomingMessage) : Promise<Human | undefined> => {
    try { return await Human.fromSession(request); }
    catch { return deployed ? undefined : new Human("dev", "owner"); }
};

const readBody = (request : IncomingMessage, limit = 2_000_000) : Promise<any> => new Promise((resolve, reject) => {
    const chunks : Array<Buffer> = [];
    let size = 0;
    request.on("data", (chunk : Buffer) => {
        size += chunk.length;
        if (size > limit) { reject(new Error("upload too large")); request.destroy(); }
        else chunks.push(chunk);
    });
    request.on("error", reject);
    request.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); }
        catch { reject(new Error("body is not valid JSON")); }
    });
});

const json = (response : ServerResponse, status : number, body : unknown) => {
    response.writeHead(status, {"content-type": "application/json", "cache-control": "no-store"});
    response.end(JSON.stringify(body));
};

const staticTypes : Record<string, string> = {
    "/": "text/html; charset=utf-8", "/chart.umd.min.js": "application/javascript", "/anbaric-ident.svg": "image/svg+xml",
};

const live = async () => {
    const latest = await readings.latest();
    const now = Date.now() / 1000;
    const todays = await readings.forDay(today());
    return {
        now, timeZone: homeTimeZone,
        collector: {lastReading: latest?.ts ?? null, online: latest ? now - latest.ts < offlineAfterSeconds : false,
            readingsStored: await readings.count()},
        reading: latest ?? null,
        today: dayTotals(todays),
    };
};

const dayView = async (date : string) => {
    const rows = await readings.forDay(date);
    return {date, rows: rows.map(({extra, ...rest}) => rest), totals: rows.length ? dayTotals(rows) : null};
};

const dailyHistory = async (n : number) => {
    const from = addDays(today(), -(n - 1));
    const closed = (await monitor.jobs("energy-days", ["complete"]))
        .filter(({props}) => props.get("date") >= from)
        .map(({job, props}) => ({date: props.get("date") as string, state: job.state,
            ...Object.fromEntries([...props].filter(([k]) => k.endsWith("Kwh") || k.startsWith("soc") || k === "samples" || k === "coverage"))}));
    const closedDates = new Set(closed.map((d) => d.date));
    const open = (await monitor.jobs("energy-days", ["recording", "closing"]))
        .map(({props}) => props.get("date") as string)
        .filter((date) => date >= from && !closedDates.has(date));
    const inProgress = await Promise.all(open.map(async (date) => ({date, state: "recording", ...dayTotals(await readings.forDay(date))})));
    return [...closed, ...inProgress].sort((a, b) => a.date.localeCompare(b.date));
};

const alertList = async () => {
    const current = await monitor.openAlerts();
    const resolved = (await monitor.jobs("alerts", ["resolved"])).slice(0, 10);
    return [...current, ...resolved].map(({job}) => serializeJob(job));
};

const csv = async (from : string, to : string) => {
    const rows = await readings.between(from, to);
    const header = ["time", ...readingColumns].join(",");
    return [header, ...rows.map((r) => [new Date(r.ts * 1000).toISOString(), ...readingColumns.map((c) => r[c] ?? "")].join(","))].join("\n");
};

const octopusRoute = async (request : IncomingMessage, response : ServerResponse, path : string, url : URL, person : Human) => {
    try {
        if (request.method === "GET" && path === "/api/octopus") return json(response, 200, await octopus.status());
        if (request.method === "GET" && path === "/api/octopus/days") {
            const n = Math.min(366, Math.max(1, Number(url.searchParams.get("n")) || 30));
            return json(response, 200, await octopus.days(n));
        }
        if (request.method === "POST" && path === "/api/octopus/sync") return json(response, 200, await octopus.sync(person));
        if (request.method === "GET" && path === "/api/octopus/diagnostics") return json(response, 200, await octopus.diagnostics());
        if (request.method === "GET" && path === "/api/octopus/live") return json(response, 200, await octopus.live());
        if (request.method === "POST" && path === "/api/octopus/key") {
            const apiKey = String((await readBody(request, 10_000))?.apiKey ?? "").trim();
            if (!/^sk_live_[A-Za-z0-9]{8,64}$/.test(apiKey)) {
                return json(response, 400, {error: "That doesn't look like an Octopus API key – it starts sk_live_"});
            }
            return json(response, 202, {id: await octopus.saveKey(apiKey, person)});
        }
        if (request.method === "POST" && path === "/api/octopus/disconnect") {
            await octopus.disconnect(person);
            return json(response, 200, {ok: true});
        }
        return json(response, 404, {error: "not found"});
    } catch (error) {
        if (error instanceof OctopusError) return json(response, 502, {error: error.message});
        throw error;
    }
};

const handle = async (request : IncomingMessage, response : ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (request.method === "POST" && path === "/ingest") {
        // Its own header: the platform gateway treats `Authorization` as a platform credential.
        if (!await token.matches(request.headers["x-collector-token"])) return json(response, 401, {error: "bad collector token"});
        try { return json(response, 200, await acceptUpload(await readBody(request), readings, monitor)); }
        catch (error) { return json(response, 400, {error: error instanceof Error ? error.message : "bad upload"}); }
    }
    if (path === "/healthz") return json(response, 200, {ok: true});

    // The app is public so the collector can upload; everything else is for signed-in members.
    // The platform serves /login on the app's own address and returns here afterwards.
    const person = await signedInPerson(request);
    if (!person && request.method === "GET" && path === "/") {
        response.writeHead(302, {location: "login", "cache-control": "no-store"});
        return response.end();
    }
    if (!person) return json(response, 401, {error: "sign in to view this dashboard"});

    if (request.method === "GET" && staticTypes[path]) {
        const file = path === "/" ? "index.html" : path.slice(1);
        response.writeHead(200, {"content-type": staticTypes[path], "cache-control": path === "/" ? "no-store" : "max-age=3600"});
        return response.end(await readFile(join(staticDir, file)));
    }
    if (request.method === "GET" && path === "/api/live") return json(response, 200, await live());
    if (request.method === "GET" && path === "/api/day") {
        const date = url.searchParams.get("date") ?? today();
        return isDate(date) ? json(response, 200, await dayView(date)) : json(response, 400, {error: "date must be YYYY-MM-DD"});
    }
    if (request.method === "GET" && path === "/api/days") {
        const n = Math.min(366, Math.max(1, Number(url.searchParams.get("n")) || 30));
        return json(response, 200, await dailyHistory(n));
    }
    if (request.method === "GET" && path === "/api/alerts") return json(response, 200, await alertList());
    if (request.method === "GET" && path.startsWith("/api/jobs/")) {
        try {
            const job = await persistence.retrieve(path.slice(10), app);
            await job.properties.prewarm();
            return json(response, 200, serializeJob(job));
        }
        catch { return json(response, 404, {error: "no such job"}); }
    }
    const ack = path.match(/^\/api\/alerts\/([\w-]+)\/acknowledge$/);
    if (request.method === "POST" && ack) {
        const job = await persistence.retrieve(ack[1], app).catch(() => undefined);
        if (!job || job.workflowId !== "alerts") return json(response, 404, {error: "no such alert"});
        if (job.state !== "open") return json(response, 409, {error: `alert is already ${job.state}`});
        await alerts.updateJob(job.id, new Map<string, any>([["acknowledged", true], ["acknowledgedBy", person.id]]), person);
        return json(response, 202, {id: job.id});
    }
    if (request.method === "GET" && path === "/api/collector") {
        return json(response, 200, {token: await token.get(), uploadPath: "ingest"});
    }
    if (path.startsWith("/api/octopus")) return octopusRoute(request, response, path, url, person);
    if (request.method === "GET" && path === "/api/export.csv") {
        const to = url.searchParams.get("to") ?? today(), from = url.searchParams.get("from") ?? addDays(to, -29);
        if (!isDate(from) || !isDate(to)) return json(response, 400, {error: "dates must be YYYY-MM-DD"});
        response.writeHead(200, {"content-type": "text/csv", "content-disposition": `attachment; filename="givlocal-${from}-to-${to}.csv"`});
        return response.end(await csv(from, to));
    }
    json(response, 404, {error: "not found"});
};

const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
        console.error(error);
        if (!response.headersSent) json(response, 500, {error: error instanceof Error ? error.message : "internal error"});
    });
});
const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`givlocal listening on ${port}`));
