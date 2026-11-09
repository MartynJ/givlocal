import {Action, Code, JobPersistence, PropertyDefinition, Queue, Schedule, State, StateMachine, Terminal, Transition} from "anbaric";
import type {HouseholdMonitor} from "./householdMonitor.js";

// Anything else to do on the hourly run (fetching Octopus meter readings).
export type HourlyExtra = {sync : (actor : Code) => Promise<{daysComplete : number, problem : string | null}>};

const scheduledFor = new PropertyDefinition("scheduledFor");
scheduledFor.validation = (value) => typeof value === "string" || value instanceof Date;

const list = (id : string) => {
    const definition = new PropertyDefinition(id);
    definition.validation = (value) => Array.isArray(value) && value.every((v) => typeof v === "string");
    return definition;
};

const daysEnded = new PropertyDefinition("daysEnded");
daysEnded.validation = (value) => Number.isInteger(value) && value >= 0;

const meterDaysComplete = new PropertyDefinition("meterDaysComplete");
meterDaysComplete.validation = (value) => Number.isInteger(value) && value >= 0;

const octopusProblem = new PropertyDefinition("octopusProblem");
octopusProblem.validation = (value) => value === null || typeof value === "string";

const checkedAt = new PropertyDefinition("checkedAt");
checkedAt.validation = (value) => typeof value === "string";

export const everyHour = new Schedule(Schedule.everyDay(), Array.from({length: 24}, (_, hours) => ({hours, minutes: 7})));

// Readings only arrive while the home collector is running, so this hourly check is what notices
// when it has stopped, and what closes a day that ended while nothing was reporting.
export const healthChecksMachine = (monitor : HouseholdMonitor, extra : HourlyExtra | undefined, persistence : JobPersistence, queue : Queue) => {
    const watchdog = new Code("watchdog");
    const check = new Action("Check the home collector and battery", watchdog,
        "Raises or clears alerts from the latest reading, closes any day that has ended and fetches Octopus meter readings");
    check.run = async () => {
        const result = await monitor.check(watchdog);
        const meter = extra ? await extra.sync(watchdog) : undefined;
        return new Map<string, any>([
            ["meterDaysComplete", meter?.daysComplete ?? 0], ["octopusProblem", meter?.problem ?? null],
            ["checkedAt", new Date().toISOString()], ["alertsRaised", result.raised],
            ["alertsCleared", result.cleared], ["daysEnded", result.daysEnded],
        ]);
    };
    return new StateMachine("health-checks", [
        new State("checking", [check], [new Transition("done")]),
        new Terminal("done", Terminal.Outcome.SUCCESS),
    ], "checking", [scheduledFor, checkedAt, list("alertsRaised"), list("alertsCleared"), daysEnded, meterDaysComplete, octopusProblem], persistence, queue);
};
