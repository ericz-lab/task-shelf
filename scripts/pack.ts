/**
 * `bun run pack [-- --out DIR] [--sign-key FILE] [--variant bundle|source|both]`: this app's
 * installation packages (`.spaceapp`, ai-space docs/app-packages.md), built from the source tree
 * without changing it. This is ai-space's `space app release`: it reads space.release.yaml, runs its
 * build: section (`bun install --frozen-lockfile`, `bun run build`) in a scratch copy and packs
 * `task-shelf-<version>.spaceapp` (the bundle) and `task-shelf-<version>-source.spaceapp` (the same
 * with the source). A tag `v<version>` does the same in CI and signs (.github/workflows/release.yml).
 *
 * The CLI is SPACE_CLI (the `space` binary or ai-space's src/index.ts), else `space` on PATH, else
 * the Local edition's installed release.
 */
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const args = Bun.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const outDir = resolve(flag("--out") ?? join(tmpdir(), "space-packages"));
const signKey = flag("--sign-key");
const variant = flag("--variant") ?? "both";

const cli = await spaceCli();
const cmd = [...cli, "app", "release", root, "--output-dir", outDir, "--variant", variant, ...(signKey ? ["--sign-key", resolve(signKey)] : [])];
const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
process.exit(await proc.exited);

async function spaceCli(): Promise<string[]> {
  const asCommand = (path: string) => (path.endsWith(".ts") ? [process.execPath, path] : [path]);
  if (process.env.SPACE_CLI) return asCommand(process.env.SPACE_CLI);
  const onPath = Bun.which("space");
  if (onPath) return [onPath];
  for (const release of [join(homedir(), "Library/Application Support/ai-space/local/current"), join(homedir(), ".local/share/ai-space/local/current")]) {
    const index = join(release, "src/index.ts");
    if (await Bun.file(index).exists()) return asCommand(index);
  }
  throw new Error("ai-space's CLI was not found: set SPACE_CLI to the `space` binary or to ai-space's src/index.ts");
}
