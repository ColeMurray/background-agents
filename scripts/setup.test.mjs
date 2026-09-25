import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const setup = fileURLToPath(new URL("../.openinspect/setup.sh", import.meta.url));

test("setup warns on Node 22 and installs dependencies", async () => {
  const bin = await mkdtemp(join(tmpdir(), "openinspect-setup-"));
  try {
    const shims = {
      node: '#!/bin/sh\nif [ "$1" = "-p" ]; then printf "22\\n"; else printf "v22.23.2\\n"; fi\n',
      npm: '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SETUP_CALLS"\n',
      npx: "#!/bin/sh\nexit 0\n",
      python3: '#!/bin/sh\nprintf "11\\n"\n',
    };
    for (const [name, content] of Object.entries(shims)) {
      const path = join(bin, name);
      await writeFile(path, content);
      await chmod(path, 0o755);
    }

    const calls = join(bin, "calls");
    const result = spawnSync("bash", [setup], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SETUP_CALLS: calls },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /WARN:.*Node\.js >= 24 required \(found v22\.23\.2\)/);
    assert.match(
      await readFile(calls, "utf8"),
      /^install\nrun build -w @open-inspect\/shared\nrun typecheck\n$/
    );
  } finally {
    await rm(bin, { recursive: true, force: true });
  }
});
