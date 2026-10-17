import { readFile, readdir, rename, writeFile } from "node:fs/promises";

const outputDirectory = new URL("../dist/", import.meta.url);
const files = await readdir(outputDirectory);
const wasmFiles = files.filter((file) => file.endsWith(".wasm"));

if (wasmFiles.length !== 1) {
  throw new Error(`Expected exactly one WASM module, found ${wasmFiles.length}`);
}

const generatedWasmName = wasmFiles[0];
const deployedWasmName = "quickjs.wasm";
const workerPath = new URL("index.js", outputDirectory);
const sourceMapPath = new URL("index.js.map", outputDirectory);

if (generatedWasmName !== deployedWasmName) {
  await rename(
    new URL(generatedWasmName, outputDirectory),
    new URL(deployedWasmName, outputDirectory)
  );
}

const worker = await readFile(workerPath, "utf8");
const normalizedWorker = worker.replaceAll(generatedWasmName, deployedWasmName);

if (!normalizedWorker.includes(deployedWasmName)) {
  throw new Error("The Worker bundle does not import the normalized QuickJS WASM module");
}

await writeFile(workerPath, normalizedWorker);

const sourceMap = await readFile(sourceMapPath, "utf8");
await writeFile(sourceMapPath, sourceMap.replaceAll(generatedWasmName, deployedWasmName));
