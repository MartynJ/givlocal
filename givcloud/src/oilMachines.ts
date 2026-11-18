import {Action, Await, Code, JobPersistence, PropertyDefinition, Queue, State, StateMachine, Terminal, Transition} from "anbaric";
import type {OilService} from "./oilService.js";

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
const count = (id : string, example : number) => {
    const d = new PropertyDefinition(id);
    d.example = example;
    d.validation = (v) => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);
    return d;
};

// Linking the BoilerJuice account: a person enters their BoilerJuice sign-in, then the app finds the tank.
// A sign-in BoilerJuice won't accept (or an account with no tank) sends the job back to wait for a new one.
export const oilLinkMachine = (oil : OilService, persistence : JobPersistence, queue : Queue) => {
    const enterLogin = new Await("Enter the BoilerJuice sign-in", "HUMAN",
        "Enter the email and password you use on boilerjuice.com in the dashboard's Heating oil panel");
    enterLogin.fields = ["loginSaved"];
    enterLogin.resolveUrl = "./#oil";

    const findTank = new Action("Find the oil tank", new Code("boilerjuice"),
        "Signs in to BoilerJuice, finds the tank on the account and reads its level for the first time");
    findTank.run = async () => {
        try {
            const found = await oil.discover();
            return new Map<string, any>([...Object.entries(found), ["problem", null], ["linkedAt", new Date().toISOString()]]);
        } catch (error) {
            return new Map<string, any>([["problem", error instanceof Error ? error.message : String(error)], ["loginSaved", false]]);
        }
    };

    const stayLinked = new Await("Linked – tank level read every few hours", "HUMAN",
        "The level is read from BoilerJuice every three hours; disconnect from the dashboard to remove the sign-in");
    stayLinked.fields = ["disconnect"];
    stayLinked.resolveUrl = "./#oil";

    return new StateMachine("oil-link", [
        new State("awaiting-login", [enterLogin], [
            new Transition("finding-tank", async (job) => await job.properties.get("loginSaved") === true),
        ]),
        new State("finding-tank", [findTank], [
            new Transition("linked", async (job) => Boolean(await job.properties.get("tankId"))),
            new Transition("awaiting-login", async (job) => await job.properties.get("loginSaved") === false),
        ]),
        new State("linked", [stayLinked], [
            new Transition("disconnected", async (job) => await job.properties.get("disconnect") === true),
        ]),
        new Terminal("disconnected", Terminal.Outcome.SUCCESS),
    ], "awaiting-login", [
        flag("loginSaved"), flag("disconnect"), text("problem"), text("linkedAt"),
        text("tankId", "123456"), count("tankCount", 1), count("capacity", 1225),
    ], persistence, queue);
};
