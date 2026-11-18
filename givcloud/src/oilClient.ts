// Reads the oil tank level from boilerjuice.com. BoilerJuice has no API: like the community boilerjuice-tank-api
// project, this signs in with the householder's own BoilerJuice account and reads the figures off the tank page.
const site = process.env.BOILERJUICE_BASE ?? "https://www.boilerjuice.com";
const loginPath = "/uk/users/login";
const tanksPath = "/uk/users/tanks";
const userAgent = "Mozilla/5.0 (compatible; GivLocal home energy dashboard)";

export class OilError extends Error {}

export type TankReading = {
    litres : number | null,          // usable oil, as BoilerJuice reports it
    totalLitres : number | null,     // all the oil in the tank, including what sits below the outlet
    percent : number | null,
    totalPercent : number | null,
    capacity : number | null,
    levelName : string | null,       // BoilerJuice's own label: High, Medium or Low
};

const number = (text : string | undefined) => {
    if (text == null) return null;
    const n = Number(text.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
};

const decode = (text : string) => text.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// The value of an attribute on the first tag that has another given attribute, whatever order they come in.
const attributeOf = (html : string, has : RegExp, attribute : string) => {
    for (const tag of html.match(/<[a-z]+\b[^>]*>/gi) ?? []) {
        if (!has.test(tag)) continue;
        const m = tag.match(new RegExp(`\\b${attribute}\\s*=\\s*"([^"]*)"`, "i"));
        if (m) return m[1];
    }
    return undefined;
};

// The part of the page from the element whose id contains `id`, so a percentage can be tied to the right gauge.
// An exact id is preferred: the connected-tank page also has tabs whose ids merely contain it.
const sectionAfter = (html : string, id : string) => {
    let at = html.search(new RegExp(`id\\s*=\\s*"${id}"`, "i"));
    if (at < 0) at = html.search(new RegExp(`id\\s*=\\s*"[^"]*${id}[^"]*"`, "i"));
    return at < 0 ? "" : html.slice(at, at + 4000);
};

export const parseTankPage = (html : string) : TankReading => {
    const text = decode(html);
    const usable = sectionAfter(html, "usable-oil"), total = sectionAfter(html, "total-oil");
    const reading : TankReading = {
        litres: number(text.match(/([\d,]+(?:\.\d+)?)\s*litres\s+of\s+usable\s+oil/i)?.[1]),
        totalLitres: number(text.match(/([\d,]+(?:\.\d+)?)\s*litres\s+of\s+oil\s+left/i)?.[1]),
        percent: number(usable.match(/data-percentage\s*=\s*"([\d.]+)"/i)?.[1]),
        totalPercent: number(total.match(/data-percentage\s*=\s*"([\d.]+)"/i)?.[1]),
        capacity: number(attributeOf(html, /(title|id)\s*=\s*"tank-size-count"|(id|name)\s*=\s*"tank_size"/i, "value")),
        levelName: html.match(/class\s*=\s*"status"[^>]*>\s*<p[^>]*>\s*([^<]{1,30}?)\s*</i)?.[1] ?? null,
    };
    // A tank without a monitor gets one gauge, for all the oil, even though it sits where the usable-oil one would.
    if (reading.litres == null && reading.totalLitres != null && reading.totalPercent == null) {
        reading.totalPercent = reading.percent;
        reading.percent = null;
    }
    if (reading.litres == null && reading.totalLitres == null && reading.percent == null)
        throw new OilError("Couldn't find the oil level on BoilerJuice's tank page – the page may have changed");
    return reading;
};

export type OilOrder = {order : string, ordered : string, delivered : string | null, litres : number, pencePerLitre : number | null, status : string};

const months : Record<string, string> = {jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12"};
const isoDate = (d : string, m : string, y : string) => months[m.slice(0, 3).toLowerCase()] ? `${y}-${months[m.slice(0, 3).toLowerCase()]}-${d.padStart(2, "0")}` : null;

// The oil orders table: order number, date ordered, litres, price in pence per litre and a status that says when it was delivered.
export const parseOrdersPage = (html : string) : Array<OilOrder> => {
    const text = decode(html.replace(/<script[\s\S]*?<\/script>/gi, " "));
    const start = text.search(/Processed Orders/i);
    const section = start < 0 ? text : text.slice(start, (text.slice(start).search(/Shop Orders/i) + start) || undefined);
    const row = /(\d{5,})\s+(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})\s+at\s+[\d:]+\s*[ap]m\s+([\d,]+(?:\.\d+)?)\s+([\d.]+)\s+(.*?)(?=\s+\d{5,}\s+\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}\s+at|$)/gi;
    const orders : Array<OilOrder> = [];
    for (const m of section.matchAll(row)) {
        const ordered = isoDate(m[2], m[3], m[4]), litres = number(m[5]);
        if (!ordered || litres == null) continue;
        const status = m[7].replace(/\s*(View|Print)( order)?\s*/gi, " ").trim().slice(0, 80);
        const d = status.match(/delivered\s+on\s+(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/i);
        orders.push({order: m[1], ordered, delivered: d ? isoDate(d[1], d[2], d[3]) : null, litres, pencePerLitre: number(m[6]), status});
    }
    return orders;
};

export const tankIdsOnPage = (html : string) =>
    [...new Set([...html.matchAll(/\/uk\/users\/tanks\/(\d+)(?:\/edit)?["'?#/]/g)].map((m) => m[1]))];

export class BoilerJuiceClient {
    private cookies = new Map<string, string>();
    private signedIn = false;

    constructor(private readonly email : string, private readonly password : string) {}

    private keep(response : Response) {
        for (const line of response.headers.getSetCookie()) {
            const [pair] = line.split(";");
            const eq = pair.indexOf("=");
            if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }
    }

    // Follows redirects by hand so the cookies set along the way are kept.
    private async request(path : string, init : RequestInit = {}) : Promise<{html : string, url : string}> {
        let url = new URL(path, site).href;
        for (let hop = 0; hop < 6; hop++) {
            let response : Response;
            try {
                response = await fetch(url, {...init, redirect: "manual", signal: AbortSignal.timeout(30_000), headers: {
                    ...(init.headers as Record<string, string> ?? {}), "user-agent": userAgent,
                    cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
                }});
            } catch (error) {
                throw new OilError(`Could not reach BoilerJuice (${error instanceof Error ? error.message : error})`);
            }
            this.keep(response);
            const location = response.headers.get("location");
            if (response.status >= 300 && response.status < 400 && location) {
                url = new URL(location, url).href;
                init = {};    // after a redirect it's a plain GET
                continue;
            }
            if (!response.ok) throw new OilError(`BoilerJuice replied ${response.status} ${response.statusText}`);
            return {html: await response.text(), url};
        }
        throw new OilError("BoilerJuice kept redirecting");
    }

    async signIn() {
        this.cookies.clear();
        const page = await this.request(loginPath);
        const token = attributeOf(page.html, /name\s*=\s*"authenticity_token"/i, "value");
        if (!token) throw new OilError("Couldn't find BoilerJuice's sign-in form – the page may have changed");
        const form = new URLSearchParams({
            "authenticity_token": token, "user[email]": this.email, "user[password]": this.password, "commit": "Log in",
        });
        const after = await this.request(loginPath, {method: "POST", body: form.toString(), headers: {
            "content-type": "application/x-www-form-urlencoded", referer: new URL(loginPath, site).href,
        }});
        if (!this.cookies.has("jwt") || new URL(after.url).pathname === loginPath)
            throw new OilError("BoilerJuice didn't accept that email and password");
        this.signedIn = true;
    }

    // A page that needs signing in; signs in again if the session has run out.
    private async page(path : string) {
        if (!this.signedIn) await this.signIn();
        let result = await this.request(path);
        if (new URL(result.url).pathname === loginPath) {
            await this.signIn();
            result = await this.request(path);
        }
        return result;
    }

    async tanks() : Promise<Array<string>> {
        const result = await this.page(tanksPath);
        const fromUrl = new URL(result.url).pathname.match(/\/uk\/users\/tanks\/(\d+)/)?.[1];
        const ids = tankIdsOnPage(result.html);
        return fromUrl && !ids.includes(fromUrl) ? [fromUrl, ...ids] : ids;
    }

    // Any signed-in page on the account, for working out where BoilerJuice keeps things.
    async raw(path : string) { return this.page(path); }

    // The connected-tank page (for a tank with a BoilerJuice monitor) has usable and total oil; the tank's own page has
    // the size, and is all there is for a tank without a monitor.
    async tank(id : string) : Promise<TankReading> {
        if (!/^\d+$/.test(id)) throw new OilError("Bad tank id");
        const own = () => this.page(`${tanksPath}/${id}/edit`).then((p) => parseTankPage(p.html));
        let connected : TankReading | null = null;
        try { connected = parseTankPage((await this.page("/uk/users/connected_tank")).html); } catch { /* no monitor */ }
        if (!connected) return own();
        if (connected.capacity == null) connected.capacity = (await own().catch(() => null))?.capacity ?? null;
        return connected;
    }

    async orders() : Promise<Array<OilOrder>> {
        return parseOrdersPage((await this.page("/uk/users/orders")).html);
    }
}
