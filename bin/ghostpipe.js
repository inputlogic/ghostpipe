#!/usr/bin/env node
const crypto = require('crypto')
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
  .argument('[url]', 'Interface URL')
  .argument('[filePatterns...]', 'File patterns with permissions (e.g., "*.yml r")')
  .option('--verbose', 'Enable verbose logging')
  .option('--diff [branch]', 'Base branch for diff comparison')

program.action((url, filePatterns, options) => {
  VERBOSE = options.verbose
  connect(url, filePatterns, options)
})

const log = (...args) => VERBOSE && console.log(...args)
log.error = (...args) => VERBOSE && console.error(...args)
log.warn = (...args) => VERBOSE && console.warn(...args)

const WRITTEN_HASHES = new Map()

const connect = (url, filePatterns, {diff}) => {
  diff = diff === true ? 'main' : diff
  const options = {
    signalingServer: DEFAULT_SIGNALING_SERVER
  }
  if (url && (!filePatterns || !filePatterns.length)) {
    console.error('No interface specified. either provide URL and file patterns or create .ghostpipe.json')
    process.exit(1)
  }
  const config = url ? {interfaces: [{host: url, files: filePatterns, name: 'interface'}]} : readJson('.ghostpipe.json')
  const interfaces = config.interfaces.map(intf => {
    const pipe = crypto.randomBytes(16).toString('hex')
    const params = new URLSearchParams({
      pipe,
      signaling: options.signalingServer
    })
    const ydoc = new YDoc()
    const provider = new WebrtcProvider(pipe, ydoc, {signaling: [options.signalingServer], peerOpts: { wrtc }})
    const meta = ydoc.getMap('meta')
    meta.set('base-branch', diff)
    meta.set('head-branch', getHeadBranch())
    ydoc.getMap('files').observe((event, transaction) => {
      log(intf.name, 'transaction origin:', transaction.origin?.peerId || 'local')
      if (!transaction.origin?.peerId) return
      event.changes.keys.forEach((change, key) => {
        if (change.action === 'update' || change.action === 'add') {
          log(intf.name, 'ydoc event', change.action, key)
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
  console.log(' ')
  const allFilePatterns = interfaces.flatMap(intf => 
    intf.files.map(fileStr => fileString(fileStr).glob)
  )
  if (allFilePatterns.length === 0) {
    console.error('No file patterns configured in .ghostpipe.json')
    console.error('Please add file patterns to the "files" array in your interfaces')
    process.exit(1)
  }
  
  const chokidarPatterns = allFilePatterns.map(pattern => {
    if (pattern.includes('**')) {
      return pattern.replace('/**', '')
    }
    return pattern
  })
  
  const watcher = chokidar.watch(chokidarPatterns, {
    ignored: [/(^|[\/\\])\../, '!.ghostpipe.json'], // ignore dotfiles except for .ghostpipe.json
    persistent: true,
    ignoreInitial: false
  })
  
  watcher.on('error', error => {
    console.error('ERROR:', error.message)
    process.exit(1)
  })
  
  watcher.on('all', (event, path) => {
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
    intf.ydoc.transact(() => {
      intf.ydoc.getMap('files').set(path, content)
    })
    addDiffFile({intf, diff, file: path})
  })
}, 300)

const debouncedChange = debounceByKey((path, interfaces, diff) => {
  const fileContent = fs.readFileSync(path, 'utf8')
  const currentHash = hashContent(fileContent)
  
  interfaces.filter(intf => hasPermission('r', intf.files, path)).forEach(intf => {
    const content = intf.ydoc.getMap('files').get(path)
    const writtenHash = WRITTEN_HASHES.get(`${intf.ydoc.guid}-${path}`)
    if (writtenHash === currentHash) {
      WRITTEN_HASHES.delete(`${intf.ydoc.guid}-${path}`)
      return
    }
    if (content !== fileContent) {
      log('file change local', path)
      intf.ydoc.transact(() => {
        intf.ydoc.getMap('files').set(path, fileContent)
      })
    }
    addDiffFile({intf, diff, file: path})
  })
}, 300)

const debouncedWriteFile = debounceByKey((key, ydoc, intf, diff) => {
  if (!hasPermission('w', intf.files, key)) {
    log.warn('No permission to write file', key)
    return
  }
  const content = ydoc.getMap('files').get(key)
  const fileContent = fs.readFileSync(key, 'utf8')
  if (content === fileContent) return
  log(intf.name, 'file change remote', key)
  WRITTEN_HASHES.set(`${ydoc.guid}-${key}`, hashContent(content))
  fs.writeFileSync(key, content, 'utf8')
  addDiffFile({diff, intf, file: key})
}, 300)

const getHeadBranch = () => {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim()
  } catch (error) {
    log.error('Error getting branch:', error.message)
  }
}

const hashContent = (content) =>
  crypto.createHash('sha256').update(content).digest('hex')


program.parse()
