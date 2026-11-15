// Costing many days in a row should fetch each tariff's rates once per month, not once per day.
import {OctopusClient, unitRates} from "../src/octopusClient.js";

let calls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input : any, init? : any) => { calls++; return realFetch(input, init); }) as typeof fetch;

const api = new OctopusClient("sk_live_testtesttest1234", process.env.OCTOPUS_API_BASE ?? "http://localhost:4010/v1");
for (let day = 1; day <= 30; day++) {
    const from = new Date(Date.UTC(2026, 3, day, -1)), to = new Date(from.getTime() + 86_400_000);  // April, BST midnights
    await unitRates(api, "E-1R-AGILE-24-10-01-C", from, to);
    await api.rates("E-1R-AGILE-24-10-01-C", "standing-charges", from, to);
}
const ok = calls <= 6;
console.log(`${ok ? "PASS" : "FAIL"}: 30 days of rates took ${calls} requests`);
process.exit(ok ? 0 : 1);
