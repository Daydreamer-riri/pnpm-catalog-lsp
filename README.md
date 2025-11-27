<p align="center">
<img src="https://github.com/antfu/vscode-pnpm-catalog-lens/blob/main/res/icon.png?raw=true" height="150">
</p>

<h1 align="center">Catalog Lens LSP</h1>

<p align="center">
Show versions inline and go-to-definition for <a href="https://pnpm.io/catalogs" target="_blank">pnpm</a> · <a href="https://yarnpkg.com/features/catalogs" target="_blank">yarn</a> · <a href="https://bun.sh/docs/install/catalogs" target="_blank">bun</a> <code>catalog:</code> fields.<br>
</p>

<p align="center">
<a href="https://www.npmjs.com/package/pnpm-catalog-lsp"><img src="https://img.shields.io/npm/v/pnpm-catalog-lsp?color=729B1B&label=" alt="NPM version"></a>
<a href="https://github.com/Daydreamer-riri/pnpm-catalog-lsp/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License"></a>
</p>

## Features

This Language Server Protocol (LSP) implementation provides enhanced support for `catalog:` protocol in `package.json` files.

- **Inlay Hints**: Displays the actual version of the dependency next to the `catalog:` declaration.
- **Hover Documentation**: Shows detailed information about the catalog source and resolved version.
- **Go to Definition**: Jump directly to the catalog definition in your workspace configuration file (`pnpm-workspace.yaml` or `package.json`).

### Extended Capabilities

The server extends the standard LSP `InlayHint` with an `extraData` property containing:

- `catalog`: The name of the catalog source.
- `color`: A consistent color hash for the catalog, useful for client-side highlighting.

## Supported Package Managers

- **pnpm**
- **Yarn**
- **Bun**

## Installation

```bash
npm install -g pnpm-catalog-lsp
# or
pnpm add -g pnpm-catalog-lsp
```

## Usage

### Neovim

Use [catalog-lens.nvim](https://github.com/Daydreamer-riri/catalog-lens.nvim) for easy integration. It also provides additional highlighting capabilities.

If you prefer manual configuration using `vim.lsp`:

```lua
vim.lsp.config["catalog_ls"] = {
  cmd = { 'pnpm-catalog-lsp', '--stdio' },
  filetypes = { "json", "yaml" },
  root_markers = { { "pnpm-workspace.yaml" }, ".git" },
  handlers = {
    -- You can customize hint rendering if needed
  },
}

vim.lsp.enable("catalog_ls")
```

### VS Code

This is a raw LSP server. To use it in VS Code, you would typically need a client extension. If you are looking for the VS Code extension, check out [vscode-pnpm-catalog-lens](https://github.com/antfu/vscode-pnpm-catalog-lens).

## Development

1. Clone the repository
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Build the project:
   ```bash
   pnpm build
   ```

## Credits

Inspired by [pnpm catalog lens for VS Code](https://github.com/antfu/vscode-pnpm-catalog-lens).

## License

[MIT](./LICENSE) License © 2023 [Riri](https://github.com/Daydreamer-riri)
