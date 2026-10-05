const cmd = process.argv[2];
const usage = "usage: linchpin review <case.json> [--offline] [--record] [--out dir] | linchpin demo [--offline] | linchpin doctor";
console.log(usage);
process.exit(cmd ? 1 : 0);
