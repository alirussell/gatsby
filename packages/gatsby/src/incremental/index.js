const path = require(`path`)
const tracer = require(`opentracing`).globalTracer()
const report = require(`gatsby-cli/lib/reporter`)
const loadPlugins = require(`../bootstrap/load-plugins`)
const apiRunner = require(`../utils/api-runner-node`)
const { store, emitter } = require(`../redux`)
const nodeTracking = require(`../db/node-tracking`)
require(`../db`).startAutosave()

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
  const program = store.getState().program
  const { directory } = config
  const cacheDirectory = `${directory}/.cache`
  let activity

  // Start plugin runner which listens to the store
  // and invokes Gatsby API based on actions.
  require(`../redux/plugin-runner`)

  activity = report.activityTimer(`load plugins`)
  activity.start()
  const flattenedPlugins = await loadPlugins(config)
  activity.end()

  // onPreInit
  activity = report.activityTimer(`onPreInit`, {
    parentSpan: bootstrapSpan,
  })
  activity.start()
  await apiRunner(`onPreInit`, { parentSpan: activity.span })
  activity.end()

  if (process.env.GATSBY_DB_NODES === `loki`) {
    const loki = require(`../db/loki`)
    // Start the nodes database (in memory loki js with interval disk
    // saves). If data was saved from a previous build, it will be
    // loaded here
    activity = report.activityTimer(`start nodes db`, {
      parentSpan: bootstrapSpan,
    })
    activity.start()
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
    activity.end()
  }

  // By now, our nodes database has been loaded, so ensure that we
  // have tracked all inline objects
  nodeTracking.trackDbNodes()

  await sourceNodes()
}

module.exports = build
