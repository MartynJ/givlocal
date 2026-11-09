import {Action, Await, Code, JobPersistence, PropertyDefinition, Queue, State, StateMachine, Terminal, Transition} from "anbaric";
import {isDate} from "./localDate.js";
import type {OctopusService} from "./octopusService.js";

const flag = (id : string) => {
    const d = new PropertyDefinition(id);
    d.validation = (v) => typeof v === "boolean";
    return d;
};
const text = (id : string, example? : string) => {
    const d = new PropertyDefinition(id);
    if (example) d.example = example;
    d.validation = (v) => v === null || typeof v === "string";
    return d;
};
const amount = (id : string, example : number, allowNegative = false) => {
    const d = new PropertyDefinition(id);
    d.example = example;
    d.validation = (v) => v === null || (typeof v === "number" && Number.isFinite(v) && (allowNegative || v >= 0));
    return d;
};

// Linking the Octopus account: a person enters their API key, then the app finds the account and meters.
// A bad key (or no smart meter) sends the job back to wait for a new key, with the problem recorded.
export const octopusLinkMachine = (octopus : OctopusService, persistence : JobPersistence, queue : Queue) => {
    const enterKey = new Await("Enter the Octopus API key", "HUMAN",
        "Paste the API key from Octopus → Personal details → API access on the dashboard's Octopus panel");
    enterKey.fields = ["keySaved"];
    enterKey.resolveUrl = "./#octopus";

    const findMeters = new Action("Find the account and meters", new Code("octopus"),
        "Uses the key to find the electricity account, the import and export meters and the Home Mini's device");
    findMeters.run = async () => {
        try {
            const found = await octopus.discover();
            octopus.syncSoon();
            return new Map<string, any>([...Object.entries(found), ["problem", null], ["linkedAt", new Date().toISOString()]]);
        } catch (error) {
            return new Map<string, any>([["problem", error instanceof Error ? error.message : String(error)], ["keySaved", false]]);
        }
    };

    const stayLinked = new Await("Linked – Octopus readings flowing", "HUMAN",
        "Readings and costs are fetched hourly; disconnect from the dashboard to remove the key");
    stayLinked.fields = ["disconnect"];
    stayLinked.resolveUrl = "./#octopus";

    return new StateMachine("octopus-link", [
        new State("awaiting-key", [enterKey], [
            new Transition("finding-meters", async (job) => await job.properties.get("keySaved") === true),
        ]),
        new State("finding-meters", [findMeters], [
            new Transition("linked", async (job) => Boolean(await job.properties.get("accountNumber"))),
            new Transition("awaiting-key", async (job) => await job.properties.get("keySaved") === false),
        ]),
        new State("linked", [stayLinked], [
            new Transition("disconnected", async (job) => await job.properties.get("disconnect") === true),
        ]),
        new Terminal("disconnected", Terminal.Outcome.SUCCESS),
    ], "awaiting-key", [
        flag("keySaved"), flag("disconnect"), text("problem"), text("linkedAt"),
        text("accountNumber", "A-1234ABCD"), text("importMpan", "1900012345678"), text("importSerial", "21L1234567"),
        text("exportMpan"), text("exportSerial"), text("deviceId", "00-11-22-33-44-55-66-77"), text("tariff", "E-1R-AGILE-24-10-01-C"),
    ], persistence, queue);
};

// One job per day: wait for Octopus to publish the day's half-hourly readings, then cost the day.
export const meterDaysMachine = (octopus : OctopusService, persistence : JobPersistence, queue : Queue) => {
    const date = new PropertyDefinition("date");
    date.required = true;
    date.example = "2026-11-08";
    date.validation = isDate;

    const awaitReadings = new Await("Half-hourly readings arriving from Octopus", "EXTERNAL_SYSTEM",
        "Octopus usually publishes a day's meter readings the following day; checked hourly");
    awaitReadings.fields = ["meterDataComplete"];

    const cost = new Action("Cost the day", new Code("octopus-costing"),
        "Prices each half hour of import and export at the tariff's rates, adds the standing charge, and works out the saving against buying all the house's electricity from the grid");
    cost.run = async (job) => new Map<string, any>([...Object.entries(await octopus.costDay(await job.properties.get("date"))), ["costed", true]]);

    return new StateMachine("meter-days", [
        new State("awaiting-meter-data", [awaitReadings], [
            new Transition("costing", async (job) => await job.properties.get("meterDataComplete") === true),
        ]),
        new State("costing", [cost], [
            new Transition("costed", async (job) => await job.properties.get("costed") === true),
        ]),
        new Terminal("costed", Terminal.Outcome.SUCCESS),
    ], "awaiting-meter-data", [
        date, flag("meterDataComplete"), flag("costed"), amount("intervalsReceived", 48), amount("intervalsExpected", 48),
        amount("importKwh", 12.3), amount("exportKwh", 1.2), amount("importCost", 2.85), amount("standingCharge", 0.52),
        amount("exportEarnings", 0.18), amount("netCost", 3.19, true), amount("averageImportRate", 23.2),
        amount("homeKwh", 14.2), amount("withoutSystemCost", 4.10), amount("savings", 1.85, true), amount("savingsCoverage", 1),
        text("tariff"), text("exportTariff"), text("note"),
    ], persistence, queue);
};
