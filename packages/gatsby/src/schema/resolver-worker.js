const path = require(`path`)
const invariant = require(`invariant`)
const uuidv4 = require(`uuid/v4`)
const Cache = require(`../utils/cache`)
const createContentDigest = require(`../utils/create-content-digest`)
const reporter = require(`gatsby-cli/lib/reporter`)

// From jest-worker library `src/types.js`
const JEST_WORKER_CHILD_MESSAGE_IPC = 3

let setupArgs

// List of all in-flight RPCs. keys are RPC ids, and values are
// objects containing the `time` the RPC was sent, and the `resolve`
// and `reject` callbacks.
const inFlightRpcs = new Map()

/**
 * Handle rpc response by removing the original rpc from in flight
 * rpcs and calling its `resolve` with the response
 */
function handleRpcResponse(rpcResponse) {
  const { id, response } = rpcResponse
  invariant(
    id && response,
    `RPC response should contain the "id" of the original RPC and a "response".`
  )
  const rpc = inFlightRpcs.get(id)
  invariant(rpc, `RPC for id [${id}] not found`)
  // Response for RPC has been received, so remove it from
  // inFlightRpcs.
  // TODO: Periodically expire old in flight RPCs
  inFlightRpcs.delete(id)
  rpc.resolve(response)
}

function handleIpc(ipc) {
  const [rpc] = ipc
  invariant(
    rpc,
    `IPC request should be an array with a single element representing the "rpc"`
  )
  if (rpc.type === `response`) {
    handleRpcResponse(rpc)
  } else {
    throw new Error(`Invalid RPC. Must have "name" or "response"`)
  }
}

function sendRpc({ name, args, resolve, reject }) {
  invariant(name, `rpc name`)
  invariant(resolve, `rpc resolve`)
  invariant(reject, `rpc reject`)
  // Used for randomness. There might be cheaper options
  const id = uuidv4()
  const rpc = { name, args, id }
  inFlightRpcs.set(id, {
    time: new Date(),
    resolve,
    reject,
  })
  process.send([JEST_WORKER_CHILD_MESSAGE_IPC, rpc])
}

function sendAndForget({ name, args }) {
  invariant(name, `rpc name`)
  const message = { name, args }
  process.send([JEST_WORKER_CHILD_MESSAGE_IPC, message])
}

function makeRpc(fnName) {
  return (...args) =>
    new Promise((resolve, reject) => {
      sendRpc({
        name: fnName,
        args,
        resolve,
        reject,
      })
    })
}

// panicOnBuild will send the panic message to the parent process,
// which will terminate, thus killing this and all other workers. All
// other reporter functions operate locally by calling gatsby-cli
// `reporter` directly
function makeReporter() {
  return Object.assign(reporter, {
    panicOnBuild(...args) {
      const msg = {
        name: `reporter`,
        args: { fnName: `panicOnBuild`, args },
      }
      process.send([JEST_WORKER_CHILD_MESSAGE_IPC, msg])
    },
  })
}

/**
 * Called by jest-worker when the worker is created. Setup involves
 * requiring each field's resolver module and storing it in the
 * `fields` global so that they can be found when `execResolver` is
 * called
 */
async function setup(args) {
  setupArgs = args
}

const fieldSets = new Map()

function makeRpcs(o, rpcNames) {
  for (const rpcName of rpcNames) {
    o[rpcName] = makeRpc(rpcName)
  }
  return o
}

function unsupportedFn(name) {
  return () => {
    throw new Error(`API [${name}] is unsupported in parallel resolver`)
  }
}

function makeUnsupportedProps(o, props) {
  for (const prop of props) {
    // Defines prop so that when it's accessed for a `get`, it throws
    // an error instead
    Object.defineProperty(o, prop, { get: unsupportedFn(prop) })
  }
  return o
}

const makeSendAndForget = fnName => (...args) =>
  sendAndForget({ name: fnName, args })

function makeJobsApi() {
  return {
    create: makeSendAndForget(`actions.createJob`),
    set: makeSendAndForget(`actions.setJob`),
    end: makeSendAndForget(`actions.endJob`),
  }
}

/**
 * GraphQL fields are normally created by plugins during the
 * `setFieldsOnGraphQLNodeType` API, and as such they expect API
 * functions such as `getNode()` to be available. But workers operate
 * outside of the main process so can't call these
 * functions. Therefore we supply implementations for these APIs that
 * result in RPC calls back to the main process. This goes for static
 * values such as `type`.
 */
function makeApi({ type, setupArgs, plugin }) {
  const { pathPrefix } = setupArgs
  const cache = new Cache({ name: plugin.name }).init()
  const workerResolver = {
    wrap: (pluginName, resolver) => resolver,
    makeWrapper: pluginName => resolver => resolver,
  }
  const api = {
    cache,
    // Caching story needs more thinking
    getCache: () => cache,
    createContentDigest,
    // TODO pass in plugin.name into worker so this can mimic api-runner-node
    // createNodeId: namespacedCreateNodeId,
    // TODO remember to remove from unsupported
    reporter: makeReporter(),
    jobsApi: makeJobsApi(plugin),
    type,
    pathPrefix,
    workerResolver,
  }
  makeUnsupportedProps(api, [
    `boundActionCreators`,
    `createNodeId`,
    `actions`,
    `store`,
    `emitter`,
    `tracing`,
    `getNodes`,
  ])
  makeRpcs(api, [
    `loadNodeContent`,
    `getNode`,
    `getNodesByType`,
    `hasNodeChanged`,
    `getNodeAndSavePathDependency`,
  ])
  return api
}

async function initFieldSet(setupArgs, { fieldName, plugin, type }) {
  invariant(plugin, `plugin`)
  invariant(plugin.resolve, `plugin.resolve`)
  invariant(plugin.name, `plugin.name`)
  const resolverFile = path.join(plugin.resolve, `gatsby-node.js`)
  const module = require(resolverFile)
  const api = makeApi({ type, setupArgs, plugin })
  return await module.setFieldsOnGraphQLNodeType(api, plugin.pluginOptions)
}

/**
 * main function exported for jest-worker. Takes a typeName and
 * fieldName and finds previously configured resolver for it, then
 * calls it with node and args. The response will be sent back to the
 * main process by jest-worker
 */
async function execResolver(request) {
  const { fieldName, plugin, node, args } = request
  let fieldSet = fieldSets.get(plugin.name)
  if (!fieldSet) {
    fieldSet = await initFieldSet(setupArgs, request)
    fieldSets.set(plugin.name, fieldSet)
  }
  const field = fieldSet[fieldName]
  const resolver = field.resolve
  return await resolver(node, args)
}

process.on(`ipc`, handleIpc)

module.exports = {
  setup,
  execResolver,
}
