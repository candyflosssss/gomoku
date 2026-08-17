import { cpSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const repository = resolve(import.meta.dirname, "..");
const source = resolve(repository, "web");
const output = resolve(repository, "dist");

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
cpSync(source, output, { recursive: true });

console.log(`Built static site at ${output}`);
