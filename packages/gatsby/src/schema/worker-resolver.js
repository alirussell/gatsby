const _ = require(`lodash`)
const { store } = require(`../redux`)
const reporter = require(`gatsby-cli/lib/reporter`)
const Worker = require(`@moocar/jest-worker`).default
const invariant = require(`invariant`)
const nodesAPI = require(`../db/nodes`)

// From jest-worker library `src/types.js`
const JEST_WORKER_PARENT_MESSAGE_IPC = 3

// The jest-worker pool of workers. Should be initialized via `initPool()`
let pool

/**
 * Handler for IPC `reporter` calls from workers. These are simply
 * called on this processes `reporter` instance, without responding
 * back to the worker
 */
function reporterHandler({ fnName, args }) {
  reporter[fnName].apply(null, args)
}

const rpcMethods = {
  ...nodesAPI,
  reporter: reporterHandler,
}

/**
 * Handler for IPC calls made from the workers back to the main
 * process. The request contains the name of the method it wishes to
 * call, along with args. These are called against `rpcMethods`, and
 * if an `id` was present in the rpc, a response is sent back to the
 * child process, which uses the `id` to reconcile the response with
 * the initial call
 *
 * @param child the child-process that made the IPC call
 * @param request the raw message args sent from the worker.
 */
function ipcCallback(child, request) {
  invariant(request, `Empty IPC request`)
  const [rpc] = request
  invariant(
    rpc,
    `IPC request should be an array with a single element representing the "rpc"`
  )
  const { name, args, id } = rpc
  invariant(name, `RPC should contain the name of the RPC being called`)
  const response = rpcMethods[name].apply(null, args)
  // Only respond if id is present (this means the message was an RPC)
  if (id) {
    const replyMessage = {
      id,
      type: `response`,
      response,
    }
    child.send([JEST_WORKER_PARENT_MESSAGE_IPC, replyMessage])
  }
}

function getSitePrefix() {
  let pathPrefix = ``
  if (store.getState().program.prefixPaths) {
    pathPrefix = store.getState().config.pathPrefix
  }
  return pathPrefix
}

// TODO Optimize send plugin options only once

/**
 * Called by jest-worker before a worker function is invoked to
 * determine which worker to send the task too. See
 * https://github.com/facebook/jest/tree/master/packages/jest-worker
 *
 * In this case, we return the node.id so that the same node is always
 * sent to the same worker, ensuring that worker caches are sharded by
 * node ID.
 */
function computeWorkerKey(method, { node }) {
  invariant(node, `computeWorkerKey: node not present`)
  invariant(node.id, `computeWorkerKey: node has no ID`)
  return node.id
}

/**
 * Creates and returns a jest-worker pool. Each worker will be setup
 * to handle requests for the supplied fields. See
 * `./resolver-worker.js` for how each worker functions.
 */
function makeJestWorkerPool() {
  const pathPrefix = getSitePrefix()
  const setupArgs = [{ pathPrefix }]
  const workerOptions = {
    ipcCallback,
    forkOptions: {
      silent: false,
    },
    setupArgs,
    exposedMethods: [`execResolver`],
    computeWorkerKey,
  }
  const workerFile = require.resolve(`./resolver-worker.js`)
  return new Worker(workerFile, workerOptions)
}

/**
 * Initializes a pool of jest-workers which will handle resolver calls
 * for the `fields` array at the top of this file
 */
function initPool() {
  pool = makeJestWorkerPool()
}

function endPool() {
  if (pool) {
    pool.end()
  }
}

// TODO memoize this
/**
 * Given the name of a plugin, returns the plugin object stored in
 * redux
 */
function getPlugin(pluginName) {
  const plugins = store.getState().flattenedPlugins
  return plugins.find(p => p.name === pluginName)
}

/**
 * Executes the resolver, passing it the request. Throws an error if
 * the worker takes longer than `timeout` to respond.
 */
function runRequest(request) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `worker resolver timed out waiting for ${request.type.name}.${
            request.fieldName
          }`
        )
      )
    }, 30000) // TODO should be configurable
    return pool
      .execResolver(request)
      .then(result => {
        clearTimeout(timeout)
        resolve(result)
      })
      .catch(err => {
        clearTimeout(timeout)
        reject(err)
      })
  })
}

function wrap(pluginName, resolver) {
  return async (node, args, context, info) => {
    try {
      if (!pool) {
        initPool()
      }
      const plugin = _.pick(getPlugin(pluginName), [
        `name`,
        `pluginOptions`,
        `resolve`,
      ])

      const { fieldName, parentType } = info
      const type = { name: parentType.name }
      const request = { plugin, type, fieldName, node, args }
      return await runRequest(request)
    } catch (err) {
      reporter.panicOnBuild(err)
      return null // Never reached. for linter
    }
  }
}

const makeWrapper = pluginName => resolver => wrap(pluginName, resolver)

module.exports = {
  wrap,
  makeWrapper,
  initPool,
  endPool,
}
