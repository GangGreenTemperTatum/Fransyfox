import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const files = [
  'src/background.ts',
  'src/bridge.ts',
  'src/main.ts',
  'src/panel-main.ts',
  'src/panel-modals.ts',
  'src/panel-storage.ts',
  'src/panel-ui-findings.ts',
  'src/panel-ui-messages.ts',
  'src/panel-ui.ts'
].map((file) => path.join(ROOT, file));

const factory = ts.factory;
const anyType = factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword);
const anyArrayType = factory.createArrayTypeNode(anyType);
const recordAnyType = factory.createTypeReferenceNode('Record', [factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword), anyType]);

function addIndexSignatureIfMissing(node) {
  if (!ts.isClassDeclaration(node) || !node.name) {
    return node;
  }

  const hasIndexSignature = node.members.some((member) => ts.isIndexSignatureDeclaration(member));
  if (hasIndexSignature) {
    return node;
  }

  const indexSignature = factory.createIndexSignature(
    undefined,
    [factory.createParameterDeclaration(undefined, undefined, factory.createIdentifier('key'), undefined, factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword), undefined)],
    anyType
  );

  return factory.updateClassDeclaration(
    node,
    node.modifiers,
    node.name,
    node.typeParameters,
    node.heritageClauses,
    [indexSignature, ...node.members]
  );
}

function transformSourceFile(sourceFile) {
  const transformer = (context) => {
    const visit = (node) => {
      if (ts.isParameter(node) && !node.type) {
        return factory.updateParameterDeclaration(
          node,
          node.modifiers,
          node.dotDotDotToken,
          node.name,
          node.questionToken,
          anyType,
          node.initializer
        );
      }

      if (ts.isVariableDeclaration(node) && !node.type && node.initializer) {
        if (ts.isArrayLiteralExpression(node.initializer)) {
          return factory.updateVariableDeclaration(node, node.name, node.exclamationToken, anyArrayType, node.initializer);
        }

        if (ts.isObjectLiteralExpression(node.initializer)) {
          return factory.updateVariableDeclaration(node, node.name, node.exclamationToken, recordAnyType, node.initializer);
        }
      }

      const visited = ts.visitEachChild(node, visit, context);
      if (ts.isClassDeclaration(visited)) {
        return addIndexSignatureIfMissing(visited);
      }

      return visited;
    };

    return (node) => ts.visitNode(node, visit);
  };

  const transformed = ts.transform(sourceFile, [transformer]);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const output = printer.printFile(transformed.transformed[0]);
  transformed.dispose();
  return output;
}

async function ensureModuleSyntax(filePath, code) {
  if (/\bimport\b/.test(code) || /\bexport\b/.test(code)) {
    return code;
  }
  return `export {};\n${code}`;
}

for (const filePath of files) {
  const text = await fs.readFile(filePath, 'utf8');
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let output = transformSourceFile(source);
  output = await ensureModuleSyntax(filePath, output);
  await fs.writeFile(filePath, output, 'utf8');
}
