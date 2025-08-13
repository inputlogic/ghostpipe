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
ghostpipe --host <url>        # Specify custom host URL
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
  "host": "https://your-host.com",
  "signalingServer": "wss://your-signaling.com",
  "interfaces": [
    {
      "name": "Production",
      "host": "https://prod.example.com",
      "files": ["src/**/*.js", "docs/**/*.md"]
    },
    {
      "name": "Development", 
      "host": "https://dev.example.com"
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
