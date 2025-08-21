# Ghostpipe

A CLI tool to connect codebase files to user interfaces.

## Local development

- clone the repo
- `npm install`
- `npm link`
- now you should be able to run `ghostpipe` from any project

## How it works

When you run `ghostpipe` in a project, it will look for a .ghostpipe.json file that lists the interfaces you are using.
The CLI tool will then list a url for each interface. Each url includes `pipe` and `signaling` query params. The interfaces will use these 2 query params to connect to the local repo using yjs and webrtc. See use-ghostpipe.js for a nextjs example hook.

## Installation

```bash
npm install -g ghostpipe
```

## Usage

### File Sharing Mode (Default)

Share your current directory files with a web interface:

```bash
ghostpipe
```

With options:
```bash
ghostpipe --verbose           # Enable verbose logging
```

### Diff Mode

Compare current working directory files with a git branch:

```bash
ghostpipe --diff              # Compare with 'main' branch (default)
ghostpipe --diff develop      # Compare with 'develop' branch
ghostpipe --diff feature-123  # Compare with 'feature-123' branch
```

When diff mode is enabled, the tool will:
- Share your current working directory files
- Also send the base version of each changed file from the specified git branch
- Allow interfaces to display diffs between the current version and the base branch version

### Configuration

Create a `.ghostpipe.json` file in your project root or `~/.config/ghostpipe.json`:

```json
{
  "signalingServer": "wss://your-signaling.com",
  "interfaces": [
    {
      "name": "OpenAPI",
      "host": "https://swagger.ghostpipe.dev",
      "files": [".ghostpipe/openapi.yml"]
    },
    {
      "name": "ERD",
      "host": "https://erd.ghostpipe.dev",
      "files": [".ghostpipe/erd.yml"]
    }
  ]
}
```

### Options

- `--verbose`: Enable detailed logging
- `--host <url>`: Override the default or configured host URL
- `--version`: Show version information
- `--help`: Display help information

## Creating a Web Interface

Here's a minimal example of how to create a web interface that connects to Ghostpipe using Y.js and WebRTC:

```html
<!DOCTYPE html>
<html>
<head>
  <title>Ghostpipe Interface</title>
  <script src="https://unpkg.com/yjs@13/dist/yjs.min.js"></script>
  <script src="https://unpkg.com/y-webrtc@10/dist/y-webrtc.min.js"></script>
</head>
<body>
  <h1>Connected Files</h1>
  <div id="files"></div>
  
  <script>
    // Get connection params from URL
    const params = new URLSearchParams(window.location.search)
    const pipeId = params.get('pipe')
    const signalingServer = params.get('signaling')
    
    if (!pipeId || !signalingServer) {
      document.body.innerHTML = '<p>Missing connection parameters. Launch this interface from Ghostpipe CLI.</p>'
    } else {
      // Create Y.js document
      const ydoc = new Y.Doc()
      
      // Connect via WebRTC using the signaling server
      const provider = new WebrtcProvider(pipeId, ydoc, {
        signaling: [signalingServer]
      })
      
      // Get the shared files map
      const files = ydoc.getMap('files')
      
      // Display files when they change
      files.observe(() => {
        const filesDiv = document.getElementById('files')
        filesDiv.innerHTML = ''
        
        files.forEach((content, filepath) => {
          const fileElement = document.createElement('div')
          fileElement.innerHTML = `
            <h3>${filepath}</h3>
            <pre style="background: #f5f5f5; padding: 10px; overflow: auto;">
${content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}
            </pre>
          `
          filesDiv.appendChild(fileElement)
        })
      })
      
      // Connection status
      provider.on('synced', ({ synced }) => {
        console.log('Connection synced:', synced)
      })
    }
  </script>
</body>
</html>
```

## License

MIT
