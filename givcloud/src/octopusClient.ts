// A small client for Octopus Energy's public API, used with the householder's own API key.
// REST (basic auth with the key) gives half-hourly meter readings, the account's meters and tariff rates;
// GraphQL (a short-lived token obtained with the key) gives the Home Mini's near-live readings.
export const defaultApiBase = process.env.OCTOPUS_API_BASE ?? "https://api.octopus.energy/v1";
export const krakenApiBase = "https://api.oegb-kraken.energy/v1";

export class OctopusError extends Error {}

export type MeterPoint = {
    mpan : string, is_export : boolean,
    meters : Array<{serial_number : string}>,
    agreements : Array<{tariff_code : string, valid_from : string | null, valid_to : string | null}>,
};
export type Account = {number : string, properties : Array<{moved_out_at : string | null, electricity_meter_points : Array<MeterPoint>}>};
export type Rate = {value_inc_vat : number, valid_from : string | null, valid_to : string | null, payment_method : string | null};
export type Interval = {consumption : number, interval_start : string, interval_end : string};
export type Telemetry = {readAt : string, consumption : string | null, export : string | null, demand : string | null, consumptionDelta : string | null};

// Tariff codes look like E-1R-AGILE-24-10-01-C: fuel, registers, product code, region.
export const productCode = (tariffCode : string) => tariffCode.split("-").slice(2, -1).join("-");
export const isSingleRate = (tariffCode : string) => tariffCode.startsWith("E-1R-");

export class OctopusClient {
    private jwt? : {token : string, expires : number};

    private readonly graphqlUrl : string;

    constructor(private readonly apiKey : string, readonly base = defaultApiBase) {
        this.graphqlUrl = `${base}/graphql/`;
    }

    private async request(url : string, init : RequestInit) : Promise<any> {
        let response : Response;
        try { response = await fetch(url, {...init, signal: AbortSignal.timeout(20_000)}); }
        catch (error) { throw new OctopusError(`Could not reach Octopus (${error instanceof Error ? error.message : error})`); }
        if (response.status === 401 || response.status === 403) throw new OctopusError("Octopus didn't accept the API key");
        if (!response.ok) throw new OctopusError(`Octopus replied ${response.status} ${response.statusText}`);
        return response.json();
    }

    private rest(path : string, params : Record<string, string | number> = {}) : Promise<any> {
        const url = new URL(path.startsWith("http") ? path : `${this.base}${path}`);
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
        return this.request(url.href, {headers: {authorization: "Basic " + Buffer.from(`${this.apiKey}:`).toString("base64")}});
    }

    private async restAll<T>(path : string, params : Record<string, string | number>) : Promise<Array<T>> {
        const results : Array<T> = [];
        let page = await this.rest(path, params);
        for (let i = 0; ; i++) {
            results.push(...(page.results ?? []));
            if (!page.next || i >= 40) return results;
            page = await this.rest(page.next);
        }
    }

    private async graphql(query : string, variables : Record<string, unknown> = {}, authorised = true) : Promise<any> {
        const headers : Record<string, string> = {"content-type": "application/json"};
        if (authorised) headers.authorization = await this.token();
        const body = await this.request(this.graphqlUrl, {method: "POST", headers, body: JSON.stringify({query, variables})});
        if (body.errors?.length) {
            const e = body.errors[0];
            throw new OctopusError(e.extensions?.errorDescription ?? e.message ?? "Octopus GraphQL error");
        }
        return body.data;
    }

    private async token() : Promise<string> {
        if (this.jwt && this.jwt.expires > Date.now()) return this.jwt.token;
        const data = await this.graphql(
            "mutation($key: String!) { obtainKrakenToken(input: {APIKey: $key}) { token } }", {key: this.apiKey}, false);
        const token = data?.obtainKrakenToken?.token;
        if (!token) throw new OctopusError("Octopus didn't accept the API key");
        this.jwt = {token, expires: Date.now() + 50 * 60_000};   // tokens last an hour
        return token;
    }

    async accountNumbers() : Promise<Array<string>> {
        const data = await this.graphql("{ viewer { accounts { number } } }");
        return (data?.viewer?.accounts ?? []).map((a : any) => a.number).filter(Boolean);
    }

    account(number : string) : Promise<Account> {
        return this.rest(`/accounts/${encodeURIComponent(number)}/`);
    }

    // The smart meter's current serial and its device ID (the Home Mini's readings are keyed by the meter's device).
    async activeMeters(number : string) : Promise<Array<{mpan : string, serialNumber : string, deviceIds : Array<{deviceId : string, type : string}>}>> {
        const data = await this.graphql(`query($n: String!) { account(accountNumber: $n) { electricityAgreements(active: true) {
            meterPoint { mpan meters(includeInactive: false) { serialNumber smartDevices { deviceId type } } } } } }`, {n: number});
        return (data?.account?.electricityAgreements ?? []).flatMap((a : any) => (a.meterPoint?.meters ?? []).map((m : any) => ({
            mpan: a.meterPoint.mpan, serialNumber: m.serialNumber,
            deviceIds: (m.smartDevices ?? []).map((d : any) => ({deviceId: d.deviceId, type: String(d.type ?? "")})),
        })));
    }

    consumption(mpan : string, serial : string, from : Date, to : Date) : Promise<Array<Interval>> {
        return this.restAll(`/electricity-meter-points/${mpan}/meters/${encodeURIComponent(serial)}/consumption/`,
            {period_from: from.toISOString(), period_to: to.toISOString(), page_size: 25000, order_by: "period"});
    }

    async rates(tariffCode : string, kind : "standard-unit-rates" | "standing-charges" | "day-unit-rates" | "night-unit-rates", from : Date, to : Date) : Promise<Array<Rate>> {
        const rates = await this.restAll<Rate>(
            `/products/${productCode(tariffCode)}/electricity-tariffs/${tariffCode}/${kind}/`,
            {period_from: from.toISOString(), period_to: to.toISOString(), page_size: 1500});
        // Some tariffs list prices for both payment methods; a smart-meter customer is almost always on direct debit.
        const directDebit = rates.filter((r) => r.payment_method === "DIRECT_DEBIT");
        return directDebit.length ? directDebit : rates.filter((r) => r.payment_method !== "NON_DIRECT_DEBIT");
    }

    async productName(tariffCode : string) : Promise<string> {
        try { return (await this.rest(`/products/${productCode(tariffCode)}/`)).display_name ?? tariffCode; }
        catch { return tariffCode; }
    }

    // With no period or grouping Octopus returns just the latest reading.
    async latestTelemetry(deviceId : string) : Promise<Array<Telemetry>> {
        const data = await this.graphql(`query($d: String!) { smartMeterTelemetry(deviceId: $d) { readAt consumption export demand consumptionDelta } }`, {d: deviceId});
        return data?.smartMeterTelemetry ?? [];
    }

    // Free-form telemetry query for diagnostics: any combination of period and grouping, times sent as given.
    async telemetryRaw(deviceId : string, args : {start? : string, end? : string, grouping? : string}) : Promise<Array<Telemetry>> {
        const decl = ["$d: String!", args.start ? "$s: DateTime" : "", args.end ? "$e: DateTime" : "", args.grouping ? "$g: TelemetryGrouping" : ""].filter(Boolean).join(", ");
        const call = ["deviceId: $d", args.start ? "start: $s" : "", args.end ? "end: $e" : "", args.grouping ? "grouping: $g" : ""].filter(Boolean).join(", ");
        const data = await this.graphql(`query(${decl}) { smartMeterTelemetry(${call}) { readAt consumption export demand consumptionDelta } }`,
            {d: deviceId, s: args.start, e: args.end, g: args.grouping});
        return data?.smartMeterTelemetry ?? [];
    }

    async telemetry(deviceId : string, start : Date, end : Date, grouping : "TEN_SECONDS" | "ONE_MINUTE" | "FIVE_MINUTES" | "HALF_HOURLY" | "HOURLY") : Promise<Array<Telemetry>> {
        const data = await this.graphql(`query($d: String!, $s: DateTime, $e: DateTime, $g: TelemetryGrouping) {
            smartMeterTelemetry(deviceId: $d, start: $s, end: $e, grouping: $g) { readAt consumption export demand consumptionDelta } }`,
            {d: deviceId, s: start.toISOString().replace(/\.\d{3}Z$/, "Z"), e: end.toISOString().replace(/\.\d{3}Z$/, "Z"), g: grouping});
        return data?.smartMeterTelemetry ?? [];
    }
}

// Some time-of-use tariffs (Intelligent Octopus Go, Octopus Go) publish only a day and a night rate, with the
// cheap window fixed by the product rather than listed per half hour.
const nightWindows : Array<[RegExp, number, number]> = [
    [/^(IOG|INTELLI)-/, 23 * 60 + 30, 5 * 60 + 30],     // 23:30–05:30
    [/^GO-/, 30, 5 * 60 + 30],                          // 00:30–05:30
];
export const nightWindow = (tariffCode : string) => nightWindows.find(([re]) => re.test(productCode(tariffCode)));

const clock = new Intl.DateTimeFormat("en-GB", {timeZone: process.env.HOME_TIME_ZONE ?? "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23"});
const minuteOfDay = (epochSeconds : number) => {
    const [h, m] = clock.format(new Date(epochSeconds * 1000)).split(":").map(Number);
    return h * 60 + m;
};

export type UnitRates = {rateAt : (epochSeconds : number) => number | null, kind : "half-hourly" | "day-night"};

// The import or export unit rate for each moment in a period, whichever way the tariff publishes it.
export const unitRates = async (api : OctopusClient, tariffCode : string, from : Date, to : Date) : Promise<UnitRates | null> => {
    const standard = await api.rates(tariffCode, "standard-unit-rates", from, to);
    if (standard.length) return {kind: "half-hourly", rateAt: (t) => rateAt(standard, t)};
    const window = nightWindow(tariffCode);
    if (!window) return null;
    const [day, night] = await Promise.all([api.rates(tariffCode, "day-unit-rates", from, to), api.rates(tariffCode, "night-unit-rates", from, to)]);
    if (!day.length || !night.length) return null;
    const [, start, end] = window;
    return {kind: "day-night", rateAt: (t) => {
        const m = minuteOfDay(t);
        const isNight = start > end ? (m >= start || m < end) : (m >= start && m < end);
        return rateAt(isNight ? night : day, t);
    }};
};

// The rate in force at a moment, from a list of rates with open or closed validity windows.
export const rateAt = (rates : Array<Rate>, epochSeconds : number) : number | null => {
    const t = epochSeconds * 1000;
    const r = rates.find((x) => (!x.valid_from || Date.parse(x.valid_from) <= t) && (!x.valid_to || t < Date.parse(x.valid_to)));
    return r ? r.value_inc_vat : null;
};
