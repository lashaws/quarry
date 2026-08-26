#!/bin/sh
# Bundle each test through esbuild so tsconfig path aliases resolve, then run on Node.
set -e
status=0
mkdir -p .test-out
for f in test/*.test.ts; do
  name=$(basename "$f" .ts)
  ./node_modules/.bin/esbuild "$f" --bundle --format=esm --platform=node \
    --tsconfig=tsconfig.test.json --log-level=warning --outfile=".test-out/$name.mjs"
  echo "── $name"
  node ".test-out/$name.mjs" || status=1
done
exit $status
