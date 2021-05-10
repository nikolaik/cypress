/* eslint-disable no-console */
const globby = require('globby')
const path = require('path')
const fsExtra = require('fs-extra')
const minimist = require('minimist')
const crypto = require('crypto')
const fs = require('fs')
const stringify = require('fast-json-stable-stringify')
const rootPackageJson = require('../package.json')

const opts = minimist(process.argv.slice(2))

async function circleCache() {
  switch (opts.action) {
    case 'prepare':
      return await prepareCircleCache()
    case 'unpack':
      return await unpackCircleCache()
    case 'cacheKey':
      return await cacheKey()
    default: {
      throw new Error('Expected --action "prepare", "unpack", or "cacheKey"')
    }
  }
}

const BASE_DIR = path.join(__dirname, '..')
const CACHE_DIR = path.join(BASE_DIR, 'globbed_node_modules')
const p = (str) => path.join(BASE_DIR, str)

const workspacePaths = rootPackageJson.workspaces.packages
const packageGlobs = workspacePaths.filter((s) => s.endsWith('/*'))

// Gets the sha of all of the patch-package files we have, so we can use this in the cache key.
// Otherwise, adding/editing a patch will not invalidate the CI cache we have for the yarn install
async function cacheKey() {
  const yarnLocks = [p('yarn.lock')]
  const patchFiles = await globby(p('**/*.patch'), {
    ignore: ['**/node_modules/**', '**/*_node_modules/**'],
  })
  // TODO: base on workspaces or lerna
  const packageJsons = await globby([p('package.json'), ...workspacePaths.map((dir) => p(`${dir}/package.json`))], {
    ignore: ['**/node_modules/**', '**/*_node_modules/**'],
  })

  // Concat the stable stringify of all of the package.json dependencies that make up
  const hashedPackageDeps = packageJsons
  .sort()
  .map((abs) => require(abs))
  .map(({ name, dependencies, devDependencies, peerDependencies }) => {
    return hashString(stringify({ name, dependencies, devDependencies, peerDependencies }))
  })
  .join('')

  const filesToHash = yarnLocks.concat(patchFiles).sort()
  const hashedFiles = await Promise.all(filesToHash.map((p) => hashFile(p)))
  const cacheKeySource = hashedFiles.concat(hashedPackageDeps)
  const cacheKey = hashString(cacheKeySource.join(''))

  // Log to stdout, used by circle to generate cache key
  console.log(cacheKey)
}

// Need to dynamically unpack and re-assemble all of the node_modules directories
// https://discuss.circleci.com/t/dynamic-or-programmatic-caching-of-directories/1455
async function prepareCircleCache() {
  const paths = await globby(
    packageGlobs.map((dir) => p(`${dir}/node_modules`)),
    { onlyDirectories: true }
  )

  await Promise.all(
    paths.map(async (src) => {
      await fsExtra.move(src, src.replace(/(.*?)\/node_modules/, '$1_node_modules').replace(BASE_DIR, CACHE_DIR))
    })
  )

  console.log(`Moved globbed node_modules for ${packageGlobs.join(', ')} to ${CACHE_DIR}`)
}

async function unpackCircleCache() {
  const paths = await globby(p(`globbed_node_modules/*/*`), { onlyDirectories: true })

  await Promise.all(
    paths.map(async (src) => {
      await fsExtra.move(src, src.replace(CACHE_DIR, BASE_DIR).replace(/(.*?)_node_modules/, `$1/node_modules`))
    })
  )

  console.log(`Unpacked globbed node_modules from ${CACHE_DIR} to ${packageGlobs.join(', ')}`)

  await fsExtra.remove(CACHE_DIR)
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1')
    const rs = fs.createReadStream(filePath)

    rs.on('error', reject)
    rs.on('data', (chunk) => {
      hash.update(chunk)
    })

    rs.on('end', () => {
      return resolve(hash.digest('hex'))
    })
  })
}

function hashString(s) {
  return crypto.createHash('sha1').update(s).digest('hex')
}

circleCache()
.then(() => {
  process.exit(0)
})
.catch((e) => {
  console.error(e)
  process.exit(1)
})
