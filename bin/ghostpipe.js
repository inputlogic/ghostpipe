#!/usr/bin/env node

const args = process.argv.slice(2);

function main() {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log('ghostpipe - CLI tool');
    console.log('\nUsage:');
    console.log('  ghostpipe [options] [command]');
    console.log('\nOptions:');
    console.log('  -h, --help     Show help');
    console.log('  -v, --version  Show version');
    return;
  }

  if (args[0] === '--version' || args[0] === '-v') {
    const { version } = require('../package.json');
    console.log(`ghostpipe v${version}`);
    return;
  }

  console.log('Unknown command:', args[0]);
  console.log('Run "ghostpipe --help" for usage information');
  process.exit(1);
}

main();