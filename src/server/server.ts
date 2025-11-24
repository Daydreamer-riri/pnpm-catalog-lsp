import type { ParseResult } from '@babel/core'
import type { ObjectProperty, StringLiteral } from '@babel/types'
import type {
  InitializeParams,
  InitializeResult,
  InlayHint,
  Range,
} from 'vscode-languageserver/node'
import { parseSync, traverse } from '@babel/core'
// @ts-expect-error missing types
import preset from '@babel/preset-typescript'
import { TextDocument } from 'vscode-languageserver-textdocument'
import {
  createConnection,
  DidChangeConfigurationNotification,
  InlayHintKind,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
} from 'vscode-languageserver/node'
import { URI } from 'vscode-uri'
import { catalogPrefix } from '../shared/constants'
import { WorkspaceManager } from './data'
import { getNodeRange, logger } from './utils'

export function createServer() {
  const connection = createConnection(ProposedFeatures.all)
  const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument)
  const workspaceManager = new WorkspaceManager(documents, connection)

  let hasConfigurationCapability = false
  let hasWorkspaceFolderCapability = false

  connection.onInitialize((params: InitializeParams) => {
    const capabilities = params.capabilities

    hasConfigurationCapability = !!(
      capabilities.workspace && !!capabilities.workspace.configuration
    )
    hasWorkspaceFolderCapability = !!(
      capabilities.workspace && !!capabilities.workspace.workspaceFolders
    )

    const result: InitializeResult = {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        inlayHintProvider: true,
        hoverProvider: true,
        definitionProvider: true,
      },
    }
    if (hasWorkspaceFolderCapability) {
      result.capabilities.workspace = {
        workspaceFolders: {
          supported: true,
        },
      }
    }

    if (params.workspaceFolders) {
      workspaceManager.setWorkspaceFolders(params.workspaceFolders.map(f => f.uri))
    }

    return result
  })

  connection.onInitialized(() => {
    if (hasConfigurationCapability) {
      connection.client.register(DidChangeConfigurationNotification.type, undefined)
    }
    if (hasWorkspaceFolderCapability) {
      connection.workspace.onDidChangeWorkspaceFolders(_event => {
      // Handle workspace folder changes if needed
      })
    }
  })

  function parsePackageJson(text: string, uri: string) {
    const prefix = 'const x = '
    const offset = -prefix.length
    const combined = prefix + text

    try {
      const ast = parseSync(combined, {
        filename: URI.parse(uri).fsPath,
        presets: [preset],
        babelrc: false,
      })
      return { ast, offset }
    }
    catch {
      return null
    }
  }

  function getCatalogProperties(ast: ParseResult) {
    const items: { node: ObjectProperty, catalog: string }[] = []
    traverse(ast, {
      ObjectProperty(path) {
        const key = path.node.key
        const value = path.node.value

        if (key.type !== 'StringLiteral' || value.type !== 'StringLiteral') {
          return
        }

        if (!value.value.startsWith(catalogPrefix))
          return

        items.push({
          node: path.node,
          catalog: value.value.slice(catalogPrefix.length).trim() || 'default',
        })
      },
    })
    return items
  }

  connection.languages.inlayHint.on(async params => {
    const doc = documents.get(params.textDocument.uri)
    if (!doc || !doc.uri.endsWith('package.json'))
      return null

    const parsed = parsePackageJson(doc.getText(), doc.uri)
    if (!parsed || !parsed.ast)
      return null

    const props = getCatalogProperties(parsed.ast)
    logger.error('InlayHint request for:', doc.uri, props.length, props)
    const hints: InlayHint[] = []

    for (const { node, catalog } of props) {
      const result = await workspaceManager.resolveCatalog(doc.uri, (node.key as StringLiteral).value, catalog)
      if (result && result.version) {
        const range = getNodeRange(doc, node, parsed.offset)
        hints.push({
          position: range.end,
          label: result.version,
          kind: InlayHintKind.Type,
        // paddingLeft: true
        })
      }
    }
    return hints
  })

  connection.onHover(async params => {
    const doc = documents.get(params.textDocument.uri)
    if (!doc || !doc.uri.endsWith('package.json'))
      return null

    const parsed = parsePackageJson(doc.getText(), doc.uri)
    if (!parsed || !parsed.ast)
      return null

    const props = getCatalogProperties(parsed.ast)

    for (const { node, catalog } of props) {
      const range = getNodeRange(doc, node, parsed.offset)
      if (isPositionInRange(params.position, range)) {
        const result = await workspaceManager.resolveCatalog(doc.uri, (node.key as StringLiteral).value, catalog)
        if (result) {
          return {
            contents: {
              kind: 'markdown',
              value: `- ${result.manager} Catalog: \`${catalog}\`\n- Version: \`${result.version}\``,
            },
          }
        }
      }
    }
    return null
  })

  connection.onDefinition(async params => {
    const doc = documents.get(params.textDocument.uri)
    if (!doc || !doc.uri.endsWith('package.json'))
      return null

    const parsed = parsePackageJson(doc.getText(), doc.uri)
    if (!parsed || !parsed.ast)
      return null

    const props = getCatalogProperties(parsed.ast)

    for (const { node, catalog } of props) {
      const range = getNodeRange(doc, node, parsed.offset)
      if (isPositionInRange(params.position, range)) {
        const result = await workspaceManager.resolveCatalog(doc.uri, (node.key as StringLiteral).value, catalog)
        if (result && result.definition) {
          return result.definition
        }
      }
    }
    return null
  })

  function isPositionInRange(pos: any, range: Range) {
    if (pos.line < range.start.line || pos.line > range.end.line)
      return false
    if (pos.line === range.start.line && pos.character < range.start.character)
      return false
    if (pos.line === range.end.line && pos.character > range.end.character)
      return false
    return true
  }

  documents.listen(connection)
  connection.listen()

  connection.onShutdown(() => {
    workspaceManager.dispose()
  })

  return connection
}
