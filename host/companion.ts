/** Paired session supervisor. YouTube and encoders live in its provider worker. */
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { connectOffloadProvider } from "../vendor/pocketjs/tools/offload-provider.ts";

const args = process.argv.slice(2);
const value = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const address = value("--device");
if (!address) throw new Error("Usage: bun run serve:3ds --device <IP> [--advertise <Mac IPv4>]");
const interfaces = Object.values(networkInterfaces()).flat().filter(v => v?.family === "IPv4" && !v.internal);
const advertiseHost = value("--advertise") ?? interfaces.find(v => v!.address.split(".").slice(0, 3).join(".") === address.split(".").slice(0, 3).join("."))?.address;
if (!advertiseHost) throw new Error("Specify --advertise with the Mac IPv4 reachable by the console");
const key = readFileSync(value("--key") ?? ".pocket/offload.key", "utf8").trim();
if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("Invalid pairing key; run bun run deploy:3ds first");
const provider = connectOffloadProvider({ address, key, worker: new URL("./companion-worker.ts", import.meta.url), data: { advertiseHost }, log: console.log });
console.log(`Pocket YouTube companion: ${address}:8741; media advertised on ${advertiseHost}`);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { provider.close(); process.exit(); });
