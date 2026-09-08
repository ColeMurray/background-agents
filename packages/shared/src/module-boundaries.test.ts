import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = path.resolve(import.meta.dirname);
const ROOT_BARREL = path.join(SOURCE_ROOT, "index.ts");
const TYPES_BARREL = path.join(SOURCE_ROOT, "types", "index.ts");
const BARRELS = new Set([ROOT_BARREL, TYPES_BARREL]);

interface Dependency {
  specifier: string;
  target?: string;
  runtime: boolean;
}

function collectProductionModules(directory: string): string[] {
  return readdirSync(directory)
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry);
      return statSync(entryPath).isDirectory() ? collectProductionModules(entryPath) : [entryPath];
    })
    .filter((filePath) => filePath.endsWith(".ts") && !filePath.endsWith(".test.ts"))
    .sort();
}

function resolveRelativeModule(
  sourcePath: string,
  specifier: string,
  modules: ReadonlySet<string>
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;

  const unresolvedPath = path.resolve(path.dirname(sourcePath), specifier);
  const candidates = [
    unresolvedPath,
    `${unresolvedPath}.ts`,
    path.join(unresolvedPath, "index.ts"),
  ];

  return candidates.find((candidate) => modules.has(candidate));
}

function importHasRuntimeEdge(declaration: ts.ImportDeclaration): boolean {
  const clause = declaration.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name || (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))) {
    return true;
  }
  if (!clause.namedBindings) return false;

  const elements = clause.namedBindings.elements;
  return elements.length === 0 || elements.some((element) => !element.isTypeOnly);
}

function exportHasRuntimeEdge(declaration: ts.ExportDeclaration): boolean {
  if (declaration.isTypeOnly) return false;
  if (!declaration.exportClause || ts.isNamespaceExport(declaration.exportClause)) return true;

  const elements = declaration.exportClause.elements;
  return elements.length === 0 || elements.some((element) => !element.isTypeOnly);
}

function collectDependencies(sourcePath: string, modules: ReadonlySet<string>): Dependency[] {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    readFileSync(sourcePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const dependencies: Dependency[] = [];

  function addDependency(specifier: ts.Expression, runtime: boolean): void {
    if (!ts.isStringLiteralLike(specifier)) return;
    const target = resolveRelativeModule(sourcePath, specifier.text, modules);
    if (target || specifier.text.startsWith("@open-inspect/shared")) {
      dependencies.push({ specifier: specifier.text, target, runtime });
    }
  }

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      addDependency(statement.moduleSpecifier, importHasRuntimeEdge(statement));
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      addDependency(statement.moduleSpecifier, exportHasRuntimeEdge(statement));
    }
  }
  return dependencies;
}

function relativePath(filePath: string): string {
  return path.relative(SOURCE_ROOT, filePath).split(path.sep).join("/");
}

function findRuntimeCycle(graph: ReadonlyMap<string, readonly string[]>): string[] | undefined {
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];

  function visit(modulePath: string): string[] | undefined {
    if (active.has(modulePath)) {
      const cycleStart = stack.indexOf(modulePath);
      return [...stack.slice(cycleStart), modulePath];
    }
    if (visited.has(modulePath)) return undefined;

    visited.add(modulePath);
    active.add(modulePath);
    stack.push(modulePath);

    for (const dependency of graph.get(modulePath) ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }

    stack.pop();
    active.delete(modulePath);
    return undefined;
  }

  for (const modulePath of [...graph.keys()].sort()) {
    const cycle = visit(modulePath);
    if (cycle) return cycle;
  }
  return undefined;
}

describe("shared module boundaries", () => {
  const modules = collectProductionModules(SOURCE_ROOT);
  const moduleSet = new Set(modules);
  const dependencies = new Map(
    modules.map((modulePath) => [modulePath, collectDependencies(modulePath, moduleSet)])
  );

  it("does not import the package-root or shared-types barrels from implementation modules", () => {
    const violations = modules.flatMap((modulePath) => {
      if (BARRELS.has(modulePath)) return [];
      return (dependencies.get(modulePath) ?? [])
        .filter(
          ({ specifier, target }) =>
            (target !== undefined && BARRELS.has(target)) ||
            specifier === "@open-inspect/shared" ||
            specifier.startsWith("@open-inspect/shared/")
        )
        .map(({ specifier, target }) =>
          target
            ? `${relativePath(modulePath)} -> ${relativePath(target)}`
            : `${relativePath(modulePath)} -> ${specifier}`
        );
    });

    expect(violations).toEqual([]);
  });

  it("has no runtime dependency cycles", () => {
    const runtimeGraph = new Map(
      modules.map((modulePath) => [
        modulePath,
        [
          ...new Set(
            (dependencies.get(modulePath) ?? [])
              .filter(
                (dependency): dependency is Dependency & { target: string } =>
                  dependency.runtime && dependency.target !== undefined
              )
              .map(({ target }) => target)
          ),
        ].sort(),
      ])
    );
    const cycle = findRuntimeCycle(runtimeGraph)?.map(relativePath);

    expect(cycle?.join(" -> ")).toBeUndefined();
  });
});
