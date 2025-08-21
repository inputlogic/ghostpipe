#!/usr/bin/env node
const crypto = require('crypto');
const { Command } = require('commander')
const { Doc: YDoc } = require('yjs')
const { WebrtcProvider } = require('y-webrtc')
const { minimatch } = require('minimatch')
const wrtc = require('@roamhq/wrtc')
const fs = require('fs')
const chokidar = require('chokidar')
const { execSync } = require('child_process')

const program = new Command()
const DEFAULT_SIGNALING_SERVER = 'wss://signaling.ghostpipe.dev'
let VERBOSE = false

program
  .name('ghostpipe')
  .description('Interfaces for your codebase')
  .version(require('../package.json').version)
  .option('--verbose', 'Enable verbose logging')
  .option('--diff [branch]', 'Base branch for diff comparison')

program.action((options) => {
  VERBOSE = options.verbose
  connect(options)
})

const log = (...args) => VERBOSE && console.log(...args)
log.error = (...args) => VERBOSE && console.error(...args)

const WRITES = {}

const connect = ({diff}) => {
  diff = diff === true ? 'main' : diff
  const options = {
    signalingServer: DEFAULT_SIGNALING_SERVER
  }
  const config = readJson('.ghostpipe.json')
  const interfaces = config.interfaces.map(intf => {
    const pipe = crypto.randomBytes(16).toString('hex')
    const params = new URLSearchParams({
      pipe,
      signaling: options.signalingServer
    })
    const ydoc = new YDoc()
    const provider = new WebrtcProvider(pipe, ydoc, {signaling: [options.signalingServer], peerOpts: { wrtc }})
    ydoc.getMap('files').observe(event => {
      event.changes.keys.forEach((change, key) => {
        if (change.action === 'update' || change.action === 'add') {
          debouncedWriteFile(key, ydoc, intf, diff)
        } else if (change.action === 'delete') {
          log('TODO: handle delete file')
        }
      })
    })
    console.log(`${intf.name}: ${intf.host}?${params.toString()}`)
    return {
      ...intf,
      ydoc,
      provider
    }
  })
  const allFilePatterns = interfaces.flatMap(intf => 
    intf.files.map(fileStr => fileString(fileStr).glob)
  )
  chokidar.watch(allFilePatterns).on('all', (event, path) => {
    if (event === 'add') {
      debouncedAdd(path, interfaces, diff)
    }
    if (event === 'change') {
      debouncedChange(path, interfaces, diff)
    }
  })
}

const addDiffFile = ({intf, diff, file}) => {
  if (!diff) return
  try {
    const content = execSync(`git show ${diff}:${file}`, { 
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    })
    intf.ydoc.getMap('base-files').set(file, content)
    log(`Loaded diff file for ${intf.name}: ${file}`)
  } catch (error) {
    log.error(`File not in ${diff} branch: ${file}`)
  }
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    console.error(error)
    return null
  }
}

const hasPermission = (permission, patterns, file) =>
  patterns.some(pattern => {
    const {glob, permissions} = fileString(pattern)
    return permissions.includes(permission) && minimatch(file, glob)
  })

const fileString = (string) => {
  const [glob, map, permissions] = string.split(' ')
  return {glob, map: permissions ? map : null, permissions: permissions || map}
}

const debounceByKey = (func, delay) => {
  const timers = new Map()
  return (...args) => {
    const key = args[0]
    clearTimeout(timers.get(key))
    timers.set(key, setTimeout(() => {
      timers.delete(key)
      func.apply(this, args)
    }, delay))
  }
}

const debouncedAdd = debounceByKey((path, interfaces, diff) => {
  const content = fs.readFileSync(path, 'utf8')
  interfaces.filter(intf => hasPermission('r', intf.files, path)).forEach(intf => {
    log('file add', path)
    intf.ydoc.getMap('files').set(path, content)
    addDiffFile({intf, diff, file: path})
  })
}, 200)

const debouncedChange = debounceByKey((path, interfaces, diff) => {
  const fileContent = fs.readFileSync(path, 'utf8')
  interfaces.filter(intf => hasPermission('r', intf.files, path)).forEach(intf => {
    const content = intf.ydoc.getMap('files').get(path)
    if (WRITES[`${intf.ydoc.guid}-${path}`]) {
      delete WRITES[`${intf.ydoc.guid}-${path}`]
      return
    }
    if (content !== fileContent) {
      log('file change local', path)
      intf.ydoc.getMap('files').set(path, fileContent)
    }
    addDiffFile({intf, diff, file: path})
  })
}, 300)

const debouncedWriteFile = debounceByKey((key, ydoc, intf, diff) => {
  if (!hasPermission('w', intf.files, key)) return
  const content = ydoc.getMap('files').get(key)
  const fileContent = fs.readFileSync(key, 'utf8')
  if (content === fileContent) return
  log(intf.name, 'file change remote', key)
  WRITES[`${ydoc.guid}-${key}`] = true
  fs.writeFileSync(key, content, 'utf8')
  addDiffFile({diff, intf, file: key})
}, 300)

program.parse()

