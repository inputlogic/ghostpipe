#!/usr/bin/env node
const crypto = require('crypto');
const { Command } = require('commander')
const { Doc: YDoc } = require('yjs')
const { WebrtcProvider } = require('y-webrtc')
const { minimatch } = require('minimatch')
const path = require('path')
const wrtc = require('@roamhq/wrtc')
const fs = require('fs')
const chokidar = require('chokidar')
const { execSync } = require('child_process')

const program = new Command()

program
  .name('ghostpipe')
  .description('Interfaces for your codebase')
  .version(require('../package.json').version)
  .option('--verbose', 'Enable verbose logging')
  .option('--diff [branch]', 'Base branch for diff comparison')

program.action((options) => {
  connect(options)
})

const connect = ({verbose, diff}) => {
  console.log('diff', diff)
  const log = (...args) => verbose && console.log(...args)
  const options = {
    signalingServer: 'wss://signaling.ghostpipe.dev'
  }
  const config = readJson('.ghostpipe.json')
  const filesBeingUpdatedFromRemote = new Set()
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
        // const match = findMatch('w', intf.files, key)
        if (!hasPermission('w', intf.files, key)) return
        const currentContent = ydoc.getMap('files').get(key)
        const fileContent = fs.readFileSync(key, 'utf8')
        if (currentContent === fileContent) return
        if (change.action === 'update' || change.action === 'add') {
          log('file change remote', key)
          filesBeingUpdatedFromRemote.add(key)
          fs.writeFileSync(key, currentContent, 'utf8')
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
  chokidar.watch('.').on('all', (event, path) => {
    if (event === 'add') {
      const content = fs.readFileSync(path, 'utf8')
      interfaces.filter(intf => hasPermission('r', intf.files, path)).forEach(intf => {
        console.log('file add', path)
        intf.ydoc.getMap('files').set(path, content)
      })
    }
    if (event === 'change') {
      if (filesBeingUpdatedFromRemote.has(path)) {
        filesBeingUpdatedFromRemote.delete(path)
        return
      }
      const fileContent = fs.readFileSync(path, 'utf8')
      interfaces.filter(intf => hasPermission('r', intf.files, path)).forEach(intf => {
        const content = intf.ydoc.getMap('files').get(path)
        if (content !== fileContent) {
          console.log('file change local', path)
          intf.ydoc.getMap('files').set(path, fileContent)
        }
      })
    }
  })

  if (diff) {
    diff = diff === true ? 'main' : diff
    
    try {
      // Get list of changed files between current branch and diff branch
      const changedFiles = execSync(`git diff --name-only ${diff}...HEAD`, { encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter(Boolean)
      
      // For each interface, load the diff branch version of matching files
      interfaces.forEach(intf => {
        changedFiles.forEach(file => {
          // Check if this file matches any of the interface's file patterns
          if (hasPermission('r', intf.files, file)) {
            try {
              // Get the file content from the diff branch
              const content = execSync(`git show ${diff}:${file}`, { 
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'ignore']
              })
              
              // Set the content in the baseFiles map
              intf.ydoc.getMap('base-files').set(file, content)
              console.log(`Loaded diff file for ${intf.name}: ${file}`)
            } catch (error) {
              // File might not exist in diff branch (new file)
              console.log(`File not in ${diff} branch: ${file}`)
            }
          }
        })
      })
    } catch (error) {
      console.error('Error loading diff files:', error.message)
    }
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

// const findMatch = (permission, patterns, file) =>
//   patterns.filter(pattern => {
//     const {glob, map, permissions} = fileString(pattern)
//     if (!permissions.includes(permission)) return
//     if (map) {
//       return minimatch(file, map)
//     } else {
//       return minimatch(file, glob)
//     }
//   })[0]

program.parse()

