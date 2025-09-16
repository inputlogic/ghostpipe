# Ghostpipe

Connect files in your codebase to user interfaces

- Apps can only see the files you explicitly share with them
- Your data lives in your codebase and under version control
- No account or installation needed to use a ghostpipe app
- Keep using the dev tools (editor, ai agent) you're used to

## Table of Contents

- [Examples](#examples)
  - [Excalidraw](#excalidraw)
  - [Swagger / OpenAPI](#swagger--openapi)
  - [N8N (Proof of Concept)](#n8n-proof-of-concept)
  - [Config File Support](#config-file-support)
  - [Diff Mode](#diff-mode-1)
- [Quickstart (Excalidraw)](#quickstart-excalidraw)
- [How it works](#how-it-works)
- [Installation](#installation)
- [Usage](#usage)
  - [Basic Usage](#basic-usage)
  - [Configuration-based Usage](#configuration-based-usage)
  - [Diff Mode](#diff-mode)
  - [Configuration](#configuration)
  - [Options](#options)
- [Example Ghostpipe Applications](#example-ghostpipe-applications)
- [Local development](#local-development)
- [What Next?](#what-next)
- [Shout-outs](#shout-outs)
- [License](#license)

## Examples

#### Excalidraw

![Excalidraw Demo](https://raw.githubusercontent.com/inputlogic/ghostpipe/main/demo/excalidraw.gif)

#### Swagger / OpenAPI

![Swagger Demo](https://raw.githubusercontent.com/inputlogic/ghostpipe/main/demo/swagger.gif)

#### N8N (Proof of Concept)

![N8N Demo](https://raw.githubusercontent.com/inputlogic/ghostpipe/main/demo/n8n.gif)

#### Config File Support

![Config Demo](https://raw.githubusercontent.com/inputlogic/ghostpipe/main/demo/config.gif)

#### Diff Mode

![Diff Mode Demo](https://raw.githubusercontent.com/inputlogic/ghostpipe/main/demo/diff.gif)

## Quickstart (Excalidraw)

```bash
npm install -g ghostpipe
```

```bash
ghostpipe https://excalidraw.ghostpipe.dev
```

Open the link and draw something.

## How it works

Ghostpipe uses yjs and webrtc to connect codebase files with applications. Chokidar is used to watch for file changes locally. Connected applications use `pipe` and `signaling` query params to connect to yjs over webrtc and read the file contents.

## Installation

```bash
npm install -g ghostpipe
```

## Usage

### Basic Usage

Connect a file to a web interface:

```bash
ghostpipe [url] [file]
```

Examples:
```bash
ghostpipe https://excalidraw.ghostpipe.dev              # Will prompt for file or create one
ghostpipe https://swagger.ghostpipe.dev api.yml         # Connect api.yml to Swagger interface
```

### Configuration-based Usage

Use interfaces defined in configuration file:

```bash
ghostpipe                     # Uses ghostpipe.config.json or ~/.config/ghostpipe/config.json
ghostpipe --verbose           # Enable verbose logging
```

### Diff Mode

Compare current working directory files with a git branch:

```bash
ghostpipe [url] [file] --diff              # Compare with 'main' branch (default)
ghostpipe [url] [file] --diff develop      # Compare with 'develop' branch
ghostpipe [url] [file] --diff feature-123  # Compare with 'feature-123' branch
```

When diff mode is enabled, the tool will:
- Share your current working directory files
- Also send the base version of each file from the specified git branch
- Allow interfaces to display diffs between the current version and the base branch version
- Only works in git repositories

### Configuration

Create a `ghostpipe.config.json` file in your project root or `~/.config/ghostpipe.json`:

```json
{
  "signalingServer": "wss://signaling.ghostpipe.dev",
  "interfaces": [
    {
      "name": "OpenAPI",
      "host": "https://swagger.ghostpipe.dev",
      "file": "openapi.yml"
    },
    {
      "name": "Excalidraw",
      "host": "https://excalidraw.ghostpipe.dev",
      "file": "excalidraw.txt"
    }
  ]
}
```

### Options

- `--verbose`: Enable detailed logging
- `--diff [branch]`: Base branch for diff comparison (defaults to 'main' if no branch specified)
- `--version`: Show version information
- `--help`: Display help information

## Example Ghostpipe Applications

- [Excalidraw](https://github.com/inputlogic/ghostpipe-excalidraw)
- [Swagger](https://github.com/inputlogic/ghostpipe-swagger)

## Local development

- clone the repo
- `npm install`
- `npm link`
- now you should be able to run `ghostpipe` from any project

## What Next?

Ghostpipe is mostly a proof of concept at this point.
If you're interested in contributing here are some ideas:

- Add ghostpipe support to an existing open source tool (like (hoppscotch)[https://github.com/hoppscotch/hoppscotch] or (drawdb)[https://github.com/drawdb-io/drawdb])
- Add ghostpipe support to your own software
- Contribute to this project (directory support, tests, etc.)

## Shout-outs

Shout out to (Yjs)[https://github.com/yjs/yjs] and (Chokidar)[https://github.com/paulmillr/chokidar], two key ingredients to getting this to work.

## License

MIT
