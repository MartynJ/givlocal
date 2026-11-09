// A stand-in for Octopus's API, for testing the link → sync → costing flow without a real account.
// Every half hour imports 0.25 kWh at 24p and exports 0.1 kWh at 15p; the standing charge is 50p a day.
import {createServer} from "node:http";

const port = Number(process.env.FAKE_OCTOPUS_PORT ?? 4010);
const send = (res : any, body : unknown, status = 200) => { res.writeHead(status, {"content-type": "application/json"}); res.end(JSON.stringify(body)); };
const goodKey = "sk_live_testtesttest1234";

createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost:${port}`);
    const chunks : Array<Buffer> = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (url.pathname === "/v1/graphql/") {
        const {query, variables} = JSON.parse(Buffer.concat(chunks).toString());
        if (query.includes("obtainKrakenToken")) {
            return variables.key === goodKey ? send(res, {data: {obtainKrakenToken: {token: "jwt"}}})
                : send(res, {errors: [{message: "Invalid data.", extensions: {errorDescription: "Authentication failed."}}]});
        }
        if (req.headers.authorization !== "jwt") return send(res, {errors: [{message: "'Authorization' header not provided."}]});
        if (query.includes("viewer")) return send(res, {data: {viewer: {accounts: [{number: "A-TEST0001"}]}}});
        if (query.includes("electricityAgreements")) return send(res, {data: {account: {electricityAgreements: [
            {meterPoint: {mpan: "1900000000001", meters: [{serialNumber: "21L000001", smartDevices: [{deviceId: "AA-BB", type: "ESME"}]}]}},
            {meterPoint: {mpan: "1900000000002", meters: [{serialNumber: "21L000001", smartDevices: []}]}},
        ]}}});
        if (query.includes("smartMeterTelemetry")) {
            const start = Date.parse(variables.s), end = Date.parse(variables.e), step = variables.g === "TEN_SECONDS" ? 10_000 : 1_800_000;
            const rows = [];
            for (let t = Math.ceil(start / step) * step; t < end; t += step) {
                rows.push({readAt: new Date(t).toISOString(), consumption: "1000.0", export: "0", demand: "512.0", consumptionDelta: step === 10_000 ? "1.4" : "250.0"});
            }
            return send(res, {data: {smartMeterTelemetry: rows}});
        }
        return send(res, {errors: [{message: "unknown query"}]});
    }
    const auth = Buffer.from((req.headers.authorization ?? "").replace("Basic ", ""), "base64").toString();
    if (auth !== `${goodKey}:` && !url.pathname.startsWith("/v1/products/")) return send(res, {detail: "Invalid API key"}, 401);
    if (url.pathname === "/v1/accounts/A-TEST0001/") return send(res, {number: "A-TEST0001", properties: [{moved_out_at: null, electricity_meter_points: [
        {mpan: "1900000000001", is_export: false, meters: [{serial_number: "21L000001"}], agreements: [{tariff_code: "E-1R-AGILE-24-10-01-C", valid_from: "2024-01-01T00:00:00Z", valid_to: null}]},
        {mpan: "1900000000002", is_export: true, meters: [{serial_number: "21L000001"}], agreements: [{tariff_code: "E-1R-OUTGOING-FIX-12M-19-05-13-C", valid_from: "2024-01-01T00:00:00Z", valid_to: null}]},
    ]}]});
    const consumption = url.pathname.match(/^\/v1\/electricity-meter-points\/(\d+)\/meters\/[^/]+\/consumption\/$/);
    if (consumption) {
        const from = Date.parse(url.searchParams.get("period_from")!), to = Math.min(Date.parse(url.searchParams.get("period_to")!), Date.now() - 86_400_000);
        const results = [];
        for (let t = Math.ceil(from / 1_800_000) * 1_800_000; t + 1_800_000 <= to; t += 1_800_000) {
            results.push({consumption: consumption[1].endsWith("1") ? 0.25 : 0.1, interval_start: new Date(t).toISOString(), interval_end: new Date(t + 1_800_000).toISOString()});
        }
        return send(res, {count: results.length, next: null, previous: null, results});
    }
    const rates = url.pathname.match(/^\/v1\/products\/([^/]+)\/electricity-tariffs\/([^/]+)\/(standard-unit-rates|standing-charges)\/$/);
    if (rates) {
        const exporting = rates[2].includes("OUTGOING");
        const value = rates[3] === "standing-charges" ? 50 : exporting ? 15 : 24;
        return send(res, {count: 1, next: null, previous: null, results: [{value_exc_vat: value / 1.05, value_inc_vat: value, valid_from: "2024-01-01T00:00:00Z", valid_to: null, payment_method: null}]});
    }
    const product = url.pathname.match(/^\/v1\/products\/([^/]+)\/$/);
    if (product) return send(res, {code: product[1], display_name: product[1].startsWith("AGILE") ? "Agile Octopus" : "Outgoing Octopus"});
    send(res, {detail: "Not found."}, 404);
}).listen(port, () => console.log(`fake octopus on ${port}`));
