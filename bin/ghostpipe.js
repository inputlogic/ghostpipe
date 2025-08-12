#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const os = require('os')
const { Doc: YDoc } = require('yjs')
const { WebrtcProvider } = require('y-webrtc')
const wrtc = require('@roamhq/wrtc')

const args = process.argv.slice(2)
let VERBOSE = false

const DEFAULT_HOST = 'https://ghostpipe.dev'
const DEFAULT_SIGNALING_SERVER = 'wss://signaling.ghostpipe.dev'

const loadConfig = () => {
  const localConfigPath = path.join(process.cwd(), '.ghostpipe.json')
  const globalConfigPath = path.join(os.homedir(), '.config', 'ghostpipe.json')
  
  // Try local config first (highest priority)
  try {
    if (fs.existsSync(localConfigPath)) {
      const configData = fs.readFileSync(localConfigPath, 'utf8')
      return JSON.parse(configData)
    }
  } catch (error) {
    console.error('Error loading local config:', error.message)
  }
  
  // Try global config second
  try {
    if (fs.existsSync(globalConfigPath)) {
      const configData = fs.readFileSync(globalConfigPath, 'utf8')
      return JSON.parse(configData)
    }
  } catch (error) {
    console.error('Error loading global config:', error.message)
  }
  
  return {}
}

const getAllFiles = (dirPath, basePath = '', fileList = [], allowedFiles = null) => {
  const files = fs.readdirSync(dirPath)
  
  files.forEach(file => {
    const filePath = path.join(dirPath, file)
    const relativePath = path.join(basePath, file)
    
    // Skip hidden files, node_modules, and common build directories
    if (file.startsWith('.') || 
        file === 'node_modules' || 
        file === 'dist' || 
        file === 'build' ||
        file === '.git') {
      return
    }
    
    const stat = fs.statSync(filePath)
    
    if (stat.isDirectory()) {
      getAllFiles(filePath, relativePath, fileList, allowedFiles)
    } else if (stat.isFile()) {
      // If allowedFiles is specified, only include those files
      if (allowedFiles && !allowedFiles.includes(relativePath)) {
        return
      }
      
      try {
        const content = fs.readFileSync(filePath, 'utf8')
        fileList.push({ path: relativePath, content })
      } catch (err) {
        // Skip files that can't be read as text
        if (VERBOSE) console.warn(`Skipping binary or unreadable file: ${relativePath}`)
      }
    }
  })
  
  return fileList
}

const parseArgs = (args) => {
  const parsed = {
    host: null,
    command: null,
    showHelp: false,
    showVersion: false,
    verbose: false
  }
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    
    if (arg === '--help') {
      parsed.showHelp = true
    } else if (arg === '-h' || arg === '--host') {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        parsed.host = args[i + 1]
        i++
      } else if (arg === '-h') {
        parsed.showHelp = true
      }
    } else if (arg === '-v' || arg === '--version') {
      parsed.showVersion = true
    } else if (arg === '--verbose') {
      parsed.verbose = true
    } else if (!arg.startsWith('-')) {
      parsed.command = arg
    }
  }
  
  return parsed
}

const createSession = (hostConfig, signalingServer) => {
  // If hostConfig is a string, treat it as a simple host URL
  const isSimpleHost = typeof hostConfig === 'string'
  const host = isSimpleHost ? hostConfig : hostConfig.host
  const name = isSimpleHost ? 'Default' : hostConfig.name
  const allowedFiles = isSimpleHost ? null : hostConfig.files
  
  // Generate a random pipe ID for this session
  const pipeId = `ghostpipe-${Math.random().toString(36).substring(7)}`
  
  // Create a new Y.js document
  const ydoc = new YDoc()
  
  // Create WebRTC provider for collaboration
  const provider = new WebrtcProvider(pipeId, ydoc, {
    signaling: [signalingServer],
    peerOpts: {
      wrtc: wrtc
    }
  })
  
  if (VERBOSE) console.log(`\nPipe created for ${name}: ${pipeId}`)
  
  // URL-encode the signaling server URL
  const encodedSignaling = encodeURIComponent(signalingServer)
  
  // Parse host to build proper URL
  let connectUrl
  if (host.startsWith('http://') || host.startsWith('https://')) {
    connectUrl = `${host}?pipe=${pipeId}&signaling=${encodedSignaling}`
  } else {
    // Assume http:// if no protocol specified
    connectUrl = `http://${host}?pipe=${pipeId}&signaling=${encodedSignaling}`
  }
  
  console.log(`${name}: ${connectUrl}`)
  
  // Set up basic Y.js data structures
  const files = ydoc.getMap('files')
  const metadata = ydoc.getMap('metadata')
  
  // Initialize metadata
  metadata.set('created', new Date().toISOString())
  metadata.set('cwd', process.cwd())
  
  // Load files from current directory (filtered if allowedFiles is specified)
  const allFiles = getAllFiles(process.cwd(), '', [], allowedFiles)
  
  if (allFiles.length === 0) {
    if (allowedFiles) {
      if (VERBOSE) console.log(`No matching files found for ${name}`)
      files.set('info.txt', `No files found matching the filter for ${name}`)
    } else {
      if (VERBOSE) console.log('No files found in current directory')
      files.set('welcome.txt', 'No files found in the current directory')
    }
  } else {
    if (allowedFiles) {
      if (VERBOSE) console.log(`Loading ${allFiles.length} files for ${name}:`, allowedFiles)
    } else {
      if (VERBOSE) console.log(`Loading ${allFiles.length} files...`)
    }
    allFiles.forEach(file => {
      files.set(file.path, file.content)
    })
  }
  
  // Track if we're currently updating from GUI to avoid loops
  let updatingFromGUI = false
  
  // Watch for changes from the GUI and write them back to filesystem
  files.observe((event) => {
    updatingFromGUI = true
    event.changes.keys.forEach((change, key) => {
      // If allowedFiles is specified, only allow changes to those files
      if (allowedFiles && !allowedFiles.includes(key)) {
        if (VERBOSE) console.log(`Ignoring change to restricted file: ${key}`)
        return
      }
      
      if (change.action === 'update' || change.action === 'add') {
        const content = files.get(key)
        const filePath = path.join(process.cwd(), key)
        
        try {
          // Create directory if it doesn't exist
          const dir = path.dirname(filePath)
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true })
          }
          
          // Write the file
          fs.writeFileSync(filePath, content, 'utf8')
          if (VERBOSE) console.log(`[${name}] Updated file: ${key}`)
        } catch (err) {
          console.error(`Error writing file ${key}:`, err.message)
        }
      } else if (change.action === 'delete') {
        const filePath = path.join(process.cwd(), key)
        
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath)
            if (VERBOSE) console.log(`[${name}] Deleted file: ${key}`)
          }
        } catch (err) {
          console.error(`Error deleting file ${key}:`, err.message)
        }
      }
    })
    updatingFromGUI = false
  })
  
  // Watch for local filesystem changes
  const watchedFiles = new Map()
  const watchTimeout = new Map()
  
  const watchFile = (relativePath) => {
    // Only watch files that are in the allowed list (if specified)
    if (allowedFiles && !allowedFiles.includes(relativePath)) {
      return
    }
    
    const fullPath = path.join(process.cwd(), relativePath)
    
    if (watchedFiles.has(relativePath)) {
      return
    }
    
    try {
      const watcher = fs.watch(fullPath, (eventType) => {
        // Debounce rapid changes
        if (watchTimeout.has(relativePath)) {
          clearTimeout(watchTimeout.get(relativePath))
        }
        
        watchTimeout.set(relativePath, setTimeout(() => {
          if (!updatingFromGUI) {
            if (eventType === 'change') {
              try {
                const content = fs.readFileSync(fullPath, 'utf8')
                const currentContent = files.get(relativePath)
                if (content !== currentContent) {
                  files.set(relativePath, content)
                  if (VERBOSE) console.log(`[${name}] Local file changed: ${relativePath}`)
                }
              } catch (err) {
                console.error(`Error reading changed file ${relativePath}:`, err.message)
              }
            }
          }
          watchTimeout.delete(relativePath)
        }, 100))
      })
      
      watchedFiles.set(relativePath, watcher)
    } catch (err) {
      console.error(`Error watching file ${relativePath}:`, err.message)
    }
  }
  
  // Start watching all initial files
  allFiles.forEach(file => {
    watchFile(file.path)
  })
  
  // Watch the current directory for new files
  const dirWatcher = fs.watch(process.cwd(), { recursive: true }, (eventType, filename) => {
    if (!filename || updatingFromGUI) return
    
    // Skip ignored paths
    if (filename.startsWith('.') || 
        filename.includes('node_modules') || 
        filename.includes('dist') || 
        filename.includes('build') ||
        filename.includes('.git')) {
      return
    }
    
    // If allowedFiles is specified, only watch those files
    if (allowedFiles && !allowedFiles.includes(filename)) {
      return
    }
    
    const fullPath = path.join(process.cwd(), filename)
    
    // Debounce directory changes
    if (watchTimeout.has(filename)) {
      clearTimeout(watchTimeout.get(filename))
    }
    
    watchTimeout.set(filename, setTimeout(() => {
      try {
        if (fs.existsSync(fullPath)) {
          const stat = fs.statSync(fullPath)
          if (stat.isFile()) {
            try {
              const content = fs.readFileSync(fullPath, 'utf8')
              const currentContent = files.get(filename)
              if (content !== currentContent) {
                files.set(filename, content)
                if (VERBOSE) console.log(`[${name}] Local file added/changed: ${filename}`)
                watchFile(filename)
              }
            } catch (err) {
              // Skip binary files
            }
          }
        } else {
          // File was deleted
          if (files.has(filename)) {
            files.delete(filename)
            if (VERBOSE) console.log(`[${name}] Local file deleted: ${filename}`)
            if (watchedFiles.has(filename)) {
              watchedFiles.get(filename).close()
              watchedFiles.delete(filename)
            }
          }
        }
      } catch (err) {
        console.error(`Error handling file change for ${filename}:`, err.message)
      }
      watchTimeout.delete(filename)
    }, 100))
  })
  
  // Return cleanup function
  return () => {
    provider.destroy()
    watchedFiles.forEach(watcher => watcher.close())
    dirWatcher.close()
  }
}

const main = () => {
  const parsed = parseArgs(args)
  VERBOSE = parsed.verbose
  
  if (parsed.showHelp) {
    console.log('ghostpipe - CLI tool')
    console.log('\nUsage:')
    console.log('  ghostpipe [options] [command]')
    console.log('\nOptions:')
    console.log('  --help         Show help')
    console.log('  -h, --host     Specify host URL')
    console.log('  -v, --version  Show version')
    console.log('  --verbose      Enable verbose logging')
    console.log('\nConfiguration:')
    console.log('  Create a .ghostpipe.json file in your project or ~/.config/')
    console.log('  to configure multiple hosts with file restrictions')
    return
  }

  if (parsed.showVersion) {
    const { version } = require('../package.json')
    console.log(`ghostpipe v${version}`)
    return
  }
  
  const config = loadConfig()
  const signalingServer = config.signalingServer || DEFAULT_SIGNALING_SERVER
  
  if (parsed.command) {
    console.log('Unknown command:', parsed.command)
    console.log('Run "ghostpipe --help" for usage information')
    process.exit(1)
  }
  
  // Check if config has hosts array
  if (config.hosts && Array.isArray(config.hosts) && config.hosts.length > 0) {
    if (VERBOSE) {
      console.log('Starting Ghostpipe with multiple hosts...')
      console.log(`Found ${config.hosts.length} host configuration(s)`)
    }
    
    const cleanupFunctions = []
    
    // Create a session for each host
    config.hosts.forEach((hostConfig) => {
      const cleanup = createSession(hostConfig, signalingServer)
      cleanupFunctions.push(cleanup)
    })
    
    console.log('\nAll pipes are running. Press Ctrl+C to stop.')
    
    // Handle cleanup on exit
    process.on('SIGINT', () => {
      console.log('\nShutting down all Ghostpipe connections...')
      cleanupFunctions.forEach(cleanup => cleanup())
      process.exit(0)
    })
  } else {
    // Fall back to single host mode
    const resolvedHost = parsed.host || config.host || DEFAULT_HOST
    if (VERBOSE) console.log('Starting Ghostpipe in single host mode...')
    const cleanup = createSession(resolvedHost, signalingServer)
    
    console.log('\nGhostpipe is running. Press Ctrl+C to stop.')
    
    // Handle cleanup on exit
    process.on('SIGINT', () => {
      console.log('\nShutting down Ghostpipe...')
      cleanup()
      process.exit(0)
    })
  }
}

main()
