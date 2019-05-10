import {
  SymbolInformation,
  DocumentSymbol,
  SymbolKind
} from "vscode-languageserver-types";
import { JSDOM, DOMWindow } from "jsdom";
import objectId from "object-hash";
import { fileURLToPath, pathToFileURL } from "url";
import { LSPSymbol } from "./lsp";
import * as path from "path";

type GXLEdgeType = "Source_Dependency" | "Enclosing";

interface GXLNodeAttributes {
  "Source.Name": string;
  "Source.Line": number;
  "Source.Column": number;
  "Source.Path": string;
}

const XLINK_NS = "http://www.w3.org/1999/xlink";

export function asGXL(
  symbolsByFile: Map<string, LSPSymbol[]>,
  references: Map<LSPSymbol, LSPSymbol[]>,
  rootPath: string
): string {
  const jsdom = new JSDOM(
    `<?xml version="1.0" encoding="utf-8"?>
    <gxl xmlns:xlink="http://www.w3.org/1999/xlink"></gxl>`,
    { contentType: "application/xml" }
  );
  const window = jsdom.window as DOMWindow & typeof globalThis;
  const document: XMLDocument = window.document;
  const graphElement = document.createElement("graph");
  document.documentElement.append("\n", graphElement);
  graphElement.setAttribute("id", objectId([symbolsByFile, references]));

  function createGXLType(type: string) {
    const typeEl = document.createElement("type");
    typeEl.setAttributeNS(XLINK_NS, "xlink:href", type);
    return typeEl;
  }

  function createGXLNode(
    id: string,
    type: string,
    attrs: GXLNodeAttributes
  ): Element {
    const node = document.createElement("node");
    node.setAttribute("id", id);
    node.append("\n  ", createGXLType(type));

    for (const [name, value] of Object.entries(attrs)) {
      if (value === null || value === undefined) {
        throw new Error(`Attribute ${name} for node ${id} has no value`);
      }
      addGXLAttribute(node, name, value);
    }

    node.append("\n");
    return node;
  }

  function createGXLEdge(from: string, to: string, type: GXLEdgeType): Element {
    const edge = document.createElement("edge");
    edge.setAttribute("from", from);
    edge.setAttribute("to", to);
    edge.append("\n  ", createGXLType(type), "\n");
    return edge;
  }

  function addGXLAttribute(
    node: Element,
    name: string,
    value: string | number
  ): void {
    let type: string;
    if (typeof value === "number" && Number.isInteger(value)) {
      type = "int";
    } else if (typeof value === "string") {
      type = "string";
    } else {
      throw new Error("Invalid type");
    }
    const attribute = document.createElement("attr");
    attribute.setAttribute("name", name);
    const valueElement = attribute.appendChild(document.createElement(type));
    valueElement.textContent = value.toString();
    node.append("\n  ", attribute);
  }

  const nodeIds = new Set<string>();
  const edgeNodeIds: { from: string; to: string }[] = [];

  for (const [uri, symbols] of symbolsByFile) {
    for (const symbol of symbols) {
      const type = getGXLSymbolKind(symbol);
      if (!type) {
        continue;
      }
      const nodeID = symbol.name + ":" + objectId(symbol);
      nodeIds.add(nodeID);
      const range = DocumentSymbol.is(symbol)
        ? symbol.range
        : symbol.location.range;

      // Add node for parent directory
      if (symbol.kind === SymbolKind.File) {
        const filePath = fileURLToPath(uri);
        const relativeFilePath = path.relative(rootPath, filePath);
        if (
          relativeFilePath !== ".." &&
          !relativeFilePath.startsWith(".." + path.sep)
        ) {
          const parentDirectoryUri = pathToFileURL(path.join(filePath, ".."))
            .href;
          const parentDirSymbol = symbolsByFile.get(parentDirectoryUri);
          if (parentDirSymbol) {
            console.log("Adding node for directory of", filePath);
            const edge = createGXLEdge(
              nodeID,
              objectId(parentDirSymbol),
              "Enclosing"
            );
            graphElement.append("\n", edge);
          } else {
            console.warn("No parent dir symbol for", symbol);
          }
        }
      } else {
        // Try to add an edge to containerName, if exists
        if (!DocumentSymbol.is(symbol)) {
          const container = symbols.find(s => s.name === symbol.containerName);
          if (container) {
            createGXLEdge(nodeID, objectId(container), "Enclosing");
          } else {
            // Add edge to containing file
            const fileSymbol = symbols.find(
              s =>
                s.kind === SymbolKind.File &&
                s.name === path.relative(rootPath, fileURLToPath(uri))
            )!;
            if (fileSymbol) {
              createGXLEdge(nodeID, objectId(fileSymbol), "Enclosing");
            }
          }
        }
      }

      const node = createGXLNode(nodeID, type, {
        "Source.Name": symbol.name,
        "Source.Line": range.start.line,
        "Source.Column": range.start.character,
        "Source.Path": path.relative(rootPath, fileURLToPath(uri))
      });
      graphElement.append("\n", node);

      // References
      for (const reference of references.get(symbol) || []) {
        const referenceNodeID = objectId(reference);
        edgeNodeIds.push({ from: referenceNodeID, to: nodeID });
        const edge = createGXLEdge(
          referenceNodeID,
          nodeID,
          "Source_Dependency"
        );
        graphElement.append("\n", edge);
      }
    }
  }

  // Verify
  for (const edge of edgeNodeIds) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      throw new Error(`Edge is referencing non-existant node`);
    }
  }

  const serializer = new window.XMLSerializer();
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    serializer.serializeToString(document)
  );
}

export function getGXLSymbolKind(symbol: LSPSymbol): string | undefined {
  switch (symbol.kind) {
    case SymbolKind.File:
    case SymbolKind.Module:
      return "File";
    case SymbolKind.Class:
      return "Class";
    case SymbolKind.Field:
    case SymbolKind.Property:
      return "Member";
    case SymbolKind.Method:
      return "Method";
    case SymbolKind.Function:
      return "Routine";
  }
}
