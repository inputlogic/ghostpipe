#!/usr/bin/env node
const crypto = require('crypto');
const { Command } = require('commander')
const { Doc: YDoc } = require('yjs')
const { WebrtcProvider } = require('y-webrtc')
const path = require('path')
const wrtc = require('@roamhq/wrtc')
const fs = require('fs')
const chokidar = require('chokidar')

const program = new Command()

program
  .name('ghostpipe')
  .description('Interfaces for your codebase')
  .version(require('../package.json').version)
  .option('--verbose', 'Enable verbose logging')

program.action((options) => {
  connect({verbose: options.verbose})
  // const config = loadConfig()
  // const signalingServer = config.signalingServer || DEFAULT_SIGNALING
  // const cleanups = handleFileSharing(config, signalingServer, options)
  // console.log('\nPress Ctrl+C to stop.')
  // setupShutdownHandler(cleanups)
})

const connect = ({verbose}) => {
  const options = {
    signalingServer: 'wss://signaling.ghostpipe.dev'
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
      console.log('update yo', event)
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
      interfaces.filter(intf => intf.files.includes(path)).forEach(intf => {
        intf.ydoc.getMap('files').set(path, content)
      })
    }
  })
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    console.error(error)
    return null
  }
}

program.parse()

