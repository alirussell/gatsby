// Worker resolvers are resolvers that perform their work in forked
// processes rather than in the main Gatsby process.
//
// Most Gatsby field resolvers simply return a property of a parent
// object, but resolvers defined by plugins via the
// `setFieldsOnGraphQLNodeType` often perform large amounts of CPU
// processing. E.g `gatsby-transformer-remark`. This module runs those
// resolvers on child processes.
//
// The worker-pool is implemented by `jest-worker` which works by
// creating a pool of node.js processes that load a given module. It
// then creates an API that mimics the module's exports. Calls to that
// API will result in IPC messages being sent to the child process and
// calling the same API.
//
// To declare that a field's resolver should be run on a worker, call
// `defineResolver` with the field definition. The field should
// include a `workerPlugin` property that defines the plugin name
// where `setFieldsOnGraphQLNodeType` is defined.
//
// After fields are declared, `initPool()` will create the worker
// pool, passing the field resolver information via the `setupArgs`
// option. jest-worker will then call the worker
// (./resolver-worker.js) `setup` method, which will load the plugin's
// `gatsby-node.js` and call the `setFieldsOnGraphQLNodeType` API. The
// resolver functions are now ready to be called in each worker.
//
// One other thing to note is that the APIs provided to
// `setFieldsOnGraphQLNodeType` are all replaced by RPC versions in
// ./resolver-worker.js. So a call like `getNode()` that would
// normally be run in memory on the main process, is instead backed by
// an async RPC call over IPC from the child to the parent process.

const invariant = require(`invariant`)
const Worker = require(`@moocar/jest-worker`).default
const { store } = require(`../../redux`)
const nodesAPI = require(`../../db/nodes`)
const reporter = require(`gatsby-cli/lib/reporter`)

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
    exposedMethods: [`exec`],
  }
  const workerFile = require.resolve(`./child.js`)
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
  pool.end()
  pool = undefined
}

async function exec(sourceFile, fnName, context, ...args) {
  try {
    return await pool.exec(sourceFile, fnName, context, ...args)
  } catch (err) {
    reporter.panicOnBuild(err)
    return null // Never reached. for linter
  }
}

module.exports = {
  initPool,
  endPool,
  exec,
}
