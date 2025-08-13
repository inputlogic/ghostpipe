#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync } = require('child_process')
const { Doc: YDoc } = require('yjs')
const { WebrtcProvider } = require('y-webrtc')
const wrtc = require('@roamhq/wrtc')

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

// Configuration loading with cascading priority
const loadConfig = () => {
  const paths = [
    path.join(process.cwd(), '.ghostpipe.json'),
    path.join(os.homedir(), '.config', 'ghostpipe.json')
  ]
  
  for (const configPath of paths) {
    try {
      if (fs.existsSync(configPath)) {
        return JSON.parse(fs.readFileSync(configPath, 'utf8'))
      }
    } catch (error) {
      console.error(`Error loading ${configPath}:`, error.message)
    }
  }
  return {}
}

// Recursively get all files in directory with filtering
const getAllFiles = (dirPath, basePath = '', fileList = [], allowedFiles = null) => {
  const files = fs.readdirSync(dirPath)
  
  files.forEach(file => {
    if (IGNORED_PATHS.some(ignored => file.startsWith(ignored))) return
    
    const filePath = path.join(dirPath, file)
    const relativePath = path.join(basePath, file)
    const stat = fs.statSync(filePath)
    
    if (stat.isDirectory()) {
      getAllFiles(filePath, relativePath, fileList, allowedFiles)
    } else if (stat.isFile()) {
      if (allowedFiles && !allowedFiles.includes(relativePath)) return
      
      try {
        fileList.push({ path: relativePath, content: fs.readFileSync(filePath, 'utf8') })
      } catch {
        if (VERBOSE) console.warn(`Skipping binary file: ${relativePath}`)
      }
    }
  })
  
  return fileList
}

// Simple argument parser
const parseArgs = (args) => {
  const parsed = { command: null, showHelp: false, showVersion: false, verbose: false, host: null }
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    
    if (arg === '--help' || arg === '-h') parsed.showHelp = true
    else if (arg === '--version' || arg === '-v') parsed.showVersion = true
    else if (arg === '--verbose') parsed.verbose = true
    else if (arg === '--host' && args[i + 1]) { parsed.host = args[++i] }
    else if (!arg.startsWith('-')) parsed.command = arg
  }
  
  return parsed
}

// Create file system watcher with debouncing
const createFileWatcher = (relativePath, onChange, watchedFiles, watchTimeout) => {
  const fullPath = path.join(process.cwd(), relativePath)
  if (watchedFiles.has(relativePath)) return
  
  try {
    const watcher = fs.watch(fullPath, eventType => {
      clearTimeout(watchTimeout.get(relativePath))
      watchTimeout.set(relativePath, setTimeout(() => {
        onChange(relativePath, fullPath, eventType)
        watchTimeout.delete(relativePath)
      }, 100))
    })
    watchedFiles.set(relativePath, watcher)
  } catch (err) {
    console.error(`Error watching ${relativePath}:`, err.message)
  }
}

// Create WebRTC provider with Y.js document
const createProvider = (pipeId, signalingServer) => {
  const ydoc = new YDoc()
  const provider = new WebrtcProvider(pipeId, ydoc, {
    signaling: [signalingServer],
    peerOpts: { wrtc }
  })
  return { ydoc, provider }
}

// Generate connection URL
const generateUrl = (host, pipeId, signalingServer, mode = 'gui') => {
  const encodedSignaling = encodeURIComponent(signalingServer)
  const protocol = host.startsWith('http') ? '' : 'http://'
  return `${protocol}${host}/${mode}?pipe=${pipeId}&signaling=${encodedSignaling}`
}

// Main session creator for file sharing
const createSession = (hostConfig, signalingServer) => {
  const isSimpleHost = typeof hostConfig === 'string'
  const host = isSimpleHost ? hostConfig : hostConfig.host
  const name = isSimpleHost ? 'Default' : hostConfig.name
  const allowedFiles = isSimpleHost ? null : hostConfig.files
  
  const pipeId = `ghostpipe-${Math.random().toString(36).substring(7)}`
  const { ydoc, provider } = createProvider(pipeId, signalingServer)
  
  if (VERBOSE) console.log(`\nPipe created for ${name}: ${pipeId}`)
  console.log(`${name}: ${generateUrl(host, pipeId, signalingServer)}`)
  
  const files = ydoc.getMap('files')
  const metadata = ydoc.getMap('metadata')
  
  metadata.set('created', new Date().toISOString())
  metadata.set('cwd', process.cwd())
  
  // Load initial files
  const allFiles = getAllFiles(process.cwd(), '', [], allowedFiles)
  if (VERBOSE) console.log(`Loading ${allFiles.length} files...`)
  allFiles.forEach(file => files.set(file.path, file.content))
  
  let updatingFromGUI = false
  const watchedFiles = new Map()
  const watchTimeout = new Map()
  
  // Sync GUI changes to filesystem
  files.observe(event => {
    updatingFromGUI = true
    event.changes.keys.forEach((change, key) => {
      if (allowedFiles && !allowedFiles.includes(key)) return
      
      const filePath = path.join(process.cwd(), key)
      
      if (change.action === 'update' || change.action === 'add') {
        try {
          fs.mkdirSync(path.dirname(filePath), { recursive: true })
          fs.writeFileSync(filePath, files.get(key), 'utf8')
          if (VERBOSE) console.log(`[${name}] Updated: ${key}`)
        } catch (err) {
          console.error(`Error writing ${key}:`, err.message)
        }
      } else if (change.action === 'delete') {
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath)
            if (VERBOSE) console.log(`[${name}] Deleted: ${key}`)
          }
        } catch (err) {
          console.error(`Error deleting ${key}:`, err.message)
        }
      }
    })
    updatingFromGUI = false
  })
  
  // Watch local file changes
  const handleFileChange = (relativePath, fullPath, eventType) => {
    if (updatingFromGUI) return
    
    try {
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf8')
        if (content !== files.get(relativePath)) {
          files.set(relativePath, content)
          if (VERBOSE) console.log(`[${name}] Local change: ${relativePath}`)
        }
      } else if (files.has(relativePath)) {
        files.delete(relativePath)
        if (VERBOSE) console.log(`[${name}] Local delete: ${relativePath}`)
        watchedFiles.get(relativePath)?.close()
        watchedFiles.delete(relativePath)
      }
    } catch (err) {
      if (VERBOSE) console.error(`Error handling change for ${relativePath}:`, err.message)
    }
  }
  
  // Watch all initial files
  allFiles.forEach(file => 
    createFileWatcher(file.path, handleFileChange, watchedFiles, watchTimeout)
  )
  
  // Watch directory for new files
  const dirWatcher = fs.watch(process.cwd(), { recursive: true }, (eventType, filename) => {
    if (!filename || updatingFromGUI) return
    if (IGNORED_PATHS.some(ignored => filename.includes(ignored))) return
    if (allowedFiles && !allowedFiles.includes(filename)) return
    
    clearTimeout(watchTimeout.get(filename))
    watchTimeout.set(filename, setTimeout(() => {
      handleFileChange(filename, path.join(process.cwd(), filename), eventType)
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

// Diff session creator for branch comparison
const createDiffSession = (hostConfig, baseBranch, headBranch, signalingServer) => {
  const { name = 'Default', host, files: allowedFiles = null } = hostConfig
  const pipeId = `ghostpipe-diff-${Math.random().toString(36).substring(7)}`
  const { ydoc, provider } = createProvider(pipeId, signalingServer)
  
  if (VERBOSE) console.log(`\nDiff pipe created for ${name}: ${pipeId}`)
  
  const baseFiles = ydoc.getMap('base-files')
  const headFiles = ydoc.getMap('head-files')
  const metadata = ydoc.getMap('metadata')
  
  // Check if head is current working branch
  let isWorkingDirectory = false
  try {
    const currentBranch = execSync('git branch --show-current').toString().trim()
    isWorkingDirectory = (headBranch === currentBranch)
  } catch {}
  
  metadata.set('mode', 'diff')
  metadata.set('baseBranch', baseBranch)
  metadata.set('headBranch', headBranch)
  metadata.set('created', new Date().toISOString())
  metadata.set('includesWorkingDirectory', isWorkingDirectory)
  
  try {
    // Get changed files
    let changedFilesOutput
    if (isWorkingDirectory) {
      const committed = execSync(`git diff --name-only ${baseBranch}...${headBranch}`).toString().trim()
      const working = execSync(`git diff --name-only ${baseBranch}`).toString().trim()
      const allChanges = new Set([
        ...(committed ? committed.split('\n') : []),
        ...(working ? working.split('\n') : [])
      ])
      changedFilesOutput = Array.from(allChanges).join('\n')
    } else {
      changedFilesOutput = execSync(`git diff --name-only ${baseBranch}...${headBranch}`).toString().trim()
    }
    
    if (!changedFilesOutput) {
      console.log(`[${name}] No files changed between branches`)
      metadata.set('changedFiles', [])
      return () => provider.destroy()
    }
    
    let changedFiles = changedFilesOutput.split('\n')
    if (allowedFiles) {
      changedFiles = changedFiles.filter(file => allowedFiles.includes(file))
    }
    
    metadata.set('changedFiles', changedFiles)
    if (VERBOSE) console.log(`[${name}] Loading ${changedFiles.length} changed files...`)
    
    // Load files from both branches
    changedFiles.forEach(file => {
      // Base branch content
      try {
        const content = execSync(`git show ${baseBranch}:${file} 2>/dev/null`, {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore']
        })
        baseFiles.set(file, content)
      } catch {
        baseFiles.set(file, '') // New file
      }
      
      // Head branch content
      if (isWorkingDirectory) {
        const filePath = path.join(process.cwd(), file)
        try {
          headFiles.set(file, fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '')
        } catch {
          headFiles.set(file, '')
        }
      } else {
        try {
          const content = execSync(`git show ${headBranch}:${file} 2>/dev/null`, {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore']
          })
          headFiles.set(file, content)
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
  if (VERBOSE) console.log(`  Comparing: ${baseBranch} ? ${headBranch}${isWorkingDirectory ? ' (with working changes)' : ''}`)
  
  const watchedFiles = new Map()
  const watchTimeout = new Map()
  
  // Watch working directory changes if applicable
  if (isWorkingDirectory) {
    const changedFilesList = metadata.get('changedFiles') || []
    
    changedFilesList.forEach(relativePath => {
      const fullPath = path.join(process.cwd(), relativePath)
      if (!fs.existsSync(fullPath)) return
      
      createFileWatcher(relativePath, (relPath, fullPath, eventType) => {
        try {
          if (fs.existsSync(fullPath)) {
            const content = fs.readFileSync(fullPath, 'utf8')
            if (content !== headFiles.get(relPath)) {
              ydoc.transact(() => headFiles.set(relPath, content))
              if (VERBOSE) console.log(`[${name}] Updated in diff: ${relPath}`)
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

// Git utilities
const verifyGitRepo = () => {
  try {
    execSync('git rev-parse --git-dir', { stdio: 'ignore' })
    return true
  } catch {
    console.error('Error: Not in a git repository')
    process.exit(1)
  }
}

const getCurrentBranch = () => {
  try {
    const branch = execSync('git branch --show-current').toString().trim()
    if (!branch) throw new Error('Detached HEAD state')
    return branch
  } catch (error) {
    console.error('Error getting current branch:', error.message)
    process.exit(1)
  }
}

const getDefaultBranch = () => {
  for (const branch of ['main', 'master']) {
    try {
      execSync(`git show-ref --verify refs/heads/${branch}`, { stdio: 'ignore' })
      return branch
    } catch {}
  }
  console.error('Error: No main or master branch found')
  process.exit(1)
}

const verifyBranch = (branch) => {
  try {
    execSync(`git show-ref --verify refs/heads/${branch}`, { stdio: 'ignore' })
  } catch {
    console.error(`Error: Branch '${branch}' does not exist`)
    process.exit(1)
  }
}

// Main execution
const main = () => {
  const args = process.argv.slice(2)
  const parsed = parseArgs(args)
  VERBOSE = parsed.verbose
  
  if (parsed.showHelp) {
    console.log(HELP)
    return
  }
  
  if (parsed.showVersion) {
    const { version } = require('../package.json')
    console.log(`ghostpipe v${version}`)
    return
  }
  
  const config = loadConfig()
  const signalingServer = config.signalingServer || DEFAULT_SIGNALING
  
  // Handle diff command
  if (parsed.command === 'diff') {
    verifyGitRepo()
    
    const currentBranch = getCurrentBranch()
    const defaultBranch = getDefaultBranch()
    
    // Parse diff arguments
    const diffArgs = args.slice(args.indexOf('diff') + 1).filter(arg => !arg.startsWith('--'))
    const [baseBranch = defaultBranch, headBranch = currentBranch] = diffArgs
    
    if (diffArgs.length > 2) {
      console.error('Error: Too many arguments for diff command')
      process.exit(1)
    }
    
    verifyBranch(baseBranch)
    verifyBranch(headBranch)
    
    if (!config.hosts?.length) {
      console.error('Error: No hosts configured. Please create a .ghostpipe.json config file.')
      process.exit(1)
    }
    
    console.log(`\nComparing: ${baseBranch} ? ${headBranch}${currentBranch === headBranch ? ' (with working changes)' : ''}`)
    
    const cleanups = config.hosts.map(host => createDiffSession(host, baseBranch, headBranch, signalingServer))
    
    console.log('\nDiff pipes running. Press Ctrl+C to stop.')
    
    process.on('SIGINT', () => {
      console.log('\nShutting down...')
      cleanups.forEach(cleanup => cleanup())
      process.exit(0)
    })
    
    return
  }
  
  if (parsed.command) {
    console.log(`Unknown command: ${parsed.command}`)
    console.log('Run "ghostpipe --help" for usage')
    process.exit(1)
  }
  
  // Normal file sharing mode
  const cleanups = []
  
  if (config.hosts?.length) {
    if (VERBOSE) console.log(`Starting with ${config.hosts.length} host(s)...`)
    config.hosts.forEach(host => cleanups.push(createSession(host, signalingServer)))
  } else {
    const host = parsed.host || config.host || DEFAULT_HOST
    if (VERBOSE) console.log('Starting in single host mode...')
    cleanups.push(createSession(host, signalingServer))
  }
  
  console.log('\nPipes running. Press Ctrl+C to stop.')
  
  process.on('SIGINT', () => {
    console.log('\nShutting down...')
    cleanups.forEach(cleanup => cleanup())
    process.exit(0)
  })
}

main()
