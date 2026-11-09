import {randomBytes, timingSafeEqual} from "node:crypto";
import {Actor, SecretStore} from "anbaric";

const secretName = "givlocal-collector-token";

// The home collector proves itself with a long random token kept in the secret store,
// created the first time the app starts and shown only to signed-in users.
export class CollectorToken {
    private value? : string;

    constructor(private readonly secrets : SecretStore, private readonly actor : Actor) {}

    async get() : Promise<string> {
        if (this.value) return this.value;
        try {
            this.value = await this.secrets.retrieve(secretName, this.actor);
        } catch {
            this.value = randomBytes(24).toString("base64url");
            await this.secrets.create(this.actor, secretName, this.value);
        }
        return this.value;
    }

    async matches(header : string | Array<string> | undefined) : Promise<boolean> {
        const presented = Buffer.from(typeof header === "string" ? header.trim() : "");
        const expected = Buffer.from(await this.get());
        return presented.length === expected.length && timingSafeEqual(presented, expected);
    }
}
