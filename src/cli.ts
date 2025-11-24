#!/usr/bin/env node

import { version } from '../package.json'
import { createServer } from './server/server'

const args = process.argv

if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write(version)
  process.exit(0)
}

if (args.includes('rage')) {
  const environment = {
    Platform: process.platform,
    Arch: process.arch,
    NodeVersion: process.version,
    NodePath: process.execPath,
  }

  Object.entries(environment).forEach(([key, value]) => {
    process.stdout.write(`${key}: ${value}\n`)
  })

  process.exit(0)
}

createServer()
