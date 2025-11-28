import type { Node } from 'jsonc-parser'
import type {
  InitializeParams,
  InitializeResult,
  InlayHint,
  Range,
} from 'vscode-languageserver/node'
import { parseTree } from 'jsonc-parser'
import { TextDocument } from 'vscode-languageserver-textdocument'
import {
  createConnection,
  DidChangeConfigurationNotification,
  InlayHintKind,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
} from 'vscode-languageserver/node'
import { catalogPrefix } from '../shared/constants'
import { WorkspaceManager } from './data'
import { getCatalogColor, getNodeRange, logger } from './utils'

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

  function getCatalogProperties(root: Node) {
    const items: { key: string, valueNode: Node, catalog: string }[] = []

    function traverse(node: Node) {
      if (node.type === 'property' && node.children && node.children.length === 2) {
        const keyNode = node.children[0]
        const valueNode = node.children[1]

        if (keyNode.type === 'string' && valueNode.type === 'string') {
          const value = valueNode.value
          if (typeof value === 'string' && value.startsWith(catalogPrefix)) {
            items.push({
              key: keyNode.value,
              valueNode,
              catalog: value.slice(catalogPrefix.length).trim() || 'default',
            })
          }
        }
      }

      if (node.children) {
        for (const child of node.children) {
          traverse(child)
        }
      }
    }

    traverse(root)
    return items
  }

  connection.languages.inlayHint.on(async params => {
    const doc = documents.get(params.textDocument.uri)
    if (!doc || !doc.uri.endsWith('package.json'))
      return null

    const root = parseTree(doc.getText())
    // logger.error(root)
    if (!root)
      return null

    const props = getCatalogProperties(root)
    const hints: (InlayHint & { extraData: { catalog: string, color: string | undefined } })[] = []

    for (const { key, valueNode, catalog } of props) {
      const result = await workspaceManager.resolveCatalog(doc.uri, key, catalog)
      if (result && result.version) {
        const range = getNodeRange(doc, valueNode)
        hints.push({
          position: range.end,
          label: result.version,
          kind: InlayHintKind.Type,
          // paddingLeft: true
          extraData: {
            catalog,
            color: getCatalogColor(catalog === 'default' ? 'default' : `${catalog}-${`lens`}`),
          },
        })
      }
    }
    return hints
  })

  connection.onHover(async params => {
    const doc = documents.get(params.textDocument.uri)
    if (!doc || !doc.uri.endsWith('package.json'))
      return null

    const root = parseTree(doc.getText())
    if (!root)
      return null

    const props = getCatalogProperties(root)

    for (const { key, valueNode, catalog } of props) {
      const range = getNodeRange(doc, valueNode)
      if (isPositionInRange(params.position, range)) {
        const result = await workspaceManager.resolveCatalog(doc.uri, key, catalog)
        logger.error(result)
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

    const root = parseTree(doc.getText())
    if (!root)
      return null

    const props = getCatalogProperties(root)

    for (const { key, valueNode, catalog } of props) {
      const range = getNodeRange(doc, valueNode)
      if (isPositionInRange(params.position, range)) {
        const result = await workspaceManager.resolveCatalog(doc.uri, key, catalog)
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
