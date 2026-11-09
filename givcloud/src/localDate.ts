// The inverter resets its day counters at local midnight, so days are grouped in the home's time zone.
export const homeTimeZone = process.env.HOME_TIME_ZONE ?? "Europe/London";

const dateFormat = new Intl.DateTimeFormat("en-CA", {timeZone: homeTimeZone, year: "numeric", month: "2-digit", day: "2-digit"});

export const localDate = (epochSeconds : number) : string => dateFormat.format(new Date(epochSeconds * 1000));

export const today = () : string => localDate(Date.now() / 1000);

export const isDate = (value : unknown) : value is string =>
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

export const addDays = (date : string, days : number) : string => {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
};

const offsetFormat = new Intl.DateTimeFormat("en-GB", {timeZone: homeTimeZone, timeZoneName: "longOffset"});

// Minutes ahead of UTC in the home time zone at a moment ("GMT+01:00" → 60).
const offsetMinutes = (epochMs : number) : number => {
    const name = offsetFormat.formatToParts(new Date(epochMs)).find((p) => p.type === "timeZoneName")?.value ?? "";
    const m = name.match(/([+-])(\d{1,2}):?(\d{2})?/);
    return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
};

// Epoch seconds of local midnight at the start of a date (days are 23 or 25 hours at clock changes).
export const dayStart = (date : string) : number => {
    const utcMidnight = Date.parse(`${date}T00:00:00Z`);
    let t = utcMidnight - offsetMinutes(utcMidnight) * 60_000;
    t = utcMidnight - offsetMinutes(t) * 60_000;
    return t / 1000;
};

export const dayEnd = (date : string) : number => dayStart(addDays(date, 1));
