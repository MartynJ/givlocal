// A stand-in for boilerjuice.com, for trying the oil panel without a real account:
//   npx tsx test/fakeBoilerJuice.ts            (listens on 4020)
//   BOILERJUICE_BASE=http://localhost:4020 npx tsx src/main.ts
// Sign in on the dashboard with the test account below. The tank level falls by 7 litres on each read.
import {createServer} from "node:http";
import {samplePage} from "./oilFixtures.js";

export const testAccount = {email: "tester@example.test", password: "fake-boilerjuice-pass"};
const token = "csrf-token-for-tests";
let level = 900;

const loginPage = `<form class="new_user" id="new_user" action="/uk/users/login" method="post">
  <input type="hidden" name="authenticity_token" value="${token}" autocomplete="off" />
  <input type="email" name="user[email]" id="user_email" /><input type="password" name="user[password]" id="user_password" /></form>`;

createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const signedIn = /(^|;\s*)jwt=ok/.test(req.headers.cookie ?? "");
    const send = (status : number, body : string, headers : Record<string, string | Array<string>> = {}) => {
        res.writeHead(status, {"content-type": "text/html", ...headers}); res.end(body);
    };
    if (url.pathname === "/uk/users/login" && req.method === "GET")
        return send(200, loginPage, {"set-cookie": "_uk_public_session=abc; path=/; httponly"});
    if (url.pathname === "/uk/users/login" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => body += c);
        req.on("end", () => {
            const form = new URLSearchParams(body);
            const ok = form.get("authenticity_token") === token && form.get("user[email]") === testAccount.email
                && form.get("user[password]") === testAccount.password;
            if (ok) send(302, "", {location: "/uk/users/dashboard", "set-cookie": ["jwt=ok; path=/; httponly", "_uk_public_session=def; path=/"]});
            else send(200, loginPage);
        });
        return;
    }
    if (!signedIn) return send(302, "", {location: "/uk/users/login"});
    if (url.pathname === "/uk/users/dashboard") return send(200, "<p>Welcome</p>");
    if (url.pathname === "/uk/users/tanks") return send(200, `<a href="/uk/users/tanks/777/edit">My tank</a>`);
    if (url.pathname === "/uk/users/tanks/777/edit") {
        level -= 7;
        return send(200, samplePage(level, level + 100));
    }
    send(404, "not found");
}).listen(4020, () => console.log("fake BoilerJuice on 4020"));
