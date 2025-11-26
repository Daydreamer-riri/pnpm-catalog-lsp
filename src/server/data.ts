import type { ObjectMethod, ObjectProperty, SpreadElement } from '@babel/types'
import type { _Connection, Location, TextDocuments } from 'vscode-languageserver'
import type { AST } from 'yaml-eslint-parser'
import type { PackageManager } from '../shared/types'
import * as fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseSync, traverse } from '@babel/core'
// @ts-expect-error missing types
import preset from '@babel/preset-typescript'
import { findUp } from 'find-up'
import YAML from 'js-yaml'
import { Range } from 'vscode-languageserver'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { URI } from 'vscode-uri'
import { parseYAML } from 'yaml-eslint-parser'
import { BUN_LOCKS, WORKSPACE_FILES } from '../shared/constants'
import { logger } from './utils'

export interface WorkspaceData {
  catalog?: Record<string, string>
  catalogs?: Record<string, Record<string, string>>
}

export interface WorkspacePositionData {
  catalog: Record<string, [AST.Position, AST.Position]>
  catalogs: Record<string, Record<string, [AST.Position, AST.Position]>>
}

export interface JumpLocationParams {
  workspacePath: string
  versionPosition: AST.Position
}

export interface WorkspaceInfo {
  path: string
  manager: PackageManager
}

export class WorkspaceManager {
  private dataMap = new Map<string, WorkspaceData>()
  private findUpCache = new Map<string, WorkspaceInfo>()
  private positionDataMap = new Map<string, WorkspacePositionData>()
  private workspaceFolders: string[] = []

  constructor(private documents: TextDocuments<TextDocument>, private connection: _Connection) {
    this.documents = documents
    this.connection = connection
  }

  setWorkspaceFolders(folders: string[]) {
    this.workspaceFolders = folders
  }

  dispose() {
    this.dataMap.clear()
    this.findUpCache.clear()
    this.positionDataMap.clear()
  }

  public clearCache(uri: string) {
    this.dataMap.delete(uri)
    this.positionDataMap.delete(uri)
  }

  async resolveCatalog(docUri: string, name: string, catalog: string) {
    const docPath = URI.parse(docUri).fsPath
    const workspaceInfo = await this.findWorkspace(docPath)
    if (!workspaceInfo) {
      return null
    }

    const workspaceDoc = await this.getWorkspaceDocument(workspaceInfo.path)
    if (!workspaceDoc)
      return null

    const data = await this.readWorkspace(workspaceDoc, workspaceInfo.manager)

    const map = catalog === 'default'
      ? (data.catalog || data.catalogs?.default)
      : data.catalogs?.[catalog]

    if (!map)
      return null

    const positionData = this.readWorkspacePosition(workspaceDoc)
    if (!positionData)
      return null

    const positionMap = catalog === 'default'
      ? (positionData.catalog || positionData.catalogs?.default)
      : positionData.catalogs?.[catalog]

    const version = map[name]

    const versionRange = positionMap?.[name]
    let definition: Location | undefined
    if (versionRange) {
      definition = {
        uri: URI.file(workspaceInfo.path).toString(),
        range: Range.create(versionRange[0].line - 1, versionRange[0].column, versionRange[1].line - 1, versionRange[1].column),
      }
    }

    return { version, definition, manager: workspaceInfo.manager }
  }

  private async getWorkspaceDocument(path: string): Promise<TextDocument | null> {
    const uri = URI.file(path).toString()
    const doc = this.documents.get(uri)
    if (doc)
      return doc

    try {
      const content = await fs.readFile(path, 'utf-8')
      return TextDocument.create(uri, 'yaml', 1, content)
    }
    catch {
      logger.error(`Failed to read workspace file: ${path}`)
      return null
    }
  }

  private async findWorkspace(path: string): Promise<WorkspaceInfo | null> {
    if (this.findUpCache.has(path)) {
      return this.findUpCache.get(path)!
    }

    let stopAt: string | undefined

    if (this.workspaceFolders.length > 0) {
      // Find which workspace folder contains the current path
      for (const folder of this.workspaceFolders) {
        const folderPath = URI.parse(folder).fsPath
        if (path.startsWith(folderPath)) {
          stopAt = folderPath
          break
        }
      }
    }

    // check if is pnpm or yarn workspace
    const file = await findUp([WORKSPACE_FILES.yarn, WORKSPACE_FILES.pnpm], {
      type: 'file',
      cwd: path,
      stopAt,
    })
    logger.info(file)
    if (file) {
      const workspaceInfo: WorkspaceInfo = { path: file, manager: file.includes(WORKSPACE_FILES.yarn) ? 'yarn' : 'pnpm' }
      this.findUpCache.set(path, workspaceInfo)
      return workspaceInfo
    }

    // check if is bun workspace
    const bun = await findUp(BUN_LOCKS, {
      type: 'file',
      cwd: path,
      stopAt,
    })
    if (bun) {
      const filepath = join(dirname(bun), 'package.json')
      const workspaceInfo: WorkspaceInfo = { path: filepath, manager: 'bun' }
      this.findUpCache.set(path, workspaceInfo)
      return workspaceInfo
    }

    logger.error(`No workspace file (${WORKSPACE_FILES.yarn} or ${WORKSPACE_FILES.pnpm}) found in`, path)
    return null
  }

  private async readWorkspace(doc: TextDocument, manager: PackageManager): Promise<WorkspaceData> {
    if (this.dataMap.has(doc.uri)) {
      return this.dataMap.get(doc.uri)!
    }
    const data = await this.loadWorkspace(doc, manager)

    this.dataMap.set(doc.uri, data)

    const disposable = this.documents.onDidChangeContent(e => {
      if (e.document.uri === doc.uri) {
        this.dataMap.delete(doc.uri)
        this.positionDataMap.delete(doc.uri)
        setTimeout(() => {
          this.connection.languages.inlayHint.refresh()
        }, 300)
        disposable.dispose()
      }
    })

    return data
  }

  private async loadWorkspace(doc: TextDocument, manager: PackageManager): Promise<WorkspaceData> {
    if (manager === 'pnpm' || manager === 'yarn')
      return YAML.load(doc.getText()) as WorkspaceData
    if (manager === 'bun') {
      try {
        return JSON.parse(doc.getText()).workspaces || {} as WorkspaceData
      }
      catch {
        // Safe guard
      }
    }
    return {} as WorkspaceData
  }

  private readWorkspacePosition(doc: TextDocument) {
    if (this.positionDataMap.has(doc.uri)) {
      return this.positionDataMap.get(doc.uri)!
    }

    if (doc.uri.endsWith('.json'))
      return this.readJsonWorkspacePosition(doc)
    else
      return this.readYamlWorkspacePosition(doc)
  }

  private readYamlWorkspacePosition(doc: TextDocument) {
    const data: WorkspacePositionData = {
      catalog: {},
      catalogs: {},
    }

    const code = doc.getText()
    const lines = code.split('\n')
    const ast: AST.YAMLProgram = parseYAML(code)
    const astBody = ast.body[0].content as AST.YAMLMapping
    if (!astBody) {
      return data
    }

    const defaultCatalog = astBody.pairs.find(pair => pair.key?.type === 'YAMLScalar' && pair.key.value === 'catalog')
    const namedCatalog = astBody.pairs.find(pair => pair.key?.type === 'YAMLScalar' && pair.key.value === 'catalogs')

    function setActualPosition(data: Record<string, [AST.Position, AST.Position]>, pairs: AST.YAMLPair[]) {
      pairs.forEach(({ key, value }) => {
        if (key?.type === 'YAMLScalar' && value?.type === 'YAMLScalar') {
          const line = value.loc.start.line
          const lineText = lines[line - 1]
          const column = lineText.indexOf(value.value as unknown as string)
          const endLine = value.loc.end.line
          const endColumn = column + (value.value as unknown as string).length
          data[key.value as unknown as string] = [
            { line, column },
            { line: endLine, column: endColumn },
          ]
        }
      })
    }

    try {
      if (defaultCatalog?.value?.type === 'YAMLMapping') {
        setActualPosition(data.catalog, defaultCatalog.value.pairs)
      }

      if (namedCatalog?.value?.type === 'YAMLMapping') {
        namedCatalog.value.pairs.forEach(({ key, value }) => {
          if (key?.type === 'YAMLScalar' && value?.type === 'YAMLMapping') {
            const catalogName = key.value as unknown as string
            data.catalogs[catalogName] = {}
            setActualPosition(data.catalogs[catalogName], value.pairs)
          }
        })
      }
    }
    catch (err: any) {
      logger.error(`readYamlWorkspacePosition error ${err.message}`)
    }

    this.positionDataMap.set(doc.uri, data)

    return data
  }

  private readJsonWorkspacePosition(doc: TextDocument) {
    const data: WorkspacePositionData = {
      catalog: {},
      catalogs: {},
    }

    const code = doc.getText()
    const prefix = 'const x = '
    const offset = -prefix.length
    const combined = prefix + code

    try {
      const ast = parseSync(combined, {
        filename: URI.parse(doc.uri).fsPath,
        presets: [preset],
        babelrc: false,
      })
      if (!ast)
        return

      const setActualPosition = (properties: (ObjectMethod | ObjectProperty | SpreadElement)[], data: Record<string, [AST.Position, AST.Position]>, code: string) => {
        properties.forEach(prop => {
          if (prop.type === 'ObjectProperty' && prop.key.type === 'StringLiteral' && prop.value.type === 'StringLiteral') {
            const packageName = prop.key.value

            const startPos = prop.value.start ? prop.value.start + offset : undefined
            const endPos = prop.value.end ? prop.value.end + offset : undefined

            const beforeStart = code.substring(0, startPos)
            const beforeEnd = code.substring(0, endPos)

            const startLine = beforeStart.split('\n').length
            const startColumn = beforeStart.split('\n').pop()!.length
            const endLine = beforeEnd.split('\n').length
            const endColumn = beforeEnd.split('\n').pop()!.length

            data[packageName] = [
              { line: startLine, column: startColumn + 1 },
              { line: endLine, column: endColumn - 1 },
            ]
          }
        })
      }

      traverse(ast, {
        ObjectProperty(path) {
          const key = path.node.key
          const value = path.node.value

          if (key.type === 'StringLiteral' && key.value === 'workspaces') {
            if (value.type === 'ObjectExpression') {
              value.properties.forEach(prop => {
                if (prop.type === 'ObjectProperty' && prop.key.type === 'StringLiteral') {
                  if (prop.key.value === 'catalog' && prop.value.type === 'ObjectExpression') {
                    setActualPosition(prop.value.properties, data.catalog, code)
                  }
                  else if (prop.key.value === 'catalogs' && prop.value.type === 'ObjectExpression') {
                    prop.value.properties.forEach(catalogProp => {
                      if (catalogProp.type === 'ObjectProperty' && catalogProp.key.type === 'StringLiteral' && catalogProp.value.type === 'ObjectExpression') {
                        const catalogName = catalogProp.key.value
                        data.catalogs[catalogName] = {}
                        setActualPosition(catalogProp.value.properties, data.catalogs[catalogName], code)
                      }
                    })
                  }
                }
              })
            }
          }
        },
      })
    }
    catch (err: any) {
      logger.error(`readJsonWorkspacePosition error ${err.message}`)
    }

    this.positionDataMap.set(doc.uri, data)

    return data
  }
}
