const path = require(`path`)
const tracer = require(`opentracing`).globalTracer()
const report = require(`gatsby-cli/lib/reporter`)
const loadPlugins = require(`../bootstrap/load-plugins`)
const apiRunner = require(`../utils/api-runner-node`)
const { store, flags } = require(`../redux`)
const nodeTracking = require(`../db/node-tracking`)
const { getExampleValues } = require(`../schema/data-tree-utils`)
const nodesDb = require(`../db/nodes`)
const createContentDigest = require(`../utils/create-content-digest`)
require(`../db`).startAutosave()

function hasExampleValueChanged(type) {
  const nodes = nodesDb.getNodesByType(type)
  const exampleValue = getExampleValues({
    nodes,
    typeName: type,
  })
  const newHash = createContentDigest(exampleValue)
  const oldHash = store.getState().depGraph.exampleValues[type]
  return oldHash != newHash
}

async function shouldRunSchema() {
  const flaggedTypes = Object.keys(flags.nodeTypeCollections)
  console.log(`flagged types`, flaggedTypes)
  const changedTypes = flaggedTypes.filter(hasExampleValueChanged)
  console.log(`changed types`, changedTypes)
  return changedTypes > 0
}

async function initLoki({ cacheDirectory }) {
  const loki = require(`../db/loki`)
  const dbSaveFile = `${cacheDirectory}/loki/loki.db`
  try {
    await loki.start({
      saveFile: dbSaveFile,
    })
  } catch (e) {
    report.error(
      `Error starting DB. Perhaps try deleting ${path.dirname(dbSaveFile)}`
    )
  }
}

async function sourceNodes() {
  await apiRunner(`sourceNodes`, {
    traceId: `initial-sourceNodes`,
    waitForCascadingActions: true,
  })
}

async function build({ parentSpan }) {
  console.log(`INCREMENTAL`)
  const spanArgs = parentSpan ? { childOf: parentSpan } : {}
  const bootstrapSpan = tracer.startSpan(`bootstrap`, spanArgs)
  const config = store.getState().config
  const { directory } = config
  const cacheDirectory = `${directory}/.cache`
  let activity
  console.log(store.getState().depGraph)

  // Start plugin runner which listens to the store
  // and invokes Gatsby API based on actions.
  require(`../redux/plugin-runner`)

  activity = report.activityTimer(`load plugins`)
  activity.start()
  await loadPlugins(config)
  activity.end()

  // onPreInit
  activity = report.activityTimer(`onPreInit`, {
    parentSpan: bootstrapSpan,
  })
  activity.start()
  await apiRunner(`onPreInit`, { parentSpan: activity.span })
  activity.end()

  if (process.env.GATSBY_DB_NODES === `loki`) {
    activity = report.activityTimer(`start nodes db`, {
      parentSpan: bootstrapSpan,
    })
    activity.start()
    initLoki({ cacheDirectory })
    activity.end()
  }

  // By now, our nodes database has been loaded, so ensure that we
  // have tracked all inline objects
  nodeTracking.trackDbNodes()

  // Source nodes
  activity = report.activityTimer(`source and transform nodes`, {
    parentSpan: bootstrapSpan,
  })
  activity.start()
  await sourceNodes()
  activity.end()

  // Create Schema.
  activity = report.activityTimer(`building schema`, {
    parentSpan: bootstrapSpan,
  })
  activity.start()
  if (shouldRunSchema()) {
    await require(`../schema`).build({ parentSpan: activity.span })
  }
  activity.end()
}

module.exports = build
