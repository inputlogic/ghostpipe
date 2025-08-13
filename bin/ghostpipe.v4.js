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

// Utility functions
const safeReadFile = (filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    return null
  }
}

const safeWriteFile = (filePath, content) => {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, content, 'utf8')
    return true
  } catch (error) {
    console.error(`Error writing ${filePath}:`, error.message)
    return false
  }
}

const safeExecuteGit = (command) => {
  try {
    return execSync(command, { 
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim()
  } catch (error) {
    return null
  }
}

// Config & Args
const loadConfig = () => {
  const configPaths = [
    path.join(process.cwd(), '.ghostpipe.json'),
    path.join(os.homedir(), '.config', 'ghostpipe.json')
  ]
  
  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      try {
        return JSON.parse(fs.readFileSync(configPath, 'utf8'))
      } catch (error) {
        console.error(`Error loading ${configPath}:`, error.message)
      }
    }
  }
  
  return {}
}

const parseArgs = (args) => {
  const parsed = {
    command: null,
    showHelp: false,
    showVersion: false,
    verbose: false,
    host: null
  }
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    
    if (arg === '--help' || arg === '-h') {
      parsed.showHelp = true
    } else if (arg === '--version' || arg === '-v') {
      parsed.showVersion = true
    } else if (arg === '--verbose') {
      parsed.verbose = true
    } else if (arg === '--host' && args[i + 1]) {
      parsed.host = args[i + 1]
      i++ // Skip next argument as it's the host value
    } else if (!arg.startsWith('-') && !parsed.command) {
      parsed.command = arg
    }
  }
  
  return parsed
}

// Host configuration utilities
const createHostConfig = (hostConfig) => {
  if (typeof hostConfig === 'string') {
    return {
      host: hostConfig,
      name: 'Default',
      allowedFiles: null
    }
  }
  
  return {
    host: hostConfig.host,
    name: hostConfig.name || 'Default',
    allowedFiles: hostConfig.files || null
  }
}

// File Operations
const getAllFiles = (dirPath, basePath = '', fileList = [], allowedFiles = null) => {
  const files = fs.readdirSync(dirPath)
  
  for (const file of files) {
    if (IGNORED_PATHS.some(ignored => file.startsWith(ignored))) {
      continue
    }
    
    const filePath = path.join(dirPath, file)
    const relativePath = path.join(basePath, file)
    const stat = fs.statSync(filePath)
    
    if (stat.isDirectory()) {
      getAllFiles(filePath, relativePath, fileList, allowedFiles)
    } else if (stat.isFile() && (!allowedFiles || allowedFiles.includes(relativePath))) {
      const content = safeReadFile(filePath)
      if (content !== null) {
        fileList.push({ path: relativePath, content })
      } else {
        log(`Skipping binary: ${relativePath}`)
      }
    }
  }
  
  return fileList
}

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

// WebRTC & URL Generation
const createProvider = (pipeId, signalingServer) => {
  const ydoc = new YDoc()
  const provider = new WebrtcProvider(pipeId, ydoc, {
    signaling: [signalingServer],
    peerOpts: { wrtc }
  })
  
  return { ydoc, provider }
}

const generateUrl = (host, pipeId, signalingServer, mode = 'gui') => {
  const baseUrl = host.startsWith('http') ? host : `http://${host}`
  return `${baseUrl}/${mode}?pipe=${pipeId}&signaling=${encodeURIComponent(signalingServer)}`
}

// Session setup utilities
const setupSessionMetadata = (ydoc) => {
  const metadata = ydoc.getMap('metadata')
  metadata.set('created', new Date().toISOString())
  metadata.set('cwd', process.cwd())
  return metadata
}

const setupFileSync = (files, allowedFiles, name) => {
  let updatingFromGUI = false
  
  const handleGUIChanges = (event) => {
    updatingFromGUI = true
    
    event.changes.keys.forEach((change, key) => {
      if (allowedFiles && !allowedFiles.includes(key)) {
        return
      }
      
      const filePath = path.join(process.cwd(), key)
      
      if (change.action === 'update' || change.action === 'add') {
        if (safeWriteFile(filePath, files.get(key))) {
          log(`[${name}] Updated: ${key}`)
        }
      } else if (change.action === 'delete') {
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath)
            log(`[${name}] Deleted: ${key}`)
          }
        } catch (error) {
          console.error(`Error deleting ${key}:`, error.message)
        }
      }
    })
    
    updatingFromGUI = false
  }
  
  files.observe(handleGUIChanges)
  
  return { 
    isUpdatingFromGUI: () => updatingFromGUI,
    setUpdatingFromGUI: (value) => { updatingFromGUI = value }
  }
}

const setupFileWatching = (allFiles, files, name, allowedFiles, syncState) => {
  const watchedFiles = new Map()
  const watchTimeout = new Map()
  
  const handleFileChange = (relativePath, fullPath) => {
    if (syncState.isUpdatingFromGUI()) {
      return
    }
    
    try {
      if (fs.existsSync(fullPath)) {
        const content = safeReadFile(fullPath)
        if (content !== null && content !== files.get(relativePath)) {
          files.set(relativePath, content)
          log(`[${name}] Local change: ${relativePath}`)
        }
      } else if (files.has(relativePath)) {
        files.delete(relativePath)
        log(`[${name}] Local delete: ${relativePath}`)
        const watcher = watchedFiles.get(relativePath)
        if (watcher) {
          watcher.close()
          watchedFiles.delete(relativePath)
        }
      }
    } catch (error) {
      log(`Error handling change for ${relativePath}:`, error.message)
    }
  }
  
  // Watch individual files
  allFiles.forEach(file => {
    createFileWatcher(file.path, handleFileChange, watchedFiles, watchTimeout)
  })
  
  // Watch directory for new files
  const dirWatcher = fs.watch(process.cwd(), { recursive: true }, (eventType, filename) => {
    if (!filename || syncState.isUpdatingFromGUI()) {
      return
    }
    
    if (IGNORED_PATHS.some(ignored => filename.includes(ignored))) {
      return
    }
    
    if (allowedFiles && !allowedFiles.includes(filename)) {
      return
    }
    
    clearTimeout(watchTimeout.get(filename))
    watchTimeout.set(filename, setTimeout(() => {
      handleFileChange(filename, path.join(process.cwd(), filename))
      createFileWatcher(filename, handleFileChange, watchedFiles, watchTimeout)
      watchTimeout.delete(filename)
    }, 100))
  })
  
  return {
    watchedFiles,
    dirWatcher,
    cleanup: () => {
      watchedFiles.forEach(watcher => watcher.close())
      dirWatcher.close()
    }
  }
}

// Main Session
const createSession = (hostConfig, signalingServer) => {
  const { host, name, allowedFiles } = createHostConfig(hostConfig)
  const pipeId = `ghostpipe-${Math.random().toString(36).substring(7)}`
  const { ydoc, provider } = createProvider(pipeId, signalingServer)
  
  log(`\nPipe created for ${name}: ${pipeId}`)
  console.log(`${name}: ${generateUrl(host, pipeId, signalingServer)}`)
  
  const files = ydoc.getMap('files')
  setupSessionMetadata(ydoc)
  
  // Load initial files
  const allFiles = getAllFiles(process.cwd(), '', [], allowedFiles)
  log(`Loading ${allFiles.length} files...`)
  allFiles.forEach(file => files.set(file.path, file.content))
  
  // Setup file synchronization
  const syncState = setupFileSync(files, allowedFiles, name)
  const fileWatching = setupFileWatching(allFiles, files, name, allowedFiles, syncState)
  
  return () => {
    provider.destroy()
    fileWatching.cleanup()
  }
}

// Diff utilities
const loadBranchFiles = (changedFiles, baseBranch, headBranch, baseFiles, headFiles, isWorkingDirectory) => {
  changedFiles.forEach(file => {
    // Load base branch file
    const baseContent = safeExecuteGit(`git show ${baseBranch}:${file} 2>/dev/null`)
    baseFiles.set(file, baseContent || '') // Empty string for new files
    
    // Load head branch file
    if (isWorkingDirectory) {
      const filePath = path.join(process.cwd(), file)
      const content = safeReadFile(filePath)
      headFiles.set(file, content || '')
    } else {
      const headContent = safeExecuteGit(`git show ${headBranch}:${file} 2>/dev/null`)
      headFiles.set(file, headContent || '') // Empty string for deleted files
    }
  })
}

const getChangedFiles = (baseBranch, headBranch, isWorkingDirectory) => {
  if (isWorkingDirectory) {
    const branchDiff = safeExecuteGit(`git diff --name-only ${baseBranch}...${headBranch}`)
    const workingDiff = safeExecuteGit(`git diff --name-only ${baseBranch}`)
    
    const branchFiles = branchDiff ? branchDiff.split('\n').filter(Boolean) : []
    const workingFiles = workingDiff ? workingDiff.split('\n').filter(Boolean) : []
    
    return Array.from(new Set([...branchFiles, ...workingFiles]))
  } else {
    const diffOutput = safeExecuteGit(`git diff --name-only ${baseBranch}...${headBranch}`)
    return diffOutput ? diffOutput.split('\n').filter(Boolean) : []
  }
}

// Diff Session
const createDiffSession = (hostConfig, baseBranch, headBranch, signalingServer) => {
  const { name = 'Default', host, files: allowedFiles = null } = typeof hostConfig === 'string' 
    ? { host: hostConfig, name: 'Default', files: null }
    : hostConfig
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
    // Get changed files - using exact original logic
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
    
    // Load files from both branches - using exact original logic
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
  
  // Watch working directory changes if applicable - using v1 working logic
  if (isWorkingDirectory) {
    // Watch each file for changes - v1 implementation
    const watchFile = (relativePath) => {
      const fullPath = path.join(process.cwd(), relativePath)
      
      if (watchedFiles.has(relativePath)) {
        return
      }
      
      // Check if file exists before watching
      if (!fs.existsSync(fullPath)) {
        log(`[${name}] Skipping watch for non-existent file: ${relativePath}`)
        return
      }
      
      try {
        log(`[${name}] Watching file: ${relativePath}`)
        
        const createWatcher = () => {
          const watcher = fs.watch(fullPath, (eventType) => {
            // Debounce rapid changes
            if (watchTimeout.has(relativePath)) {
              clearTimeout(watchTimeout.get(relativePath))
            }
            
            watchTimeout.set(relativePath, setTimeout(() => {
              log(`[${name}] Detected ${eventType} for: ${relativePath}`)
              // Handle both 'change' and 'rename' events (macOS reports 'rename' for modifications)
              if (eventType === 'change' || eventType === 'rename') {
                try {
                  if (!fs.existsSync(fullPath)) {
                    log(`[${name}] File no longer exists: ${relativePath}`)
                    return
                  }
                  
                  const content = fs.readFileSync(fullPath, 'utf8')
                  const currentContent = headFiles.get(relativePath)
                  
                  log(`[${name}] File size - old: ${currentContent ? currentContent.length : 0}, new: ${content.length}`)
                  
                  if (content !== currentContent) {
                    // Use Y.js transaction to ensure proper sync
                    ydoc.transact(() => {
                      headFiles.set(relativePath, content)
                    })
                    log(`[${name}] Updated file in diff: ${relativePath} (${content.length} bytes)`)
                  } else {
                    log(`[${name}] File content unchanged: ${relativePath}`)
                  }
                  
                  // Re-establish watcher after rename event (macOS issue)
                  if (eventType === 'rename') {
                    log(`[${name}] Re-establishing watcher for: ${relativePath}`)
                    if (watchedFiles.has(relativePath)) {
                      watchedFiles.get(relativePath).close()
                    }
                    // Small delay to let filesystem settle
                    setTimeout(() => {
                      if (fs.existsSync(fullPath)) {
                        const newWatcher = createWatcher()
                        watchedFiles.set(relativePath, newWatcher)
                      }
                    }, 50)
                  }
                } catch (err) {
                  console.error(`[${name}] Error reading changed file ${relativePath}:`, err.message)
                }
              }
              watchTimeout.delete(relativePath)
            }, 100))
          })
          
          return watcher
        }
        
        const watcher = createWatcher()
        watchedFiles.set(relativePath, watcher)
      } catch (err) {
        console.error(`[${name}] Error watching file ${relativePath}:`, err.message)
      }
    }
    
    // Start watching all tracked files
    const changedFiles = metadata.get('changedFiles') || []
    log(`[${name}] Setting up file watchers for ${changedFiles.length} files in working directory`)
    changedFiles.forEach(file => {
      watchFile(file)
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
      if (!branch) {
        throw new Error('Detached HEAD state')
      }
      return branch
    } catch (error) {
      console.error('Error getting current branch:', error.message)
      process.exit(1)
    }
  },
  
  getDefaultBranch: () => {
    const branches = ['main', 'master']
    
    for (const branch of branches) {
      try {
        execSync(`git show-ref --verify refs/heads/${branch}`, { stdio: 'ignore' })
        return branch
      } catch {
        continue
      }
    }
    
    console.error('Error: No main or master branch found')
    process.exit(1)
  },
  
  verifyBranch: (branch) => {
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
  const baseBranch = diffArgs[0] || defaultBranch
  const headBranch = diffArgs[1] || currentBranch
  
  if (diffArgs.length > 2) {
    console.error('Error: Too many arguments for diff command')
    process.exit(1)
  }
  
  gitUtils.verifyBranch(baseBranch)
  gitUtils.verifyBranch(headBranch)
  
  if (!config.hosts || config.hosts.length === 0) {
    console.error('Error: No hosts configured. Please create a .ghostpipe.json config file.')
    process.exit(1)
  }
  
  console.log(`\nComparing: ${baseBranch} ↔ ${headBranch}${currentBranch === headBranch ? ' (with working changes)' : ''}`)
  
  return config.hosts.map(host => createDiffSession(host, baseBranch, headBranch, signalingServer))
}

const handleFileSharing = (config, signalingServer, parsed) => {
  if (config.hosts && config.hosts.length > 0) {
    log(`Starting with ${config.hosts.length} host(s)...`)
    return config.hosts.map(host => createSession(host, signalingServer))
  } else {
    log('Starting in single host mode...')
    const host = parsed.host || config.host || DEFAULT_HOST
    return [createSession(host, signalingServer)]
  }
}

const setupShutdownHandler = (cleanups) => {
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
  
  if (parsed.showHelp) {
    console.log(HELP)
    return
  }
  
  if (parsed.showVersion) {
    console.log(`ghostpipe v${require('../package.json').version}`)
    return
  }
  
  const config = loadConfig()
  const signalingServer = config.signalingServer || DEFAULT_SIGNALING
  
  // Handle diff command
  if (parsed.command === 'diff') {
    const diffArgs = process.argv.slice(2)
      .slice(process.argv.slice(2).indexOf('diff') + 1)
      .filter(arg => !arg.startsWith('--'))
    
    const cleanups = handleDiff(config, signalingServer, diffArgs)
    console.log('\nDiff pipes running. Press Ctrl+C to stop.')
    setupShutdownHandler(cleanups)
    return
  }
  
  // Handle unknown commands
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
