import {Action, Await, Code, JobPersistence, PropertyDefinition, Queue, State, StateMachine, Terminal, Transition} from "anbaric";
import {dayTotals} from "./dayTotals.js";
import {isDate} from "./localDate.js";
import type {ReadingStore} from "./readings.js";

const number = (id : string, example : number) => {
    const definition = new PropertyDefinition(id);
    definition.example = example;
    definition.validation = (value) => value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
    return definition;
};

const date = new PropertyDefinition("date");
date.required = true;
date.example = "2026-11-04";
date.validation = isDate;

const dayEnded = new PropertyDefinition("dayEnded");
dayEnded.validation = (value) => typeof value === "boolean";

const totalled = new PropertyDefinition("totalled");
totalled.validation = (value) => typeof value === "boolean";

const totals = [
    number("importKwh", 22.0), number("exportKwh", 0.2), number("chargeKwh", 9.9), number("dischargeKwh", 6.9),
    number("pvKwh", 0), number("homeKwh", 14.1), number("socMin", 4), number("socMax", 100),
    number("samples", 288), number("coverage", 1),
];

export const energyDaysMachine = (readings : ReadingStore, persistence : JobPersistence, queue : Queue) => {
    const awaitReadings = new Await("Readings arriving from the home collector", "EXTERNAL_SYSTEM",
        "The home collector uploads a reading about every five minutes; the day closes after midnight.");
    awaitReadings.fields = ["dayEnded"];

    const totalUp = new Action("Total up the day", new Code("day-totals"),
        "Works out the day's import, export, battery and house use from the stored readings");
    totalUp.run = async (job) => {
        const summary = dayTotals(await readings.forDay(await job.properties.get("date")));
        return new Map<string, any>([...Object.entries(summary), ["totalled", true]]);
    };

    return new StateMachine("energy-days", [
        new State("recording", [awaitReadings], [
            new Transition("closing", async (job) => await job.properties.get("dayEnded") === true),
        ]),
        new State("closing", [totalUp], [
            new Transition("complete", async (job) => await job.properties.get("totalled") === true),
        ]),
        new Terminal("complete", Terminal.Outcome.SUCCESS),
    ], "recording", [date, dayEnded, totalled, ...totals], persistence, queue);
};
