import {Await, Job, JobPersistence, PropertyDefinition, Queue, State, StateMachine, Terminal, Transition} from "anbaric";

export const alertKinds = ["collector-offline", "inverter-fault", "cell-imbalance", "battery-temperature"] as const;
export type AlertKind = typeof alertKinds[number];

const kind = new PropertyDefinition("kind");
kind.required = true;
kind.example = "cell-imbalance";
kind.validation = (value) => alertKinds.includes(value);

const text = (id : string, required : boolean, example : string) => {
    const definition = new PropertyDefinition(id);
    definition.required = required;
    definition.example = example;
    definition.validation = (value) => typeof value === "string" && value.length > 0 && value.length < 500;
    return definition;
};

const flag = (id : string) => {
    const definition = new PropertyDefinition(id);
    definition.validation = (value) => typeof value === "boolean";
    return definition;
};

export const alertsMachine = (persistence : JobPersistence, queue : Queue) => {
    const acknowledge = new Await("Acknowledge the alert", "HUMAN",
        "Someone at home confirms they have seen the alert");
    acknowledge.fields = ["acknowledged"];
    acknowledge.resolveUrl = (job) => `./?alert=${job.id}`;

    const awaitClear = new Await("Waiting for the condition to clear", "EXTERNAL_SYSTEM",
        "New readings or the hourly health check will mark this resolved once the problem goes away");
    awaitClear.fields = ["cleared"];

    const cleared = async (job : Job) => await job.properties.get("cleared") === true;

    return new StateMachine("alerts", [
        new State("open", [acknowledge], [
            new Transition("resolved", cleared),
            new Transition("acknowledged", async (job) => await job.properties.get("acknowledged") === true),
        ]),
        new State("acknowledged", [awaitClear], [new Transition("resolved", cleared)]),
        new Terminal("resolved", Terminal.Outcome.SUCCESS),
    ], "open", [
        kind,
        text("message", true, "Cell spread is 140 mV (over 100 mV)"),
        text("raisedAt", true, "2026-11-04T16:05:00.000Z"),
        text("acknowledgedBy", false, "martyn"),
        text("clearedAt", false, "2026-11-04T17:05:00.000Z"),
        flag("acknowledged"),
        flag("cleared"),
    ], persistence, queue);
};
