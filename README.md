# Ghostpipe

A CLI tool to connect codebase files to user interfaces.

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

Compare files between git branches:

```bash
ghostpipe diff                    # Compare main/master with current branch
ghostpipe diff feature-branch     # Compare main/master with feature-branch
ghostpipe diff main develop       # Compare main with develop branch
```

### Configuration

Create a `.ghostpipe.json` file in your project root or `~/.config/ghostpipe.json`:

```json
{
  "signalingServer": "wss://your-signaling.com",
  "interfaces": [
    {
      "name": "Coolify",
      "host": "https://coolify-ghostpipe.example.com",
      "files": [".ghostpipe/coolify.yml"]
    },
    {
      "name": "ERD",
      "host": "https://erd-ghostpipe.example.com",
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

## License

MIT
