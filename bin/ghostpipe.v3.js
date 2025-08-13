#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync } = require('child_process')
const { Doc: YDoc } = require('yjs')
const { WebrtcProvider } = require('y-webrtc')
const wrtc = require('@roamhq/wrtc')

// Constants
const DEFAULT_HOST = 'https://ghostpipe.dev'
const DEFAULT_SIGNALING = 'wss://signaling.ghostpipe.dev'
const IGNORED_PATHS = ['.', 'node_modules', 'dist', 'build', '.git']
const HELP = `ghostpipe - CLI tool
Usage:
  ghostpipe [options] [command]
  ghostpipe diff [base] [head]

Commands:
  diff           Compare files between git branches
                 Examples:
                   ghostpipe diff              # current vs main
                   ghostpipe diff develop      # current vs develop
                   ghostpipe diff main feature # main vs feature

Options:
  --help         Show help
  --host         Specify host URL
  --version      Show version
  --verbose      Enable verbose logging

Configuration:
  Create .ghostpipe.json in your project or ~/.config/
  to configure multiple hosts with file restrictions`

let VERBOSE = false
const log = (...args) => VERBOSE && console.log(...args)

// Config & Args
const loadConfig = () => [
  path.join(process.cwd(), '.ghostpipe.json'),
  path.join(os.homedir(), '.config', 'ghostpipe.json')
].reduce((config, p) => {
  if (config) return config
  try {
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null
  } catch (e) {
    console.error(`Error loading ${p}:`, e.message)
    return null
  }
}, null) || {}

const parseArgs = args => args.reduce((parsed, arg, i) => {
  if (arg === '--help' || arg === '-h') return { ...parsed, showHelp: true }
  if (arg === '--version' || arg === '-v') return { ...parsed, showVersion: true }
  if (arg === '--verbose') return { ...parsed, verbose: true }
  if (arg === '--host' && args[i + 1]) return { ...parsed, host: args[i + 1] }
  if (!arg.startsWith('-') && !parsed.command) return { ...parsed, command: arg }
  return parsed
}, { command: null, showHelp: false, showVersion: false, verbose: false, host: null })

// File Operations
const getAllFiles = (dirPath, basePath = '', fileList = [], allowedFiles = null) => {
  return fs.readdirSync(dirPath).reduce((acc, file) => {
    if (IGNORED_PATHS.some(ignored => file.startsWith(ignored))) return acc
    
    const filePath = path.join(dirPath, file)
    const relativePath = path.join(basePath, file)
    const stat = fs.statSync(filePath)
    
    if (stat.isDirectory()) {
      return getAllFiles(filePath, relativePath, acc, allowedFiles)
    }
    
    if (stat.isFile() && (!allowedFiles || allowedFiles.includes(relativePath))) {
      try {
        acc.push({ path: relativePath, content: fs.readFileSync(filePath, 'utf8') })
      } catch {
        log(`Skipping binary: ${relativePath}`)
      }
    }
    
    return acc
  }, fileList)
}

const createFileWatcher = (relativePath, onChange, watchedFiles, watchTimeout) => {
  if (watchedFiles.has(relativePath)) return
  
  try {
    watchedFiles.set(relativePath, fs.watch(path.join(process.cwd(), relativePath), eventType => {
      clearTimeout(watchTimeout.get(relativePath))
      watchTimeout.set(relativePath, setTimeout(() => {
        onChange(relativePath, path.join(process.cwd(), relativePath), eventType)
        watchTimeout.delete(relativePath)
      }, 100))
    }))
  } catch (err) {
    console.error(`Error watching ${relativePath}:`, err.message)
  }
}

// WebRTC & URL Generation
const createProvider = (pipeId, signalingServer) => {
  const ydoc = new YDoc()
  return { 
    ydoc, 
    provider: new WebrtcProvider(pipeId, ydoc, {
      signaling: [signalingServer],
      peerOpts: { wrtc }
    })
  }
}

const generateUrl = (host, pipeId, signalingServer, mode = 'gui') => 
  `${host.startsWith('http') ? '' : 'http://'}${host}/${mode}?pipe=${pipeId}&signaling=${encodeURIComponent(signalingServer)}`

// Main Session
const createSession = (hostConfig, signalingServer) => {
  const isSimpleHost = typeof hostConfig === 'string'
  const host = isSimpleHost ? hostConfig : hostConfig.host
  const name = isSimpleHost ? 'Default' : hostConfig.name
  const allowedFiles = isSimpleHost ? null : hostConfig.files
  
  const pipeId = `ghostpipe-${Math.random().toString(36).substring(7)}`
  const { ydoc, provider } = createProvider(pipeId, signalingServer)
  
  log(`\nPipe created for ${name}: ${pipeId}`)
  console.log(`${name}: ${generateUrl(host, pipeId, signalingServer)}`)
  
  const files = ydoc.getMap('files')
  const metadata = ydoc.getMap('metadata')
  
  metadata.set('created', new Date().toISOString())
  metadata.set('cwd', process.cwd())
  
  // Load initial files
  const allFiles = getAllFiles(process.cwd(), '', [], allowedFiles)
  log(`Loading ${allFiles.length} files...`)
  allFiles.forEach(file => files.set(file.path, file.content))
  
  let updatingFromGUI = false
  const watchedFiles = new Map()
  const watchTimeout = new Map()
  
  // Sync GUI → FS
  files.observe(event => {
    updatingFromGUI = true
    event.changes.keys.forEach((change, key) => {
      if (allowedFiles && !allowedFiles.includes(key)) return
      
      const filePath = path.join(process.cwd(), key)
      
      if (change.action === 'update' || change.action === 'add') {
        try {
          fs.mkdirSync(path.dirname(filePath), { recursive: true })
          fs.writeFileSync(filePath, files.get(key), 'utf8')
          log(`[${name}] Updated: ${key}`)
        } catch (err) {
          console.error(`Error writing ${key}:`, err.message)
        }
      } else if (change.action === 'delete') {
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath)
            log(`[${name}] Deleted: ${key}`)
          }
        } catch (err) {
          console.error(`Error deleting ${key}:`, err.message)
        }
      }
    })
    updatingFromGUI = false
  })
  
  // Handle FS → GUI
  const handleFileChange = (relativePath, fullPath) => {
    if (updatingFromGUI) return
    
    try {
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf8')
        if (content !== files.get(relativePath)) {
          files.set(relativePath, content)
          log(`[${name}] Local change: ${relativePath}`)
        }
      } else if (files.has(relativePath)) {
        files.delete(relativePath)
        log(`[${name}] Local delete: ${relativePath}`)
        watchedFiles.get(relativePath)?.close()
        watchedFiles.delete(relativePath)
      }
    } catch (err) {
      log(`Error handling change for ${relativePath}:`, err.message)
    }
  }
  
  // Watch files
  allFiles.forEach(file => createFileWatcher(file.path, handleFileChange, watchedFiles, watchTimeout))
  
  // Watch directory
  const dirWatcher = fs.watch(process.cwd(), { recursive: true }, (eventType, filename) => {
    if (!filename || updatingFromGUI) return
    if (IGNORED_PATHS.some(ignored => filename.includes(ignored))) return
    if (allowedFiles && !allowedFiles.includes(filename)) return
    
    clearTimeout(watchTimeout.get(filename))
    watchTimeout.set(filename, setTimeout(() => {
      handleFileChange(filename, path.join(process.cwd(), filename))
      createFileWatcher(filename, handleFileChange, watchedFiles, watchTimeout)
      watchTimeout.delete(filename)
    }, 100))
  })
  
  return () => {
    provider.destroy()
    watchedFiles.forEach(watcher => watcher.close())
    dirWatcher.close()
  }
}

// Diff Session
const createDiffSession = (hostConfig, baseBranch, headBranch, signalingServer) => {
  const { name = 'Default', host, files: allowedFiles = null } = hostConfig
  const pipeId = `ghostpipe-diff-${Math.random().toString(36).substring(7)}`
  const { ydoc, provider } = createProvider(pipeId, signalingServer)
  
  log(`\nDiff pipe created for ${name}: ${pipeId}`)
  
  const baseFiles = ydoc.getMap('base-files')
  const headFiles = ydoc.getMap('head-files')
  const metadata = ydoc.getMap('metadata')
  
  // Check if head is current working branch
  const isWorkingDirectory = (() => {
    try {
      return execSync('git branch --show-current').toString().trim() === headBranch
    } catch {
      return false
    }
  })()
  
  metadata.set('mode', 'diff')
  metadata.set('baseBranch', baseBranch)
  metadata.set('headBranch', headBranch)
  metadata.set('created', new Date().toISOString())
  metadata.set('includesWorkingDirectory', isWorkingDirectory)
  
  try {
    // Get changed files
    const changedFilesOutput = isWorkingDirectory
      ? Array.from(new Set([
          ...execSync(`git diff --name-only ${baseBranch}...${headBranch}`).toString().trim().split('\n').filter(Boolean),
          ...execSync(`git diff --name-only ${baseBranch}`).toString().trim().split('\n').filter(Boolean)
        ])).join('\n')
      : execSync(`git diff --name-only ${baseBranch}...${headBranch}`).toString().trim()
    
    if (!changedFilesOutput) {
      console.log(`[${name}] No files changed between branches`)
      metadata.set('changedFiles', [])
      return () => provider.destroy()
    }
    
    const changedFiles = changedFilesOutput.split('\n')
      .filter(file => !allowedFiles || allowedFiles.includes(file))
    
    metadata.set('changedFiles', changedFiles)
    log(`[${name}] Loading ${changedFiles.length} changed files...`)
    
    // Load files from both branches
    changedFiles.forEach(file => {
      // Base branch
      try {
        baseFiles.set(file, execSync(`git show ${baseBranch}:${file} 2>/dev/null`, {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore']
        }))
      } catch {
        baseFiles.set(file, '') // New file
      }
      
      // Head branch
      if (isWorkingDirectory) {
        try {
          const filePath = path.join(process.cwd(), file)
          headFiles.set(file, fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '')
        } catch {
          headFiles.set(file, '')
        }
      } else {
        try {
          headFiles.set(file, execSync(`git show ${headBranch}:${file} 2>/dev/null`, {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore']
          }))
        } catch {
          headFiles.set(file, '') // Deleted file
        }
      }
    })
  } catch (error) {
    console.error('Error getting diff:', error.message)
    provider.destroy()
    process.exit(1)
  }
  
  console.log(`${name}: ${generateUrl(host, pipeId, signalingServer, 'diff')}`)
  log(`  Comparing: ${baseBranch} ↔ ${headBranch}${isWorkingDirectory ? ' (with working changes)' : ''}`)
  
  const watchedFiles = new Map()
  const watchTimeout = new Map()
  
  // Watch working directory changes if applicable
  if (isWorkingDirectory) {
    (metadata.get('changedFiles') || [])
      .filter(relativePath => fs.existsSync(path.join(process.cwd(), relativePath)))
      .forEach(relativePath => {
        createFileWatcher(relativePath, (relPath, fullPath) => {
          try {
            if (fs.existsSync(fullPath)) {
              const content = fs.readFileSync(fullPath, 'utf8')
              if (content !== headFiles.get(relPath)) {
                ydoc.transact(() => headFiles.set(relPath, content))
                log(`[${name}] Updated in diff: ${relPath}`)
              }
            }
          } catch (err) {
            console.error(`[${name}] Error reading ${relPath}:`, err.message)
          }
        }, watchedFiles, watchTimeout)
      })
  }
  
  return () => {
    provider.destroy()
    watchedFiles.forEach(watcher => watcher.close())
  }
}

// Git Utilities
const gitUtils = {
  verifyRepo: () => {
    try {
      execSync('git rev-parse --git-dir', { stdio: 'ignore' })
      return true
    } catch {
      console.error('Error: Not in a git repository')
      process.exit(1)
    }
  },
  
  getCurrentBranch: () => {
    try {
      const branch = execSync('git branch --show-current').toString().trim()
      if (!branch) throw new Error('Detached HEAD state')
      return branch
    } catch (error) {
      console.error('Error getting current branch:', error.message)
      process.exit(1)
    }
  },
  
  getDefaultBranch: () => ['main', 'master'].reduce((found, branch) => {
    if (found) return found
    try {
      execSync(`git show-ref --verify refs/heads/${branch}`, { stdio: 'ignore' })
      return branch
    } catch {
      return null
    }
  }, null) || (() => {
    console.error('Error: No main or master branch found')
    process.exit(1)
  })(),
  
  verifyBranch: branch => {
    try {
      execSync(`git show-ref --verify refs/heads/${branch}`, { stdio: 'ignore' })
    } catch {
      console.error(`Error: Branch '${branch}' does not exist`)
      process.exit(1)
    }
  }
}

// Command Handlers
const handleDiff = (config, signalingServer, diffArgs) => {
  gitUtils.verifyRepo()
  
  const currentBranch = gitUtils.getCurrentBranch()
  const defaultBranch = gitUtils.getDefaultBranch()
  const [baseBranch = defaultBranch, headBranch = currentBranch] = diffArgs
  
  if (diffArgs.length > 2) {
    console.error('Error: Too many arguments for diff command')
    process.exit(1)
  }
  
  gitUtils.verifyBranch(baseBranch)
  gitUtils.verifyBranch(headBranch)
  
  if (!config.hosts?.length) {
    console.error('Error: No hosts configured. Please create a .ghostpipe.json config file.')
    process.exit(1)
  }
  
  console.log(`\nComparing: ${baseBranch} ↔ ${headBranch}${currentBranch === headBranch ? ' (with working changes)' : ''}`)
  
  return config.hosts.map(host => createDiffSession(host, baseBranch, headBranch, signalingServer))
}

const handleFileSharing = (config, signalingServer, parsed) => {
  return config.hosts?.length
    ? (() => {
        log(`Starting with ${config.hosts.length} host(s)...`)
        return config.hosts.map(host => createSession(host, signalingServer))
      })()
    : (() => {
        log('Starting in single host mode...')
        return [createSession(parsed.host || config.host || DEFAULT_HOST, signalingServer)]
      })()
}

const setupShutdownHandler = cleanups => {
  process.on('SIGINT', () => {
    console.log('\nShutting down...')
    cleanups.forEach(cleanup => cleanup())
    process.exit(0)
  })
}

// Main
const main = () => {
  const parsed = parseArgs(process.argv.slice(2))
  VERBOSE = parsed.verbose
  
  if (parsed.showHelp) return console.log(HELP)
  if (parsed.showVersion) return console.log(`ghostpipe v${require('../package.json').version}`)
  
  const config = loadConfig()
  const signalingServer = config.signalingServer || DEFAULT_SIGNALING
  
  // Handle commands
  if (parsed.command === 'diff') {
    const diffArgs = process.argv.slice(2)
      .slice(process.argv.slice(2).indexOf('diff') + 1)
      .filter(arg => !arg.startsWith('--'))
    
    const cleanups = handleDiff(config, signalingServer, diffArgs)
    console.log('\nDiff pipes running. Press Ctrl+C to stop.')
    setupShutdownHandler(cleanups)
    return
  }
  
  if (parsed.command) {
    console.log(`Unknown command: ${parsed.command}\nRun "ghostpipe --help" for usage`)
    process.exit(1)
  }
  
  // Normal file sharing mode
  const cleanups = handleFileSharing(config, signalingServer, parsed)
  console.log('\nPipes running. Press Ctrl+C to stop.')
  setupShutdownHandler(cleanups)
}

main()
