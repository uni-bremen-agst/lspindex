import yargs = require("yargs");
import {
  WorkspaceSymbolRequest,
  InitializeRequest,
  InitializeParams,
  ShutdownRequest,
  DocumentSymbolRequest,
  SymbolInformation,
  DocumentSymbol,
  DocumentSymbolParams,
  ReferenceParams,
  ReferencesRequest,
  Location,
  SymbolKind
} from "vscode-languageserver-protocol";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter
} from "vscode-jsonrpc";
import { spawn } from "child_process";
import * as path from "path";
import { pathToFileURL, fileURLToPath } from "url";
import glob from "fast-glob";
import { asGXL, getGXLSymbolKind } from "./gxl";
import { writeFile, readFile } from "mz/fs";
import { Range } from "@sourcegraph/extension-api-classes";
import { LSPSymbol } from "./lsp";
import { sortBy, invert } from "lodash";

const symbolSizes = (invert(
  [
    SymbolKind.Package,
    SymbolKind.Namespace,
    SymbolKind.File,
    SymbolKind.Module,
    SymbolKind.Class,
    SymbolKind.Function,
    SymbolKind.Enum,
    SymbolKind.Interface,
    SymbolKind.Method,
    SymbolKind.Constructor,
    SymbolKind.Field,
    SymbolKind.Property,
    SymbolKind.EnumMember,
    SymbolKind.Variable,
    SymbolKind.TypeParameter,
    SymbolKind.Constant,
    SymbolKind.String,
    SymbolKind.Number,
    SymbolKind.Boolean,
    SymbolKind.Array,
    SymbolKind.Object,
    SymbolKind.Key,
    SymbolKind.Null,
    SymbolKind.Struct,
    SymbolKind.Event,
    SymbolKind.Operator
  ].reverse()
) as any) as Record<SymbolKind, number>;
console.log(symbolSizes);

async function main() {
  const using: (() => any)[] = [];
  try {
    const argv = yargs
      .option("rootPath", {
        type: "string",
        demandOption: true,
        description:
          "The rootUri to pass to the language server in the initialize message"
      })
      .option("filePattern", {
        type: "string",
        description:
          "Glob pattern for files that symbols should be collected from (relative to rootPath)"
      })
      .option("outFile", {
        type: "string",
        description: "The file path to the output GXL file",
        demandOption: true
      })
      .option("noReferences", {
        type: "boolean",
        description: "Do not include references"
      })
      .usage("lsp2gxl --rootUri <rootUri> <language server command to run>")
      .example(
        `lsp2gxl --rootPath /Users/felix/git/flask --filePattern '**/*.py' --outFile flask.gxl pyls`,
        "Analyze Python files in the flask project with the Python language server and write the result to flask.gxl"
      )
      .help().argv;
    if (argv._.length < 1) {
      console.error("No language server command given");
      process.exitCode = 1;
      return;
    }
    console.log("running", argv._);

    let json: any | undefined;
    // try {
    //   json = JSON.parse(
    //     await readFile(argv.outFile.replace(/\.gxl$/, ".json"), "utf-8")
    //   );
    // } catch (err) {
    //   console.error(err.message);
    // }

    // Spawn language server
    const childProcess = spawn(argv._[0], argv._.slice(1));
    using.push(() => childProcess.kill());
    const connection = createMessageConnection(
      new StreamMessageReader(childProcess.stdout),
      new StreamMessageWriter(childProcess.stdin),
      console
    );
    connection.listen();
    using.push(() => connection.sendRequest(ShutdownRequest.type));
    connection.onError(err => console.error(err));

    // Initialize
    const rootPath = path.resolve(argv.rootPath);
    const initParams: InitializeParams = {
      rootPath,
      rootUri: pathToFileURL(rootPath).href,
      processId: process.pid,
      capabilities: {},
      workspaceFolders: null
    };
    const initResult = await connection.sendRequest(
      InitializeRequest.type,
      initParams
    );
    console.log("initialize result", initResult);

    // Query symbols
    /** Map from URI to symbols */
    const symbols = new Map<string, LSPSymbol[]>();
    /** Map from definition to references */
    const allReferences = new Map<LSPSymbol, Location[]>();
    const symbolToSymbolReferences = new Map<LSPSymbol, LSPSymbol[]>();

    if (!argv.filePattern) {
      console.error("No file pattern provided");
      process.exitCode = 1;
      return;
    }
    const files = glob.stream(argv.filePattern, {
      absolute: true,
      cwd: rootPath,
      onlyFiles: true
    });
    for await (const file of files) {
      const uri = pathToFileURL(file.toString()).href;
      const relativePath = path.relative(rootPath, file.toString());
      const docParams: DocumentSymbolParams = { textDocument: { uri } };
      console.log("Getting symbols for", file);
      const docSymbols: LSPSymbol[] =
        (await connection.sendRequest(DocumentSymbolRequest.type, docParams)) ||
        [];
      symbols.set(uri, docSymbols.filter(getGXLSymbolKind));

      // Add symbols for directories
      const segments = file.toString().split(path.sep);
      while (segments.pop()) {
        const dir = segments.join(path.sep);
        const relativeDirPath = path.relative(rootPath, dir);
        if (
          relativeDirPath === ".." ||
          relativeDirPath.startsWith(".." + path.sep)
        ) {
          break;
        }
        const uri = pathToFileURL(dir).href;
        if (!symbols.has(uri)) {
          symbols.set(uri, [
            {
              name: path.basename(dir),
              containerName: path.basename(path.join(dir, "..")),
              kind: SymbolKind.File,
              location: {
                uri,
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 0 }
                }
              }
            }
          ]);
        }
      }

      // Get references for each symbol
      if (!argv.noReferences) {
        for (const symbol of docSymbols) {
          if (!getGXLSymbolKind(symbol)) {
            continue;
          }
          const range = DocumentSymbol.is(symbol)
            ? symbol.selectionRange
            : symbol.location.range;
          const referencePosition = range.start;
          const content = await readFile(file, { encoding: "utf-8" });
          const lineContent = content.split("\n")[range.start.line];
          // Don't get references on import bindings
          if (/\bimport\b/.test(lineContent)) {
            continue;
          }
          if (
            lineContent.slice(referencePosition.character).startsWith("def ")
          ) {
            referencePosition.character += "def ".length + 1;
          }
          if (
            lineContent.slice(referencePosition.character).startsWith("class ")
          ) {
            referencePosition.character += "class ".length + 1;
          }
          console.log("\nGetting references for", symbol.name);
          console.log(
            lineContent.slice(0, range.start.character) +
              "❗️" +
              lineContent.slice(range.start.character)
          );
          const referenceParams: ReferenceParams = {
            context: { includeDeclaration: false },
            textDocument: { uri },
            position: referencePosition
          };
          const references = await connection.sendRequest(
            ReferencesRequest.type,
            referenceParams
          );
          console.log("references", references && references.length);
          allReferences.set(symbol, references || []);
        }
      }

      // Add symbol for file
      docSymbols.push({
        name: path.basename(relativePath),
        containerName: path.basename(path.join(relativePath, "..")),
        kind: SymbolKind.File,
        location: {
          uri: pathToFileURL(file.toString()).href,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 }
          }
        }
      });
    }

    // After knowing all symbols:
    // For each reference, check all symbol ranges to find the symbol range the reference is contained in.
    for (const [definitionSymbol, references] of allReferences) {
      const referencingSymbols: LSPSymbol[] = [];
      for (const reference of references) {
        const documentSymbols: LSPSymbol[] | undefined = symbols.get(
          reference.uri
        );
        if (!documentSymbols) {
          continue;
        }
        const referenceRange = Range.fromPlain(reference.range);
        // Prefer smaller symbols
        sortBy(documentSymbols.slice(0), s => symbolSizes[s.kind]);
        const referencingSymbol = documentSymbols.find(symbol =>
          Range.fromPlain(
            DocumentSymbol.is(symbol) ? symbol.range : symbol.location.range
          ).contains(referenceRange)
        );
        if (!referencingSymbol) {
          console.log(
            `Reference to ${definitionSymbol.name} was not within any symbol`
          );
          continue;
        }
        if (!getGXLSymbolKind(referencingSymbol)) {
          console.log(
            `Reference of ${referencingSymbol.name} to ${
              definitionSymbol.name
            } excluded because it is of kind ${getGXLSymbolKind(
              referencingSymbol
            )}`
          );
        }
        console.log(
          `Mapped reference from ${referencingSymbol.name} to ${
            definitionSymbol.name
          }`
        );
        referencingSymbols.push(referencingSymbol);
      }
      symbolToSymbolReferences.set(definitionSymbol, referencingSymbols);
    }

    const outFile = path.resolve(argv.outFile);
    // await writeFile(
    //   outFile.replace(/\.gxl$/, ".json"),
    //   JSON.stringify(
    //     {
    //       symbols: [...symbols],
    //       allReferences: [...allReferences],
    //       symbolToSymbolReferences: [...symbolToSymbolReferences]
    //     },
    //     null,
    //     2
    //   )
    // );
    const gxl = asGXL(symbols, symbolToSymbolReferences, rootPath);
    await writeFile(outFile, gxl);
    console.log("wrote result to", outFile);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    for (const fn of using) {
      await fn();
    }
  }
}

main();